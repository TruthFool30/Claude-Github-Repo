/**
 * notify({ familyId, userIds, module, title, body, link, excludeUserId? })
 * Inserts one notification per user and pushes `'notification'` (payload = row) to each of them.
 * Returns the inserted rows.
 */
export function makeNotify(db, hub) {
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, family_id, module, title, body, link) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
  );
  const isMember = db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?');
  return function notify({ familyId, userIds, module = null, title, body = null, link = null, excludeUserId = null }) {
    if (!familyId || !title) throw new Error('notify: familyId and title are required');
    const rows = [];
    for (const raw of new Set((userIds || []).map(Number))) {
      if (!raw || raw === Number(excludeUserId)) continue;
      if (!isMember.get(familyId, raw)) continue; // never notify outsiders
      const row = insert.get(raw, familyId, module, title, body, link);
      rows.push(row);
      hub?.sendToUsers([raw], 'notification', row, familyId); // only to streams viewing this family
    }
    return rows;
  };
}

/**
 * removeNotifications(familyId, rows) — delete notifications (`rows` = [{ id, user_id }]) and push
 * `'notification.removed'` ({ ids }) to each affected user's streams viewing this family.
 */
export function makeRemoveNotifications(db, hub) {
  // One bound JSON array instead of one `?` per id: no SQLite variable limit, however many rows.
  const del = db.prepare('DELETE FROM notifications WHERE id IN (SELECT value FROM json_each(?))');
  return function removeNotifications(familyId, rows) {
    if (!rows.length) return;
    del.run(JSON.stringify(rows.map((n) => n.id)));
    const byUser = new Map();
    for (const n of rows) {
      if (byUser.has(n.user_id)) byUser.get(n.user_id).push(n.id);
      else byUser.set(n.user_id, [n.id]);
    }
    for (const [uid, ids] of byUser) hub?.sendToUsers([uid], 'notification.removed', { ids }, familyId);
  };
}
