/**
 * notify({ familyId, userIds, module, title, body, link, excludeUserId? })
 * Inserts one notification per user and pushes `'notification'` (payload = row) to each of them.
 * Returns the inserted rows.
 */
export function makeNotify(db, hub) {
  const insert = db.prepare(
    'INSERT INTO notifications (user_id, family_id, module, title, body, link) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const isMember = db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?');
  return function notify({ familyId, userIds, module = null, title, body = null, link = null, excludeUserId = null }) {
    if (!familyId || !title) throw new Error('notify: familyId and title are required');
    const rows = [];
    for (const raw of new Set((userIds || []).map(Number))) {
      if (!raw || raw === Number(excludeUserId)) continue;
      if (!isMember.get(familyId, raw)) continue; // never notify outsiders
      const { lastInsertRowid } = insert.run(raw, familyId, module, title, body, link);
      const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(lastInsertRowid);
      rows.push(row);
      hub?.sendToUsers([raw], 'notification', row, familyId); // only to streams viewing this family
    }
    return rows;
  };
}
