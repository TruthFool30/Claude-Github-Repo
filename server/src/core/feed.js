import { Router } from 'express';
import { hydrateActivity } from '../activity.js';
import { listMembers } from './families.js';

/** /api/activity (requireAuth + requireFamily) */
export function activityRouter(ctx) {
  const { db } = ctx;
  const r = Router();
  r.get('/', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const before = Number(req.query.before) || null;
    const params = [req.family.id];
    let where = 'family_id = ?';
    if (before) { where += ' AND id < ?'; params.push(before); }
    if (req.query.module) { where += ' AND module = ?'; params.push(String(req.query.module)); }
    const rows = db.prepare(`SELECT * FROM activity WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
    res.json(hydrateActivity(db, rows));
  });
  return r;
}

/** /api/notifications (requireAuth + requireFamily) — scoped to the user AND the active family. */
export function notificationsRouter(ctx) {
  const { db, hub } = ctx;
  const r = Router();
  r.get('/', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const items = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? AND family_id = ? ORDER BY id DESC LIMIT ?')
      .all(req.user.id, req.family.id, limit);
    const unread = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND family_id = ? AND read_at IS NULL')
      .get(req.user.id, req.family.id).n;
    res.json({ items, unread });
  });
  r.post('/read', (req, res) => {
    const now = new Date().toISOString();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids && ids.length) {
      const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      for (const id of ids) stmt.run(now, id, req.user.id);
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND family_id = ? AND read_at IS NULL')
        .run(now, req.user.id, req.family.id);
    }
    hub.sendToUsers([req.user.id], 'notification.read', { ids: ids ?? 'all' });
    res.json({ ok: true });
  });
  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });
  return r;
}

/** GET /api/stream — SSE. Requires auth; bound to the active family when there is one. */
export function streamHandler(ctx) {
  return (req, res) => {
    const resolved = ctx.auth.resolveRequestFamily(req);
    if (resolved?.error) return res.status(403).json({ error: "You're not a member of that family anymore", code: 'NOT_MEMBER' });
    if (resolved) req.family = resolved.family;
    ctx.hub.connect(req, res, { explicitFamily: !!resolved?.explicit });
  };
}

/** GET /api/search?q= — members + every module's `search(ctx, familyId, q, req)` hook. */
export function searchHandler(ctx, modules) {
  return async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ q, results: [] });
    const needle = q.toLowerCase();
    const results = listMembers(ctx.db, req.family.id)
      .filter((m) => m.name.toLowerCase().includes(needle) || (m.nickname ?? '').toLowerCase().includes(needle))
      .map((m) => ({ module: 'family', title: m.name, subtitle: { admin: 'Admin', member: 'Member', child: 'Child' }[m.role], link: '/family', avatar: m }));
    const perModule = await Promise.all(
      modules
        .filter((m) => typeof m.search === 'function')
        .map(async (m) => {
          try {
            const rows = (await m.search(ctx, req.family.id, q, req)) || [];
            return rows.slice(0, 8).map((row) => ({ module: m.name, ...row }));
          } catch (err) {
            console.error(`[search] module ${m.name} failed:`, err.message);
            return [];
          }
        }),
    );
    res.json({ q, results: results.concat(...perModule) });
  };
}

/** GET /api/dashboard — `{ [module]: await dashboard(ctx, req) }` (failures become null). */
export function dashboardHandler(ctx, modules) {
  return async (req, res) => {
    const out = {};
    await Promise.all(
      modules
        .filter((m) => typeof m.dashboard === 'function')
        .map(async (m) => {
          try {
            out[m.name] = (await m.dashboard(ctx, req)) ?? null;
          } catch (err) {
            console.error(`[dashboard] module ${m.name} failed:`, err.message);
            out[m.name] = null;
          }
        }),
    );
    res.json(out);
  };
}
