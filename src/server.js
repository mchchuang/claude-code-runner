import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, appendFile, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FileSessionStore, loadSessionSecret } from './session-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Data directory and file paths
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_FILE = process.env.AUTH_FILE || path.join(DATA_DIR, 'auth.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

// Session configuration. The secret and the sessions live in DATA_DIR so logins survive restarts and redeploys.
app.use(session({
  secret: loadSessionSecret(path.join(DATA_DIR, 'session-secret')),
  store: new FileSessionStore(path.join(DATA_DIR, 'sessions.json')),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// API Token management
function loadToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
      return data.token || null;
    }
  } catch (e) {
    console.error('Failed to load token:', e.message);
  }
  return null;
}

function saveToken(token) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token, created: new Date().toISOString() }), 'utf-8');
  } catch (e) {
    console.error('Failed to save token:', e.message);
  }
}

function generateToken() {
  return `ccr_${randomUUID().replace(/-/g, '')}`;
}

let currentToken = loadToken();

// Load or initialize auth data
async function loadAuthData() {
  try {
    await access(AUTH_FILE);
    const data = await readFile(AUTH_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveAuthData(data) {
  const dir = path.dirname(AUTH_FILE);
  await mkdir(dir, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(data, null, 2));
}

async function isSetupComplete() {
  const auth = await loadAuthData();
  return auth?.username && auth.passwordHash;
}

// Auth middleware
async function requireAuth(req, res, next) {
  const setupComplete = await isSetupComplete();

  // Allow setup page and setup POST when not configured
  if (!setupComplete) {
    if (req.path === '/setup' || req.path === '/api/setup') {
      return next();
    }
    return res.redirect('/setup');
  }

  // Allow login page and login POST when not authenticated
  if (req.path === '/login' || req.path === '/api/login') {
    return next();
  }

  // Allow health check for external monitoring
  if (req.path === '/health') {
    return next();
  }

  // Check session auth first (for browser users)
  if (req.session?.authenticated) {
    return next();
  }

  // Check Bearer token auth (for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (currentToken && token === currentToken) {
      return next();
    }
  }

  // Not authenticated
  if (req.path.startsWith('/api/') || req.path.startsWith('/task') || req.path.startsWith('/token')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// Apply auth middleware to all routes except static assets
app.use(requireAuth);

const tasks = new Map();
const WORK_DIR = process.env.WORK_DIR || '/tmp/work';
const TASK_TIMEOUT = 60 * 60 * 1000; // 1 hour

// ============ Gitea Integration ============

const GITEA_URL = (process.env.GITEA_URL || '').replace(/\/+$/, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const giteaEnabled = Boolean(GITEA_URL && GITEA_TOKEN);
const REPO_CACHE_TTL = 60 * 1000;
let repoCache = { at: 0, repos: null };

async function giteaFetch(apiPath) {
  const res = await fetch(`${GITEA_URL}/api/v1${apiPath}`, {
    headers: { Authorization: `token ${GITEA_TOKEN}`, Accept: 'application/json' }
  });
  if (!res.ok) {
    const err = new Error(`Gitea API ${apiPath} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toRepoSummary(r) {
  return {
    full_name: r.full_name,
    owner: r.owner?.login,
    name: r.name,
    description: r.description || '',
    private: r.private,
    archived: r.archived,
    default_branch: r.default_branch,
    clone_url: r.clone_url,
    html_url: r.html_url,
    updated_at: r.updated_at
  };
}

// Lists every repo the token's user can access (own, collaborator, org), paginated.
async function listGiteaRepos({ refresh = false } = {}) {
  if (!refresh && repoCache.repos && Date.now() - repoCache.at < REPO_CACHE_TTL) {
    return repoCache.repos;
  }
  const limit = 50;
  const all = [];
  for (let page = 1; page <= 40; page++) {
    const batch = await giteaFetch(`/user/repos?limit=${limit}&page=${page}`);
    all.push(...batch);
    if (batch.length < limit) break;
  }
  const repos = all
    .map(toRepoSummary)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  repoCache = { at: Date.now(), repos };
  return repos;
}

async function getGiteaRepo(fullName) {
  const [owner, name, ...rest] = String(fullName).split('/');
  if (!owner || !name || rest.length) throw new Error('repo must be in owner/name form');
  return toRepoSummary(await giteaFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`));
}

// Auto-detect mode: find which Gitea repo the orchestrator cloned, from its origin URL.
async function resolveGiteaRepoFromClone(repoDir) {
  const origin = await new Promise((resolve, reject) =>
    execFile('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], (err, out) => err ? reject(err) : resolve(out.trim())));
  const strip = u => u.replace(/\.git$/, '').replace(/\/+$/, '');
  const fullName = strip(new URL(origin).pathname).split('/').filter(Boolean).slice(-2).join('/');
  const repo = await getGiteaRepo(fullName);
  // Same owner/name could exist elsewhere (e.g. GitHub upstream) - only accept a matching clone URL
  if (strip(repo.clone_url) !== strip(origin) && !strip(origin).startsWith(`${GITEA_URL}/`)) {
    throw new Error(`origin ${origin} is not ${repo.full_name} on Gitea`);
  }
  return repo;
}

// Configure git so clones/pushes to Gitea authenticate with GITEA_TOKEN
// (reads the token from the environment at call time, never written to disk).
if (giteaEnabled) {
  execFile('git', [
    'config', '--global',
    `credential.${GITEA_URL}.helper`,
    '!f() { echo "username=oauth2"; echo "password=$GITEA_TOKEN"; }; f'
  ], err => {
    if (err) console.error('Failed to configure Gitea git credentials:', err.message);
    else console.log(`Gitea integration enabled for ${GITEA_URL}`);
  });
}

// ============ Auth Routes ============

// Setup page (first-time configuration)
app.get('/setup', async (_req, res) => {
  if (await isSetupComplete()) {
    return res.redirect('/login');
  }
  const html = await readFile(path.join(__dirname, 'setup.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Setup API
app.post('/api/setup', async (req, res) => {
  if (await isSetupComplete()) {
    return res.status(400).json({ error: 'Setup already complete' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await saveAuthData({ username, passwordHash });

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true });
});

// Login page
app.get('/login', async (req, res) => {
  if (!(await isSetupComplete())) {
    return res.redirect('/setup');
  }
  if (req.session?.authenticated) {
    return res.redirect('/');
  }
  const html = await readFile(path.join(__dirname, 'login.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Login API
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const auth = await loadAuthData();
  if (!auth) {
    return res.status(400).json({ error: 'Setup not complete' });
  }

  if (username.toLowerCase() !== auth.username.toLowerCase()) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, auth.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Get current user info
app.get('/api/me', (req, res) => {
  if (req.session?.authenticated) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// ============ API Token Management ============

// Generate new API token
app.post('/token/generate', (_req, res) => {
  const token = generateToken();
  currentToken = token;
  saveToken(token);
  res.json({ token }); // Full token returned only on generation
});

// Get token status (masked)
app.get('/token', (_req, res) => {
  if (!currentToken) {
    return res.json({ exists: false });
  }
  // Return masked token: ccr_a1b2...x9z0
  const masked = `${currentToken.slice(0, 8)}...${currentToken.slice(-4)}`;
  res.json({ exists: true, masked });
});

// Revoke token
app.delete('/token', (_req, res) => {
  currentToken = null;
  try {
    if (existsSync(TOKEN_FILE)) {
      writeFileSync(TOKEN_FILE, JSON.stringify({ token: null }), 'utf-8');
    }
  } catch (e) {
    console.error('Failed to revoke token:', e.message);
  }
  res.json({ ok: true });
});

// ============ System Prompts ============

function getPrInstructions(repo, branchName) {
  if (repo) {
    return `3. Open a pull request on Gitea (repo ${repo.full_name}, base branch ${repo.default_branch}):
   curl -sf -X POST "$GITEA_URL/api/v1/repos/${repo.full_name}/pulls" -H "Authorization: token $GITEA_TOKEN" -H "Content-Type: application/json" -d '{"title":"<task summary>","body":"<description of changes>","head":"${branchName}","base":"${repo.default_branch}"}' | jq -r .html_url
   Build the JSON body with jq if the text contains quotes or newlines. Print the resulting PR URL.`;
  }
  return `3. gh pr create --title "<task summary>" --body "<description of changes>"`;
}

function getWorkerSystemPrompt(branchName, repo) {
  return `
# Autonomous Worker Mode

You are running autonomously. No human in the loop.

## Git Setup
You are on branch ${branchName}. It's already pushed to origin.

## Rules
- NEVER use AskUserQuestion - you will hang forever
- NEVER exit without pushing your commits
- Make reasonable assumptions, document them in commits
- NEVER commit dependencies or build output (node_modules, venv, dist, etc.) - if the repo has no .gitignore covering them, add one before committing

## Context Management
Your context window is precious. DO NOT run more than 3-4 search commands yourself.
- Use Task tool with subagent_type=Explore for any codebase exploration
- Use Task tool for self-contained subtasks
- Keep main thread for coordination and git operations

## Git Workflow
Commit as a software engineer would - logical chunks of work, meaningful messages.
The only hard rule: ALWAYS push before you exit. Your work is lost if it's not pushed.

## FINAL STEP (MANDATORY)
Before exiting, you MUST run these commands:
1. git add -A && git commit -m "<summary of changes>" (if any uncommitted changes)
2. git push
${getPrInstructions(repo, branchName)}

If blocked or failed: still push and create PR, note what went wrong in the PR body.
`.trim();
}

function getOrchestratorPrompt(prompt, workDir, branchName, repo) {
  if (repo) {
    return `
You are an orchestrator. Your job is to clone a known repo, set up the environment,
and create and push a feature branch.

The target repository has already been selected: ${repo.full_name} (Gitea)
Clone URL: ${repo.clone_url}
Git credentials for ${GITEA_URL} are already configured - do not change git credential settings.

Workflow:
1. git clone ${repo.clone_url} ${workDir}/repo
2. Examine the repo to identify required tools (check README, config files, lock files)
3. Check what tools are already available, install anything missing
4. Run dependency installation (npm install, pip install, go mod download, etc.)
5. Create and push the feature branch:
   git checkout -b ${branchName}
   git commit --allow-empty -m "chore: start task"
   git push -u origin HEAD
6. Exit successfully

Do NOT start working on the actual task - just prepare the environment.

User request (for context only): ${prompt}
`.trim();
  }
  return `
You are an orchestrator. Your job is to:
1. Figure out which repo the user is asking about
2. Clone it and set up the environment
3. Create and push a feature branch

Workflow:
${giteaEnabled ? `1. Git credentials for ${GITEA_URL} are already configured - do not change git credential settings.
2. List repos via the Gitea API and identify the right one from the user's prompt:
   curl -sf "$GITEA_URL/api/v1/user/repos?limit=50" -H "Authorization: token $GITEA_TOKEN" | jq -r '.[] | [.full_name, .clone_url, .description] | @tsv'
   (add &page=2 etc. if 50 are returned)
3. Clone the HTTPS clone_url to ${workDir}/repo` : `1. Configure git to use the GitHub token:
   git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
2. Use gh CLI to list repos and identify the right one from the user's prompt
3. Clone to ${workDir}/repo`}
4. Examine the repo to identify required tools (check README, config files, lock files)
5. Check what tools are already available, install anything missing
6. Run dependency installation (npm install, pip install, go mod download, etc.)
7. Create and push the feature branch:
   git checkout -b ${branchName}
   git commit --allow-empty -m "chore: start task"
   git push -u origin HEAD
8. Exit successfully

Do NOT start working on the actual task - just prepare the environment.

User request: ${prompt}
`.trim();
}


app.post('/task', async (req, res) => {
  const { prompt, repo: repoName } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  let repo = null;
  if (repoName) {
    if (!giteaEnabled) {
      return res.status(400).json({ error: 'repo selection requires GITEA_URL and GITEA_TOKEN' });
    }
    try {
      repo = await getGiteaRepo(repoName);
    } catch (err) {
      const status = err.status === 404 ? 404 : 400;
      return res.status(status).json({ error: `Unknown repo ${repoName}: ${err.message}` });
    }
  }

  const id = randomUUID().slice(0, 8);
  const taskDir = path.join(WORK_DIR, id);

  await mkdir(taskDir, { recursive: true });

  tasks.set(id, {
    status: 'running',
    prompt,
    repo: repo?.full_name || null,
    repo_url: repo?.html_url || null,
    started: new Date().toISOString(),
    logFile: path.join(taskDir, 'output.log')
  });

  runTask(id, prompt, taskDir, repo).catch(err => {
    tasks.set(id, {
      ...tasks.get(id),
      status: 'failed',
      error: err.message,
      errorType: err.errorType || 'unknown',
      finished: new Date().toISOString()
    });
  });

  res.json({ id, status: 'queued' });
});

app.get('/task/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json({ id: req.params.id, ...task });
});

app.get('/task/:id/logs', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  res.setHeader('Content-Type', 'text/plain');
  createReadStream(task.logFile).pipe(res);
});

// List Gitea repos available for task submission
app.get('/api/repos', async (req, res) => {
  if (!giteaEnabled) {
    return res.json({ enabled: false, repos: [] });
  }
  try {
    const repos = await listGiteaRepos({ refresh: req.query.refresh === '1' });
    res.json({ enabled: true, url: GITEA_URL, repos });
  } catch (err) {
    console.error('Failed to list Gitea repos:', err.message);
    res.status(502).json({ enabled: true, error: err.message, repos: [] });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tasks: tasks.size,
    running: [...tasks.values()].filter(t => t.status === 'running').length
  });
});

// List all tasks
app.get('/tasks', (_req, res) => {
  const taskList = [...tasks.entries()].map(([id, task]) => ({
    id,
    ...task
  }));
  taskList.sort((a, b) => new Date(b.started) - new Date(a.started));
  res.json(taskList);
});

// Dashboard UI
app.get('/', async (_req, res) => {
  const html = await readFile(path.join(__dirname, 'dashboard.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

async function runTask(id, prompt, taskDir, repo) {
  const logFile = path.join(taskDir, 'output.log');
  const repoDir = path.join(taskDir, 'repo');
  const branchName = `claude/${id}`;

  await appendFile(logFile, `=== Task started: ${new Date().toISOString()} ===\n`);
  await appendFile(logFile, `ID: ${id}\n`);
  if (repo) await appendFile(logFile, `Repo: ${repo.full_name}\n`);
  await appendFile(logFile, `Prompt: ${prompt}\n\n`);

  // Phase 1: Orchestrator - identify and clone repo
  await appendFile(logFile, `\n=== ORCHESTRATOR PHASE ===\n`);
  await runOrchestrator(id, prompt, taskDir, branchName, logFile, repo);
  await appendFile(logFile, `\n=== ORCHESTRATOR COMPLETE ===\n\n`);

  if (!repo && giteaEnabled) {
    try {
      repo = await resolveGiteaRepoFromClone(repoDir);
      tasks.set(id, { ...tasks.get(id), repo: repo.full_name, repo_url: repo.html_url });
      await appendFile(logFile, `Repo (auto-detected): ${repo.full_name}\n\n`);
    } catch (err) {
      // Not a Gitea clone: worker falls back to the GitHub PR flow
      await appendFile(logFile, `Could not resolve Gitea repo from clone: ${err.message}\n\n`);
    }
  }

  // Phase 2: Worker - run in cloned repo
  await appendFile(logFile, `=== WORKER PHASE ===\n`);
  const result = await runWorker(id, prompt, repoDir, branchName, logFile, repo);
  await appendFile(logFile, `\n=== WORKER COMPLETE ===\n`);

  return result;
}

async function runOrchestrator(id, prompt, taskDir, branchName, logFile, repo) {
  const logStream = createWriteStream(logFile, { flags: 'a' });
  const fullPrompt = getOrchestratorPrompt(prompt, taskDir, branchName, repo);

  return new Promise((resolve, reject) => {
    const proc = pty.spawn('claude', [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: taskDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Orchestrator timed out');
      err.errorType = 'timeout';
      reject(err);
    }, 20 * 60 * 1000); // 20 min timeout for orchestrator (includes env setup)

    console.log(`[${id}] Orchestrator PTY spawned, pid: ${proc.pid}`);

    proc.onData(data => logStream.write(data));

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      logStream.end();

      if (exitCode !== 0) {
        return reject(Object.assign(new Error(`Orchestrator exited with code ${exitCode}`), { errorType: 'exit_code' }));
      }

      console.log(`[${id}] Orchestrator completed successfully`);
      resolve();
    });
  });
}

async function runWorker(id, prompt, repoDir, branchName, logFile, repo) {
  const logStream = createWriteStream(logFile, { flags: 'a' });
  const systemPrompt = getWorkerSystemPrompt(branchName, repo);

  return new Promise((resolve, reject) => {
    const proc = pty.spawn('claude', [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: repoDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Worker timed out after 1 hour');
      err.errorType = 'timeout';
      reject(err);
    }, TASK_TIMEOUT);

    let output = '';

    console.log(`[${id}] Worker PTY spawned in ${repoDir}, pid: ${proc.pid}`);

    proc.onData(data => {
      output += data;
      logStream.write(data);
    });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      logStream.end();

      // Parse PR URL from worker output (Gitea uses /pulls/N, GitHub uses /pull/N)
      // Gitea builds html_url from its ROOT_URL, which can differ from GITEA_URL, so anchor on the repo's own URL
      const prPattern = repo
        ? new RegExp(`${escapeRegExp(repo.html_url.replace(/\/+$/, ''))}/pulls/\\d+`, 'g')
        : /https:\/\/github\.com\/[^\s"'\\]+\/pull\/\d+/g;
      // Prefer the last PR URL printed
      const prUrls = output.match(prPattern) || [];
      const prMatch = prUrls.length ? [prUrls[prUrls.length - 1]] : null;

      const task = tasks.get(id);
      tasks.set(id, {
        ...task,
        status: exitCode === 0 ? 'completed' : 'failed',
        pr_url: prMatch?.[0] || null,
        errorType: exitCode === 0 ? null : 'exit_code',
        finished: new Date().toISOString()
      });

      // Cleanup cloned repo on success (keep logs)
      if (exitCode === 0) {
        await rm(repoDir, { recursive: true, force: true }).catch(() => {});
      }

      // errorType on the error too: runTask's catch overwrites the task with it
      exitCode === 0 ? resolve() : reject(Object.assign(new Error(`Worker exited with code ${exitCode}`), { errorType: 'exit_code' }));
    });
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Claude Runner listening on :${PORT}`));
