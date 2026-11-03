// Persistence for the task list, so a restart or redeploy doesn't wipe the dashboard's history.
//
// Tasks are kept in one JSON file ({ [id]: task }) in DATA_DIR, which is a volume. They change a handful of times per
// run (start, repo detected, finished, archived), so rewriting the whole file on each change is cheap.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class TaskStore {
  // `logFile(id)` is where a task's log lives; used to date runs that a restart cut short.
  constructor(file, { logFile = () => null, now = () => new Date() } = {}) {
    this.file = file;
    this.tasks = new Map();
    let data = null;
    try {
      data = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Failed to load tasks:', e.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    let changed = false;
    for (const [id, task] of Object.entries(data)) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        changed = true;
        continue;
      }
      // Its `claude` process died with the old server: it will never finish, so mark it failed.
      if (task.status === 'running') {
        this.tasks.set(id, {
          ...task,
          status: 'failed',
          errorType: 'interrupted',
          error: 'The runner restarted while this task was running.',
          finished: lastWrite(logFile(id)) || now().toISOString()
        });
        changed = true;
      } else {
        this.tasks.set(id, task);
      }
    }
    if (changed) this.persist();
  }

  persist() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.tasks)));
      renameSync(tmp, this.file);
    } catch (e) {
      // Keep running from memory rather than failing tasks when the data dir isn't writable.
      console.error('Failed to save tasks:', e.message);
    }
  }

  get size() { return this.tasks.size; }
  get(id) { return this.tasks.get(id); }
  has(id) { return this.tasks.has(id); }
  values() { return this.tasks.values(); }
  entries() { return this.tasks.entries(); }

  set(id, task) {
    this.tasks.set(id, task);
    this.persist();
    return this;
  }

  delete(id) {
    const had = this.tasks.delete(id);
    if (had) this.persist();
    return had;
  }
}

function lastWrite(file) {
  if (!file) return null;
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}
