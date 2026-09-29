import fs from 'node:fs';
import path from 'node:path';

const q = (name) => `"${name.replace(/"/g, '""')}"`;

/**
 * Delete families + users and everything that references them, generically: rows in any table
 * with a `family_id` column, then (repeatedly) rows whose single-column foreign key now points
 * at nothing (or SET NULL when the FK says so). Works for module tables without knowing them.
 * Module tables must therefore have a `family_id` column or an ON DELETE CASCADE FK chain to one.
 *
 * NOT callable inside tx()/BEGIN: it runs its own transaction and must toggle
 * `PRAGMA foreign_keys`, which SQLite ignores inside a transaction. It throws if you try.
 */
export function purge(db, { familyIds = [], userIds = [] }) {
  if (!familyIds.length && !userIds.length) return;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name);
  try {
    db.exec('BEGIN');
    db.exec('ROLLBACK');
  } catch (err) {
    if (/within a transaction/i.test(err.message)) throw new Error('purge() cannot run inside a transaction (tx/BEGIN)');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const inList = (ids) => `(${ids.map(Number).join(',')})`;
    if (familyIds.length) {
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name);
        if (cols.includes('family_id')) db.exec(`DELETE FROM ${q(t)} WHERE family_id IN ${inList(familyIds)}`);
      }
      db.exec(`DELETE FROM families WHERE id IN ${inList(familyIds)}`);
    }
    if (userIds.length) db.exec(`DELETE FROM users WHERE id IN ${inList(userIds)}`);
    for (let pass = 0; pass < 10; pass++) {
      let changes = 0;
      for (const t of tables) {
        const fks = db.prepare(`PRAGMA foreign_key_list(${q(t)})`).all();
        const groups = new Map();
        for (const fk of fks) groups.set(fk.id, [...(groups.get(fk.id) || []), fk]);
        for (const [, cols] of groups) {
          if (cols.length !== 1) continue;
          const fk = cols[0];
          const parentCol = fk.to || 'rowid';
          const orphan = `${q(fk.from)} IS NOT NULL AND ${q(fk.from)} NOT IN (SELECT ${q(parentCol)} FROM ${q(fk.table)})`;
          const sql = fk.on_delete === 'SET NULL'
            ? `UPDATE ${q(t)} SET ${q(fk.from)} = NULL WHERE ${orphan}`
            : `DELETE FROM ${q(t)} WHERE ${orphan}`;
          changes += Number(db.prepare(sql).run().changes);
        }
      }
      if (!changes) break;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Remove a family's upload folder. */
export function removeFamilyUploads(uploadDir, familyId) {
  fs.rm(path.join(uploadDir, String(familyId)), { recursive: true, force: true }, () => {});
}
