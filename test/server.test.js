// Integration tests: run the real server against a mock Gitea API and a fake `claude` CLI (test/fixtures).
// Linux/macOS only (node-pty and the shell wrapper); CI runs them in Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const GITEA_TOKEN = 'test-gitea-token';

const freePort = () => new Promise(resolve => {
  const srv = net.createServer().listen(0, () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// ---------- Mock Gitea ----------

// Each repo also exists as a bare git repo in gitDir, which runners reach through git's url.insteadOf (startRunner)
function mockGitea() {
  const gitDir = mkdtempSync(path.join(os.tmpdir(), 'ccr-git-'));
  // The repos the tests clone; others are listed by the API but have no git repo (a failing clone)
  for (let i = 0; i < 10; i++) execFileSync('git', ['init', '-q', '--bare', path.join(gitDir, 'martin', `repo-${i}.git`)]);
  const state = { failRepoList: false, failRepoGet: false, repoListCalls: 0 };
  const repo = (owner, name, i) => ({
    full_name: `${owner}/${name}`, name, owner: { login: owner },
    description: i % 2 ? `repo ${i}` : null, private: i % 3 === 0, archived: false, default_branch: 'main',
    updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
  });
  // 60 repos: more than one page of 50, so pagination is exercised
  const repos = Array.from({ length: 60 }, (_, i) => repo(i < 55 ? 'martin' : 'org', `repo-${i}`, i));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = `http://127.0.0.1:${server.address().port}`;
    const withUrls = r => ({ ...r, clone_url: `${base}/${r.full_name}.git`, html_url: `${base}/${r.full_name}` });
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `token ${GITEA_TOKEN}`) return json(401, { message: 'token required' });

    if (url.pathname === '/api/v1/user/repos') {
      state.repoListCalls++;
      if (state.failRepoList) return json(500, { message: 'boom' });
      const limit = Number(url.searchParams.get('limit'));
      const page = Number(url.searchParams.get('page'));
      return json(200, repos.slice((page - 1) * limit, page * limit).map(withUrls));
    }
    const m = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/);
    if (m) {
      if (state.failRepoGet) return json(500, { message: 'boom' });
      const found = repos.find(r => r.full_name === `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
      return found ? json(200, withUrls(found)) : json(404, { message: 'not found' });
    }
    json(404, { message: 'no route' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, state, gitDir, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---------- Server under test ----------

// `tmp` reuses an earlier runner's directory (data, work dir), as a redeploy reuses the /data volume.
// `gitea` (a mockGitea) points git at its bare repos, so the server's own clone and push work.
async function startRunner(env = {}, { tmp = mkdtempSync(path.join(os.tmpdir(), 'ccr-test-')), gitea } = {}) {
  const port = await freePort();
  writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n' +
    (gitea ? `[url "file://${gitea.gitDir}/"]\n\tinsteadOf = ${gitea.url}/\n` : ''));
  const proc = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    env: {
      PATH: `${fixtures}${path.delimiter}${process.env.PATH}`,
      HOME: tmp,
      GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), // the server sets a credential helper in global git config
      PORT: String(port),
      DATA_DIR: path.join(tmp, 'data'),
      WORK_DIR: path.join(tmp, 'work'),
      SESSION_SECRET: 'test-secret',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (i > 100 || proc.exitCode !== null) throw new Error(`server did not start:\n${output}`);
    await new Promise(r => setTimeout(r, 50));
  }

  let cookie = '';
  const request = async (method, url, { body, headers = {}, auth = true } = {}) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && auth) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, location: res.headers.get('location'), text, json };
  };
  const exited = new Promise(resolve => proc.once('exit', resolve));
  // kill() stops the server but keeps its directory, for restarting on it; stop() also removes the directory.
  const kill = async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); await exited; };
  const stop = () => { proc.kill(); rmSync(tmp, { recursive: true, force: true }); };
  return {
    request, stop, kill, tmp,
    getCookie: () => cookie, setCookie: c => { cookie = c; }, workDir: path.join(tmp, 'work'), dataDir: path.join(tmp, 'data'), output: () => output
  };
}

async function setUp(runner) {
  const res = await runner.request('POST', '/api/setup', { body: { username: 'martin', password: 'correct horse' } });
  assert.equal(res.status, 200, res.text);
}

// The init events of the claude runs in a task log (the fake CLI echoes its arguments in them)
const initEvents = log => log.split('\n').map(l => l.trim()).filter(l => l.startsWith('{"type":"system","subtype":"init"')).map(l => JSON.parse(l));

async function waitForTask(runner, id) {
  for (let i = 0; i < 200; i++) {
    const { json } = await runner.request('GET', `/task/${id}`);
    if (json.status !== 'running') return json;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`task ${id} still running:\n${runner.output()}`);
}

// ---------- Tests ----------

describe('first-time setup and login', () => {
  let runner;
  before(async () => { runner = await startRunner(); });
  after(() => runner.stop());

  test('everything redirects to setup until an account exists', async () => {
    for (const url of ['/', '/login', '/tasks']) {
      const res = await runner.request('GET', url);
      assert.equal(res.status, 302, url);
      assert.equal(res.location, '/setup', url);
    }
  });

  test('setup validates the username and password', async () => {
    const cases = [
      [{}, 'Username and password required'],
      [{ username: 'ab', password: 'long enough' }, 'Username must be at least 3 characters'],
      [{ username: 'martin', password: 'short' }, 'Password must be at least 8 characters']
    ];
    for (const [body, error] of cases) {
      const res = await runner.request('POST', '/api/setup', { body, auth: false });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, error);
    }
  });

  test('setup signs in, and can only run once', async () => {
    await setUp(runner);
    assert.equal((await runner.request('GET', '/api/me')).json.username, 'martin');
    const body = { username: 'other', password: 'password123' };
    // Anonymous requests can't reach setup once an account exists
    assert.equal((await runner.request('POST', '/api/setup', { body, auth: false })).status, 401);
    const again = await runner.request('POST', '/api/setup', { body });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, 'Setup already complete');
    const login = await runner.request('POST', '/api/login', { body: { username: 'other', password: 'password123' }, auth: false });
    assert.equal(login.status, 401, 'the original account was not replaced');
  });

  test('login rejects a wrong password and accepts the right one, case-insensitive username', async () => {
    const wrong = await runner.request('POST', '/api/login', { body: { username: 'martin', password: 'nope nope' }, auth: false });
    assert.equal(wrong.status, 401);
    const missing = await runner.request('POST', '/api/login', { body: { username: 'martin' }, auth: false });
    assert.equal(missing.status, 400);
    const ok = await runner.request('POST', '/api/login', { body: { username: 'MARTIN', password: 'correct horse' }, auth: false });
    assert.equal(ok.status, 200);
  });

  test('logout ends the session', async () => {
    assert.equal((await runner.request('POST', '/api/logout')).status, 200);
    assert.equal((await runner.request('GET', '/api/me')).status, 401);
  });
});

describe('sessions across restarts', () => {
  let runner;
  after(() => runner.stop());

  test('a login survives a restart on the same data dir, without SESSION_SECRET set', async () => {
    runner = await startRunner({ SESSION_SECRET: '' });
    await setUp(runner);
    const cookie = runner.getCookie();
    assert.ok(cookie, 'setup set a session cookie');
    assert.ok(existsSync(path.join(runner.dataDir, 'session-secret')), 'the generated secret was saved');
    assert.ok(existsSync(path.join(runner.dataDir, 'sessions.json')), 'the session was saved');

    // Redeploy: new process, same volume
    await runner.kill();
    runner = await startRunner({ SESSION_SECRET: '' }, { tmp: runner.tmp });
    runner.setCookie(cookie);
    const me = await runner.request('GET', '/api/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.username, 'martin');
  });

  test('logging out before a restart keeps the session ended after it', async () => {
    const cookie = runner.getCookie();
    assert.equal((await runner.request('POST', '/api/logout')).status, 200);
    await runner.kill();
    runner = await startRunner({ SESSION_SECRET: '' }, { tmp: runner.tmp });
    runner.setCookie(cookie);
    assert.equal((await runner.request('GET', '/api/me')).status, 401);
  });

  test('a changed SESSION_SECRET invalidates existing cookies', async () => {
    assert.equal((await runner.request('POST', '/api/login', { body: { username: 'martin', password: 'correct horse' } })).status, 200);
    const cookie = runner.getCookie();
    await runner.kill();
    runner = await startRunner({ SESSION_SECRET: 'a-different-secret' }, { tmp: runner.tmp });
    runner.setCookie(cookie);
    assert.equal((await runner.request('GET', '/api/me')).status, 401);
  });
});

describe('API tokens', () => {
  let runner;
  before(async () => { runner = await startRunner(); await setUp(runner); });
  after(() => runner.stop());

  test('token endpoints reject unauthenticated requests', async () => {
    // Regression: these used to skip auth, letting anyone mint or revoke the API token
    for (const [method, url] of [['GET', '/token'], ['POST', '/token/generate'], ['DELETE', '/token']]) {
      const res = await runner.request(method, url, { auth: false });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    assert.equal((await runner.request('GET', '/token')).json.exists, false, 'unauthenticated calls changed nothing');
  });

  test('a generated token works as a Bearer token, is shown masked and saved, and can be revoked', async () => {
    const { json } = await runner.request('POST', '/token/generate');
    assert.match(json.token, /^ccr_[0-9a-f]{32}$/);
    const bearer = { Authorization: `Bearer ${json.token}` };

    const status = await runner.request('GET', '/token');
    assert.deepEqual(status.json, { exists: true, masked: `${json.token.slice(0, 8)}...${json.token.slice(-4)}` });
    assert.equal((await runner.request('GET', '/tasks', { auth: false, headers: bearer })).status, 200);
    assert.equal((await runner.request('GET', '/tasks', { auth: false, headers: { Authorization: 'Bearer ccr_wrong' } })).status, 401);
    assert.ok(readFileSync(path.join(runner.dataDir, 'token.json'), 'utf8').includes(json.token), 'persisted');

    assert.equal((await runner.request('DELETE', '/token')).status, 200);
    assert.equal((await runner.request('GET', '/tasks', { auth: false, headers: bearer })).status, 401);
  });

  test('a new token replaces the old one', async () => {
    const first = (await runner.request('POST', '/token/generate')).json.token;
    const second = (await runner.request('POST', '/token/generate')).json.token;
    assert.notEqual(first, second);
    assert.equal((await runner.request('GET', '/tasks', { auth: false, headers: { Authorization: `Bearer ${first}` } })).status, 401);
    assert.equal((await runner.request('GET', '/tasks', { auth: false, headers: { Authorization: `Bearer ${second}` } })).status, 200);
  });
});

describe('without Gitea configured', () => {
  let runner;
  before(async () => { runner = await startRunner(); await setUp(runner); });
  after(() => runner.stop());

  test('repo listing reports Gitea as disabled', async () => {
    assert.deepEqual((await runner.request('GET', '/api/repos')).json, { enabled: false, repos: [] });
  });

  test('rejects a malformed model', async () => {
    for (const model of ['a b', '--x; rm', 5, 'x'.repeat(65)]) {
      const res = await runner.request('POST', '/task', { body: { prompt: 'x', model } });
      assert.equal(res.status, 400, String(model));
      assert.match(res.json.error, /invalid model/);
    }
  });

  test('a task needs a prompt, and picking a repo needs Gitea', async () => {
    assert.equal((await runner.request('POST', '/task', { body: {} })).status, 400);
    assert.equal((await runner.request('POST', '/task', { body: { prompt: '' } })).status, 400);
    const res = await runner.request('POST', '/task', { body: { prompt: 'x', repo: 'martin/repo-1' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /requires GITEA_URL/);
  });

  test('unknown tasks are 404s', async () => {
    assert.equal((await runner.request('GET', '/task/nope')).status, 404);
    assert.equal((await runner.request('GET', '/task/nope/logs')).status, 404);
    assert.equal((await runner.request('PATCH', '/task/nope', { body: { archived: true } })).status, 404);
    assert.equal((await runner.request('DELETE', '/task/nope')).status, 404);
  });
});

describe('with Gitea', () => {
  let runner;
  let gitea;
  before(async () => {
    gitea = await mockGitea();
    runner = await startRunner({ GITEA_URL: `${gitea.url}/`, GITEA_TOKEN, FAKE_AUTO_CLONE_URL: `${gitea.url}/org/repo-57.git`, MAX_BUDGET_USD: '2.5' }, { gitea });
    await setUp(runner);
  });
  after(() => { runner.stop(); gitea.server.close(); rmSync(gitea.gitDir, { recursive: true, force: true }); });

  test('lists every repo across pages, most recently updated first, and caches the list', async () => {
    const { json } = await runner.request('GET', '/api/repos');
    assert.equal(json.enabled, true);
    assert.equal(json.url, gitea.url, 'trailing slash trimmed');
    assert.equal(json.repos.length, 60);
    assert.equal(json.repos[0].full_name, 'org/repo-59');
    assert.equal(json.repos.at(-1).full_name, 'martin/repo-0');
    assert.equal(json.repos[0].description, 'repo 59');
    assert.equal(json.repos[0].owner, 'org');

    const calls = gitea.state.repoListCalls;
    await runner.request('GET', '/api/repos');
    assert.equal(gitea.state.repoListCalls, calls, 'served from cache');
    await runner.request('GET', '/api/repos?refresh=1');
    assert.equal(gitea.state.repoListCalls, calls + 2, 'refresh refetches both pages');
  });

  test('a Gitea failure is reported as a 502', async () => {
    gitea.state.failRepoList = true;
    try {
      const res = await runner.request('GET', '/api/repos?refresh=1');
      assert.equal(res.status, 502);
      assert.match(res.json.error, /500/);
    } finally {
      gitea.state.failRepoList = false;
    }
  });

  test('picking a repo that does not exist is rejected', async () => {
    for (const repo of ['martin/missing', 'not-a-full-name', 'a/b/c']) {
      const res = await runner.request('POST', '/task', { body: { prompt: 'x', repo } });
      assert.ok([400, 404].includes(res.status), `${repo}: ${res.status}`);
    }
    assert.equal((await runner.request('POST', '/task', { body: { prompt: 'x', repo: 'martin/missing' } })).status, 404);
  });

  test('a task on a picked repo is set up with plain git, then the worker records the PR', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'Fix the bug', repo: 'martin/repo-3', model: 'sonnet' } });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['id', 'status']);

    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'completed', runner.output());
    assert.equal(task.repo, 'martin/repo-3');
    assert.equal(task.repo_url, `${gitea.url}/martin/repo-3`);
    // The worker printed the API URL first; the web URL must win
    assert.equal(task.pr_url, `${gitea.url}/martin/repo-3/pulls/7`);
    assert.equal(task.errorType, null);
    assert.ok(task.finished);

    const log = (await runner.request('GET', `/task/${task.id}/logs`)).text;
    for (const marker of ['Repo: martin/repo-3', 'ORCHESTRATOR PHASE', 'ORCHESTRATOR COMPLETE', 'WORKER PHASE', 'WORKER COMPLETE']) {
      assert.ok(log.includes(marker), marker);
    }
    assert.equal(existsSync(path.join(runner.workDir, task.id, 'repo')), false, 'clone removed after success');

    // Setup ran git, not Claude: the only claude run is the worker
    assert.ok(log.includes(`$ git clone -q ${gitea.url}/martin/repo-3.git`), 'clone logged');
    const inits = initEvents(log);
    assert.equal(inits.length, 1, 'no orchestrator claude run');
    const argv = inits[0].argv;
    assert.equal(inits[0].model, 'sonnet', 'picked model goes to the worker');
    assert.ok(argv.includes('--append-system-prompt') && !argv.includes('--system-prompt'), 'keeps Claude Code\'s own prompt');
    assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /dependencies are not installed/);
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '2.5');
    assert.equal(task.session_id, inits[0].session_id, 'session kept for resume');
    const pushed = execFileSync('git', ['--git-dir', path.join(gitea.gitDir, 'martin', 'repo-3.git'), 'log', '--format=%s', `claude/${task.id}`]).toString().trim();
    assert.equal(pushed, 'chore: start task', 'branch pushed with its start commit');
    assert.ok(existsSync(path.join(runner.dataDir, 'logs', `${task.id}.log`)), 'log kept in the data dir');
  });

  test('auto-detect runs the orchestrator on haiku and resolves the cloned repo from its origin', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'Pick the right repo yourself', model: 'opus' } });
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'completed', runner.output());
    assert.equal(task.repo, 'org/repo-57');
    assert.equal(task.pr_url, `${gitea.url}/org/repo-57/pulls/7`);
    const log = (await runner.request('GET', `/task/${task.id}/logs`)).text;
    assert.ok(log.includes('Repo (auto-detected): org/repo-57'));
    assert.deepEqual(initEvents(log).map(e => e.model), ['haiku', 'opus'], 'orchestrator on haiku, worker on the picked model');
    assert.doesNotMatch(initEvents(log)[0].argv[1], /Examine the repo|Run dependency installation/, 'orchestrator does not install');
  });

  test('a failing clone fails the task with setup_failed, without running Claude', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'x', repo: 'martin/repo-40' } }); // listed, no git repo
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorType, 'setup_failed');
    assert.match(task.error, /^Setup failed: /);
    assert.equal(initEvents((await runner.request('GET', `/task/${task.id}/logs`)).text).length, 0);
  });

  test('a worker over its budget fails the task with budget_exceeded', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'OVER_BUDGET', repo: 'martin/repo-7' } });
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorType, 'budget_exceeded');
    assert.match(task.error, /\$2\.5 budget/);
  });

  test('a failing orchestrator fails the task with exit_code', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'FAIL_ORCHESTRATOR' } });
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorType, 'exit_code');
    assert.match(task.error, /Orchestrator exited with code 1/);
    assert.equal(task.pr_url, undefined);
  });

  test('a failing worker fails the task with exit_code and keeps the clone', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'FAIL_WORKER', repo: 'martin/repo-2' } });
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorType, 'exit_code');
    assert.match(task.error, /Worker exited with code 2/);
    assert.ok(existsSync(path.join(runner.workDir, task.id, 'repo')), 'clone kept for debugging');
  });

  test('a failed task resumes its worker session in the kept clone and finishes', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'FAIL_WORKER', repo: 'martin/repo-8' } });
    const failed = await waitForTask(runner, created.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.session_id);

    const res = await runner.request('POST', `/task/${created.id}/resume`);
    assert.equal(res.status, 200, res.text);
    assert.equal((await runner.request('POST', `/task/${created.id}/resume`)).status, 409, 'not while it runs');
    const task = await waitForTask(runner, created.id);
    assert.equal(task.status, 'completed', runner.output());
    assert.equal(task.errorType, null);
    assert.equal(task.error, null);
    assert.equal(task.pr_url, `${gitea.url}/martin/repo-8/pulls/7`);

    const log = (await runner.request('GET', `/task/${created.id}/logs`)).text;
    const resumed = initEvents(log)[1].argv;
    assert.equal(resumed[resumed.indexOf('--resume') + 1], failed.session_id);
    assert.equal(log.split('=== WORKER PHASE ===').length, 3, 'a second worker phase');
    assert.equal((await runner.request('POST', `/task/${created.id}/resume`)).status, 409, 'a completed task');
    assert.equal((await runner.request('POST', '/task/nope/resume')).status, 404);
  });

  test('a resume that cannot load the repo from Gitea leaves the task failed', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'FAIL_WORKER', repo: 'martin/repo-9' } });
    const failed = await waitForTask(runner, created.id);
    gitea.state.failRepoGet = true;
    try {
      const res = await runner.request('POST', `/task/${created.id}/resume`);
      assert.equal(res.status, 502);
      assert.match(res.json.error, /Could not load repo martin\/repo-9/);
    } finally {
      gitea.state.failRepoGet = false;
    }
    assert.deepEqual((await runner.request('GET', `/task/${created.id}`)).json, failed, 'unchanged, still resumable');
  });

  test('a task that failed before its worker started cannot be resumed', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'FAIL_ORCHESTRATOR' } });
    await waitForTask(runner, created.id);
    const res = await runner.request('POST', `/task/${created.id}/resume`);
    assert.equal(res.status, 409);
    assert.match(res.json.error, /worker started/);
  });

  test('tasks are listed newest first', async () => {
    const { json } = await runner.request('GET', '/tasks');
    assert.ok(json.length >= 4);
    const started = json.map(t => Date.parse(t.started));
    assert.deepEqual(started, [...started].sort((a, b) => b - a));
  });

  test('a task can be archived and unarchived; anything but a boolean is rejected', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'Archive me', repo: 'martin/repo-4' } });
    await waitForTask(runner, created.id);
    for (const body of [{}, { archived: 'yes' }, { archived: 1 }, { archived: null }]) {
      assert.equal((await runner.request('PATCH', `/task/${created.id}`, { body })).status, 400, JSON.stringify(body));
    }
    let res = await runner.request('PATCH', `/task/${created.id}`, { body: { archived: true } });
    assert.equal(res.status, 200);
    assert.equal(res.json.archived, true);
    assert.equal(res.json.status, 'completed', 'the rest of the task is unchanged');
    assert.equal((await runner.request('GET', '/tasks')).json.find(t => t.id === created.id).archived, true, 'listed, flagged');
    res = await runner.request('PATCH', `/task/${created.id}`, { body: { archived: false } });
    assert.equal(res.json.archived, false);
  });

  test('deleting a finished task removes it, its log and its clone', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'FAIL_WORKER', repo: 'martin/repo-5' } });
    await waitForTask(runner, created.id);
    assert.ok(existsSync(path.join(runner.workDir, created.id, 'repo')));
    assert.equal((await runner.request('DELETE', `/task/${created.id}`)).status, 200);
    assert.equal((await runner.request('GET', `/task/${created.id}`)).status, 404);
    assert.equal((await runner.request('GET', `/task/${created.id}/logs`)).status, 404);
    assert.ok(!(await runner.request('GET', '/tasks')).json.some(t => t.id === created.id));
    assert.equal(existsSync(path.join(runner.workDir, created.id)), false);
    assert.equal(existsSync(path.join(runner.dataDir, 'logs', `${created.id}.log`)), false);
    assert.equal((await runner.request('DELETE', `/task/${created.id}`)).status, 404, 'second delete');
  });

  test('deleting a running task stops it and it does not come back', async () => {
    const { json: created } = await runner.request('POST', '/task', { body: { prompt: 'HANG_ORCHESTRATOR' } });
    const running = (await runner.request('GET', `/task/${created.id}`)).json;
    assert.equal(running.status, 'running');
    await new Promise(r => setTimeout(r, 300)); // let the orchestrator start
    assert.equal((await runner.request('DELETE', `/task/${created.id}`)).status, 200);
    await new Promise(r => setTimeout(r, 500)); // the killed run winds down
    assert.equal((await runner.request('GET', `/task/${created.id}`)).status, 404, 'not re-created by the failing run');
    assert.equal(existsSync(path.join(runner.workDir, created.id)), false);
    assert.equal(existsSync(path.join(runner.dataDir, 'logs', `${created.id}.log`)), false, 'no log left by the dying run');
    const health = (await runner.request('GET', '/health')).json;
    assert.equal(health.running, 0);
    assert.doesNotMatch(runner.output(), /Unhandled|ENOENT/);
  });
});

describe('tasks across restarts', () => {
  let runner;
  let gitea;
  const ids = {};
  before(async () => {
    gitea = await mockGitea();
    runner = await startRunner({ GITEA_URL: `${gitea.url}/`, GITEA_TOKEN }, { gitea });
    await setUp(runner);
  });
  after(() => { runner.stop(); gitea.server.close(); rmSync(gitea.gitDir, { recursive: true, force: true }); });

  const restart = async () => {
    await runner.kill();
    rmSync(runner.workDir, { recursive: true, force: true }); // a redeploy starts with a fresh container filesystem
    runner = await startRunner({ GITEA_URL: `${gitea.url}/`, GITEA_TOKEN }, { tmp: runner.tmp, gitea });
    assert.equal((await runner.request('POST', '/api/login', { body: { username: 'martin', password: 'correct horse' } })).status, 200);
  };

  test('finished tasks, their logs and archive flags survive a redeploy; running ones are marked interrupted', async () => {
    ids.done = (await runner.request('POST', '/task', { body: { prompt: 'Keep me', repo: 'martin/repo-3' } })).json.id;
    ids.failed = (await runner.request('POST', '/task', { body: { prompt: 'FAIL_WORKER', repo: 'martin/repo-2' } })).json.id;
    const done = await waitForTask(runner, ids.done);
    await waitForTask(runner, ids.failed);
    await runner.request('PATCH', `/task/${ids.failed}`, { body: { archived: true } });
    ids.hung = (await runner.request('POST', '/task', { body: { prompt: 'HANG_WORKER', repo: 'martin/repo-6' } })).json.id;
    await new Promise(r => setTimeout(r, 500)); // let the worker start
    const before = (await runner.request('GET', '/tasks')).json;

    await restart();

    const list = (await runner.request('GET', '/tasks')).json;
    assert.deepEqual(list.map(t => t.id), before.map(t => t.id), 'same tasks, same order');
    assert.deepEqual(list.find(t => t.id === ids.done), done, 'completed task unchanged');
    assert.equal(list.find(t => t.id === ids.failed).archived, true);
    assert.equal(list.find(t => t.id === ids.failed).errorType, 'exit_code');

    const hung = list.find(t => t.id === ids.hung);
    assert.equal(hung.status, 'failed');
    assert.equal(hung.errorType, 'interrupted');
    assert.ok(hung.finished);
    assert.equal((await runner.request('GET', '/health')).json.running, 0);
    assert.ok(hung.session_id, 'session id saved while the worker ran');
    const resume = await runner.request('POST', `/task/${ids.hung}/resume`);
    assert.equal(resume.status, 409, 'its clone went with the old container');
    assert.match(resume.json.error, /clone is gone/);

    const log = await runner.request('GET', `/task/${ids.done}/logs`);
    assert.equal(log.status, 200);
    assert.ok(log.text.includes('WORKER COMPLETE'), 'log readable after the redeploy');
  });

  test('tasks can still be archived and deleted after a restart, and deletes stick', async () => {
    assert.equal((await runner.request('PATCH', `/task/${ids.done}`, { body: { archived: true } })).json.archived, true);
    assert.equal((await runner.request('DELETE', `/task/${ids.hung}`)).status, 200);
    assert.equal(existsSync(path.join(runner.dataDir, 'logs', `${ids.hung}.log`)), false);
    await restart();
    const list = (await runner.request('GET', '/tasks')).json;
    assert.equal(list.some(t => t.id === ids.hung), false, 'deleted task stays deleted');
    assert.equal(list.find(t => t.id === ids.done).archived, true);
  });

  test('a task whose log file is gone answers 404 instead of crashing the server', async () => {
    rmSync(path.join(runner.dataDir, 'logs', `${ids.failed}.log`));
    const res = await runner.request('GET', `/task/${ids.failed}/logs`);
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'Log not found');
    assert.equal((await runner.request('GET', '/health')).status, 200, 'server still up');
  });

  test('a corrupt tasks file starts an empty list instead of failing to boot', async () => {
    await runner.kill();
    writeFileSync(path.join(runner.dataDir, 'tasks.json'), '{oops');
    runner = await startRunner({ GITEA_URL: `${gitea.url}/`, GITEA_TOKEN }, { tmp: runner.tmp, gitea });
    assert.equal((await runner.request('POST', '/api/login', { body: { username: 'martin', password: 'correct horse' } })).status, 200);
    assert.deepEqual((await runner.request('GET', '/tasks')).json, []);
  });
});
