import { publicUser } from './auth.js';

/**
 * SQL fragment restricting activity rows to those a viewer may see: family-wide rows
 * (`audience IS NULL`) plus rows whose audience (JSON array of user ids) contains the viewer.
 * Bind one parameter: the viewer's user id. `alias` is the activity table alias (or name).
 */
export function activityVisibleSql(alias = 'activity') {
  return `(${alias}.audience IS NULL OR EXISTS (SELECT 1 FROM json_each(${alias}.audience) WHERE json_each.value = ?))`;
}

/** Parsed audience (array of user ids) of an activity row, or null when family-wide. */
export function activityAudience(row) {
  if (!row?.audience) return null;
  try {
    const ids = JSON.parse(row.audience);
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : null;
  } catch {
    return [];
  }
}

/** Hydrate activity rows with a public `user` object (the internal `audience` column is dropped). */
export function hydrateActivity(db, rows) {
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const users = new Map();
  if (ids.length) {
    const stmt = db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`);
    for (const u of stmt.all(...ids)) users.set(u.id, publicUser(u));
  }
  return rows.map(({ audience, ...r }) => ({ ...r, user: r.user_id ? users.get(r.user_id) ?? null : null }));
}

/**
 * Send an activity-related SSE event, honouring the row's audience: family-wide rows go to the
 * whole family, audience-restricted rows only to those users (while they view that family).
 */
export function emitActivityEvent(hub, row, type, payload) {
  if (!hub || !row) return;
  const audience = activityAudience(row);
  if (audience) hub.sendToUsers(audience, type, payload, row.family_id);
  else hub.broadcast(row.family_id, type, payload);
}

/**
 * logActivity({ familyId, userId, module, verb, entityId, summary, link, createdAt?, audience? })
 * Inserts into `activity` and sends `'activity'` (payload = hydrated row). `audience` (array of
 * user ids) restricts the entry to those members everywhere activity is read (feed, Wall, SSE);
 * omit it for family-wide entries.
 */
export function makeLogActivity(db, hub) {
  const insert = db.prepare(
    `INSERT INTO activity (family_id, user_id, module, verb, entity_id, summary, link, created_at, audience)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?)`,
  );
  return function logActivity({ familyId, userId = null, module, verb, entityId = null, summary, link = null, createdAt = null, audience = null }) {
    if (!familyId || !module || !verb || !summary) throw new Error('logActivity: familyId, module, verb and summary are required');
    if (audience != null && !Array.isArray(audience)) throw new Error('logActivity: audience must be an array of user ids');
    const aud = audience ? JSON.stringify([...new Set(audience.map(Number).filter(Number.isInteger))]) : null;
    const { lastInsertRowid } = insert.run(familyId, userId, module, verb, entityId, summary, link, createdAt, aud);
    const row = db.prepare('SELECT * FROM activity WHERE id = ?').get(lastInsertRowid);
    const [hydrated] = hydrateActivity(db, [row]);
    emitActivityEvent(hub, row, 'activity', hydrated);
    return hydrated;
  };
}
