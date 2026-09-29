import { publicUser } from './auth.js';

/** Hydrate activity rows with a public `user` object. */
export function hydrateActivity(db, rows) {
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const users = new Map();
  if (ids.length) {
    const stmt = db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`);
    for (const u of stmt.all(...ids)) users.set(u.id, publicUser(u));
  }
  return rows.map((r) => ({ ...r, user: r.user_id ? users.get(r.user_id) ?? null : null }));
}

/**
 * logActivity({ familyId, userId, module, verb, entityId, summary, link, createdAt? })
 * Inserts into `activity` and broadcasts `'activity'` (payload = hydrated row) to the family.
 */
export function makeLogActivity(db, hub) {
  const insert = db.prepare(
    `INSERT INTO activity (family_id, user_id, module, verb, entity_id, summary, link, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  );
  return function logActivity({ familyId, userId = null, module, verb, entityId = null, summary, link = null, createdAt = null }) {
    if (!familyId || !module || !verb || !summary) throw new Error('logActivity: familyId, module, verb and summary are required');
    const { lastInsertRowid } = insert.run(familyId, userId, module, verb, entityId, summary, link, createdAt);
    const row = db.prepare('SELECT * FROM activity WHERE id = ?').get(lastInsertRowid);
    const [hydrated] = hydrateActivity(db, [row]);
    hub?.broadcast(familyId, 'activity', hydrated);
    return hydrated;
  };
}
