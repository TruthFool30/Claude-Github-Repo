import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQL expression producing an ISO-8601 UTC timestamp (e.g. 2026-09-29T07:41:00.123Z).
 * Use it in module migrations: `created_at TEXT NOT NULL DEFAULT ${ISO_NOW}`.
 */
export const ISO_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const coreMigrations = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    avatar_url TEXT,
    birthday TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT ${ISO_NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    cover_url TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT ${ISO_NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','child')),
    nickname TEXT,
    created_at TEXT DEFAULT ${ISO_NOW},
    PRIMARY KEY (family_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_family_id INTEGER REFERENCES families(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT ${ISO_NOW},
    expires_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    module TEXT NOT NULL,
    verb TEXT NOT NULL,
    entity_id INTEGER,
    summary TEXT NOT NULL,
    link TEXT,
    created_at TEXT DEFAULT ${ISO_NOW}
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_family ON activity(family_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    module TEXT,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT ${ISO_NOW}
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, family_id, id DESC)`,
  // Remembered IANA time zone (from the client's X-Timezone header) for background jobs.
  `ALTER TABLE users ADD COLUMN timezone TEXT`,
  // Optional activity audience: JSON array of user ids; NULL = visible to the whole family.
  `ALTER TABLE activity ADD COLUMN audience TEXT`,
  // Two-factor login (TOTP). Secrets are sealed with ctx.box; totp_pending holds a secret during
  // setup until the first code verifies. totp_last_step blocks code replay. totp_recovery is a JSON
  // array of sha256 hashes of the unused recovery codes.
  `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN totp_pending TEXT`,
  `ALTER TABLE users ADD COLUMN totp_last_step INTEGER`,
  `ALTER TABLE users ADD COLUMN totp_recovery TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_activity_family_created ON activity(family_id, created_at DESC, id DESC)`,
];

const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
/** JS side of the `search_match(haystack, needle)` SQL function (returns 1/0). */
export function searchMatch(hay, needle) {
  if (hay == null || needle == null) return 0;
  const h = String(hay).toLowerCase();
  const n = String(needle).toLowerCase().trim();
  if (!n) return 0;
  if (h.includes(n)) return 1;
  const nn = n.replace(NON_ALNUM, '');
  if (nn.length < 2) return 0;
  return h.replace(NON_ALNUM, '').includes(nn) ? 1 : 0;
}

/**
 * Open (or create) the SQLite database, enable WAL + foreign keys and run the core
 * migrations followed by every module's `migrations` array (in module order).
 */
export function openDb(dbPath, modules = []) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // search_match(haystack, needle): case-insensitive "contains", also ignoring punctuation and
  // spaces, so "wifi" finds "Wi-Fi" and "wi fi". Use it in module `search` hooks.
  db.function('search_match', { deterministic: true }, searchMatch);
  for (const sql of coreMigrations) {
    try {
      db.exec(sql);
    } catch (err) {
      if (/duplicate column name/i.test(err.message)) continue; // idempotent ADD COLUMN
      throw err;
    }
  }
  for (const mod of modules) {
    for (const [i, sql] of (mod.migrations || []).entries()) {
      try {
        db.exec(sql);
      } catch (err) {
        // Allow idempotent "ALTER TABLE ... ADD COLUMN" migrations to be re-run.
        if (/duplicate column name/i.test(err.message)) continue;
        err.message = `Migration ${i} of module "${mod.name}" failed: ${err.message}`;
        throw err;
      }
    }
  }
  return db;
}

const txDepth = new WeakMap();
let savepointSeq = 0;

/**
 * Run `fn` inside a transaction and return its result. Re-entrant: when already inside a
 * transaction (an outer tx() or a manual BEGIN) it uses a SAVEPOINT, so helpers can call tx()
 * freely. Throwing inside `fn` rolls back (only the inner savepoint when nested) and rethrows.
 * `fn` must be synchronous (node:sqlite is synchronous anyway).
 */
export function tx(db, fn) {
  const depth = txDepth.get(db) ?? 0;
  let savepoint = null;
  if (depth > 0) {
    savepoint = `hearth_sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${savepoint}`);
  } else {
    try {
      db.exec('BEGIN');
    } catch (err) {
      if (!/within a transaction/i.test(err.message)) throw err;
      savepoint = `hearth_sp_${++savepointSeq}`;
      db.exec(`SAVEPOINT ${savepoint}`);
    }
  }
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('tx(): fn must be synchronous');
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    try {
      if (savepoint) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch { /* already rolled back */ }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
