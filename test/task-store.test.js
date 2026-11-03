// Unit tests for the file-backed task list.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ccr-tasks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(tmp, String(n++), 'tasks.json');
const saved = file => JSON.parse(readFileSync(file, 'utf-8'));
const NOW = new Date('2026-11-03T12:00:00.000Z');

describe('TaskStore', () => {
  test('starts empty without a file, and creates the data dir on the first save', () => {
    const file = fresh();
    const store = new TaskStore(file);
    assert.equal(store.size, 0);
    store.set('a', { status: 'completed', prompt: 'x' });
    assert.deepEqual(saved(file), { a: { status: 'completed', prompt: 'x' } });
  });

  test('every set and delete is saved, and a new store reads them back', () => {
    const file = fresh();
    const store = new TaskStore(file);
    store.set('a', { status: 'completed' }).set('b', { status: 'failed', archived: true });
    store.set('a', { status: 'completed', pr_url: 'https://git.test/pr/1' });
    assert.equal(store.delete('b'), true);
    assert.equal(store.delete('b'), false, 'second delete');
    const reloaded = new TaskStore(file);
    assert.deepEqual([...reloaded.entries()], [['a', { status: 'completed', pr_url: 'https://git.test/pr/1' }]]);
    assert.equal(reloaded.has('b'), false);
    assert.deepEqual([...reloaded.values()], [{ status: 'completed', pr_url: 'https://git.test/pr/1' }]);
  });

  test('a task still running when the server stopped is marked failed/interrupted, dated by its log', () => {
    const file = fresh();
    const logs = path.join(path.dirname(file), 'logs');
    mkdirSync(logs, { recursive: true });
    const logMtime = new Date('2026-11-03T11:30:00.000Z');
    writeFileSync(path.join(logs, 'withlog.log'), 'x');
    utimesSync(path.join(logs, 'withlog.log'), logMtime, logMtime);
    writeFileSync(file, JSON.stringify({
      withlog: { status: 'running', started: '2026-11-03T11:00:00.000Z' },
      nolog: { status: 'running', started: '2026-11-03T11:00:00.000Z', archived: true },
      done: { status: 'completed', finished: '2026-11-03T10:00:00.000Z' }
    }));
    const store = new TaskStore(file, { logFile: id => path.join(logs, `${id}.log`), now: () => NOW });
    for (const id of ['withlog', 'nolog']) {
      const t = store.get(id);
      assert.equal(t.status, 'failed', id);
      assert.equal(t.errorType, 'interrupted', id);
      assert.match(t.error, /restarted/);
      assert.equal(t.started, '2026-11-03T11:00:00.000Z', 'the rest is kept');
    }
    assert.equal(store.get('withlog').finished, logMtime.toISOString());
    assert.equal(store.get('nolog').finished, NOW.toISOString(), 'no log: now');
    assert.equal(store.get('nolog').archived, true);
    assert.deepEqual(store.get('done'), { status: 'completed', finished: '2026-11-03T10:00:00.000Z' });
    assert.equal(saved(file).withlog.status, 'failed', 'the fix-up is saved right away');
  });

  test('a corrupt or wrongly shaped file starts empty instead of crashing', () => {
    for (const content of ['{not json', '[1,2]', 'null', '"str"', '']) {
      const file = fresh();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      assert.equal(new TaskStore(file).size, 0, JSON.stringify(content));
    }
  });

  test('entries that are not objects are dropped and the file is cleaned', () => {
    const file = fresh();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ a: null, b: 'x', c: [1], d: { status: 'completed' } }));
    const store = new TaskStore(file);
    assert.deepEqual([...store.entries()], [['d', { status: 'completed' }]]);
    assert.deepEqual(saved(file), { d: { status: 'completed' } });
  });

  test('keeps working from memory when the file cannot be written', () => {
    const blocker = path.join(tmp, `blocker-${n++}`);
    writeFileSync(blocker, ''); // a file where the data dir should be
    const store = new TaskStore(path.join(blocker, 'tasks.json'));
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      store.set('a', { status: 'completed' });
    } finally {
      console.error = orig;
    }
    assert.equal(store.get('a').status, 'completed');
    assert.match(errors.join('\n'), /Failed to save tasks/);
  });
});
