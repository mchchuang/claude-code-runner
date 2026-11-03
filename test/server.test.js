// Integration tests: run the real server against a mock Gitea API and a fake `claude` CLI (test/fixtures).
// Linux/macOS only (node-pty and the shell wrapper); CI runs them in Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

function mockGitea() {
  const state = { failRepoList: false, repoListCalls: 0 };
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
      const found = repos.find(r => r.full_name === `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
      return found ? json(200, withUrls(found)) : json(404, { message: 'not found' });
    }
    json(404, { message: 'no route' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

// ---------- Server under test ----------

async function startRunner(env = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ccr-test-'));
  const port = await freePort();
  writeFileSync(path.join(tmp, 'gitconfig'), '');
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
  const stop = () => { proc.kill(); rmSync(tmp, { recursive: true, force: true }); };
  return { request, stop, workDir: path.join(tmp, 'work'), dataDir: path.join(tmp, 'data'), output: () => output };
}

async function setUp(runner) {
  const res = await runner.request('POST', '/api/setup', { body: { username: 'martin', password: 'correct horse' } });
  assert.equal(res.status, 200, res.text);
}

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
  });
});

describe('with Gitea', () => {
  let runner;
  let gitea;
  before(async () => {
    gitea = await mockGitea();
    runner = await startRunner({ GITEA_URL: `${gitea.url}/`, GITEA_TOKEN, FAKE_AUTO_CLONE_URL: `${gitea.url}/org/repo-57.git` });
    await setUp(runner);
  });
  after(() => { runner.stop(); gitea.server.close(); });

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

  test('a task on a picked repo runs both phases and records the PR', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'Fix the bug', repo: 'martin/repo-3' } });
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
    assert.ok(existsSync(path.join(runner.workDir, task.id, 'output.log')), 'log kept');
  });

  test('auto-detect resolves the cloned repo from its origin', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'Pick the right repo yourself' } });
    const task = await waitForTask(runner, res.json.id);
    assert.equal(task.status, 'completed', runner.output());
    assert.equal(task.repo, 'org/repo-57');
    assert.equal(task.pr_url, `${gitea.url}/org/repo-57/pulls/7`);
    assert.ok((await runner.request('GET', `/task/${task.id}/logs`)).text.includes('Repo (auto-detected): org/repo-57'));
  });

  test('a failing orchestrator fails the task with exit_code', async () => {
    const res = await runner.request('POST', '/task', { body: { prompt: 'FAIL_ORCHESTRATOR', repo: 'martin/repo-1' } });
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

  test('tasks are listed newest first', async () => {
    const { json } = await runner.request('GET', '/tasks');
    assert.ok(json.length >= 4);
    const started = json.map(t => Date.parse(t.started));
    assert.deepEqual(started, [...started].sort((a, b) => b - a));
  });
});
