// Persistence for browser logins, so a restart or redeploy doesn't sign everyone out.
//
// express-session's default MemoryStore forgets every session when the process exits, and a secret generated at
// startup invalidates every cookie signed with the previous one. These keep both in DATA_DIR, which is a volume.
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// SESSION_SECRET from the environment if set, otherwise one generated on first start and kept in `file`.
export function loadSessionSecret(file, envSecret = process.env.SESSION_SECRET) {
  if (envSecret) return envSecret;
  try {
    const saved = readFileSync(file, 'utf-8').trim();
    if (saved) return saved;
  } catch {}
  const secret = randomBytes(32).toString('hex');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
  } catch (e) {
    // Still usable for this run; sessions just won't survive a restart.
    console.error('Failed to save session secret:', e.message);
  }
  return secret;
}

// A session store backed by one JSON file ({ [sid]: session }). Sessions are few (one account) and only written on
// login and logout (resave: false, and no touch()), so rewriting the whole file each time is cheap.
export class FileSessionStore extends session.Store {
  constructor(file, { now = Date.now } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.sessions = {};
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) this.sessions = data;
    } catch {}
    this.prune();
  }

  isExpired(sess) {
    const expires = sess?.cookie?.expires;
    return Boolean(expires) && new Date(expires).getTime() <= this.now();
  }

  // Drops expired sessions; returns whether any were dropped.
  prune() {
    let dropped = false;
    for (const [sid, sess] of Object.entries(this.sessions)) {
      if (!sess || typeof sess !== 'object' || this.isExpired(sess)) {
        delete this.sessions[sid];
        dropped = true;
      }
    }
    return dropped;
  }

  persist() {
    this.prune();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.sessions), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      // Keep working from memory rather than failing logins when the data dir isn't writable.
      console.error('Failed to save sessions:', e.message);
    }
  }

  get(sid, cb) {
    const sess = this.sessions[sid];
    if (!sess) return cb(null, null);
    if (this.isExpired(sess)) {
      delete this.sessions[sid];
      this.persist();
      return cb(null, null);
    }
    cb(null, JSON.parse(JSON.stringify(sess)));
  }

  set(sid, sess, cb) {
    this.sessions[sid] = JSON.parse(JSON.stringify(sess));
    this.persist();
    cb?.(null);
  }

  destroy(sid, cb) {
    if (sid in this.sessions) {
      delete this.sessions[sid];
      this.persist();
    }
    cb?.(null);
  }

  clear(cb) {
    this.sessions = {};
    this.persist();
    cb?.(null);
  }

  length(cb) {
    this.prune();
    cb(null, Object.keys(this.sessions).length);
  }

  all(cb) {
    this.prune();
    cb(null, JSON.parse(JSON.stringify(this.sessions)));
  }
}
