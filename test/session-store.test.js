// Unit tests for the file-backed session store and the persisted session secret.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSessionStore, loadSessionSecret } from '../src/session-store.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ccr-session-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = name => path.join(tmp, String(n++), name);

const call = (store, method, ...args) => new Promise((resolve, reject) =>
  store[method](...args, (err, value) => (err ? reject(err) : resolve(value))));
const sess = (expires, extra = {}) => ({ cookie: { originalMaxAge: 1000, expires, httpOnly: true, path: '/' }, ...extra });

describe('loadSessionSecret', () => {
  test('uses SESSION_SECRET when set, without writing a file', () => {
    const file = fresh('secret');
    assert.equal(loadSessionSecret(file, 'from-env'), 'from-env');
    assert.throws(() => statSync(file));
  });

  test('generates a secret once, saves it privately, and reuses it', () => {
    const file = fresh('secret');
    const first = loadSessionSecret(file, '');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(file, 'utf-8'), first);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadSessionSecret(file, ''), first, 'the saved secret is reused');
  });

  test('replaces an empty secret file', () => {
    const file = fresh('secret');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '  \n');
    const secret = loadSessionSecret(file, '');
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(loadSessionSecret(file, ''), secret);
  });

  test('still returns a secret when the file cannot be written', () => {
    const blocker = fresh('blocker');
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, ''); // a file where the directory should be
    assert.match(loadSessionSecret(path.join(blocker, 'secret'), ''), /^[0-9a-f]{64}$/);
  });
});

describe('FileSessionStore', () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();

  test('starts empty when the file is missing, corrupt, or not an object', async () => {
    for (const content of [null, 'not json', '[]', 'null', '"x"']) {
      const file = fresh('sessions.json');
      if (content !== null) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
      const store = new FileSessionStore(file);
      assert.equal(await call(store, 'length'), 0, String(content));
      assert.equal(await call(store, 'get', 'nope'), null);
    }
  });

  test('sessions written by one store are read by the next one on the same file', async () => {
    const file = fresh('sessions.json');
    const a = new FileSessionStore(file);
    await call(a, 'set', 'sid1', sess(new Date(later), { authenticated: true, username: 'martin' }));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    const b = new FileSessionStore(file);
    const got = await call(b, 'get', 'sid1');
    assert.equal(got.username, 'martin');
    assert.equal(got.authenticated, true);
    assert.equal(got.cookie.expires, later);
  });

  test('get returns a copy, so changing it does not change the stored session', async () => {
    const store = new FileSessionStore(fresh('sessions.json'));
    await call(store, 'set', 's', sess(later, { username: 'a' }));
    (await call(store, 'get', 's')).username = 'b';
    assert.equal((await call(store, 'get', 's')).username, 'a');
  });

  test('destroy and clear remove sessions from the file', async () => {
    const file = fresh('sessions.json');
    const store = new FileSessionStore(file);
    await call(store, 'set', 'a', sess(later));
    await call(store, 'set', 'b', sess(later));
    await call(store, 'destroy', 'a');
    await call(store, 'destroy', 'missing');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf-8'))), ['b']);
    await call(store, 'clear');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), {});
  });

  test('expired sessions are not returned and are dropped on load and on write', async () => {
    const file = fresh('sessions.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ old: sess(earlier), live: sess(later), noExpiry: sess(null), junk: 5 }));
    const store = new FileSessionStore(file);
    assert.equal(await call(store, 'get', 'old'), null);
    assert.ok(await call(store, 'get', 'noExpiry'), 'a session cookie without expiry stays');
    assert.deepEqual(Object.keys(await call(store, 'all')).sort(), ['live', 'noExpiry']);
    await call(store, 'set', 'new', sess(later));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf-8'))).sort(), ['live', 'new', 'noExpiry']);
  });

  test('a session that expires while loaded is dropped when read', async () => {
    let now = Date.now();
    const file = fresh('sessions.json');
    const store = new FileSessionStore(file, { now: () => now });
    await call(store, 'set', 's', sess(new Date(now + 1000).toISOString()));
    assert.ok(await call(store, 'get', 's'));
    now += 1000; // exactly at expiry counts as expired
    assert.equal(await call(store, 'get', 's'), null);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), {});
  });

  test('keeps working from memory when the file cannot be written', async () => {
    const blocker = fresh('blocker');
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, '');
    const store = new FileSessionStore(path.join(blocker, 'sessions.json'));
    await call(store, 'set', 's', sess(later, { username: 'martin' }));
    assert.equal((await call(store, 'get', 's')).username, 'martin');
  });
});
