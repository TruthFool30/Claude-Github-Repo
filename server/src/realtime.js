/**
 * Server-Sent Events hub.
 * Each connected client is bound to (sessionToken, userId, familyId). A browser tab passes
 * `?family_id=` so each tab's stream follows that tab's family; streams opened without it follow
 * the session's default family. Events go to every client of a family (`broadcast`) or to
 * specific users (`sendToUsers`, optionally only while they're viewing a given family).
 *
 * Wire format: `data: {"type": "...", "payload": {...}, "at": "<iso>"}\n\n`
 */
export function createHub({ heartbeatMs = 25000, isSessionValid = null } = {}) {
  const clients = new Set();
  let nextId = 1;

  function write(client, type, payload) {
    const data = JSON.stringify({ type, payload: payload ?? null, at: new Date().toISOString() });
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  function end(client, type = null, payload = null) {
    if (type) write(client, type, payload);
    clients.delete(client);
    try { client.res.end(); } catch { /* ignore */ }
  }

  const timer = setInterval(() => {
    for (const c of clients) {
      // Long-lived streams must not outlive their session (logout elsewhere, expiry, password change).
      if (isSessionValid && c.token && !isSessionValid(c.token)) {
        end(c, 'session.ended', null);
        continue;
      }
      try {
        c.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clients.delete(c);
      }
    }
  }, heartbeatMs);
  timer.unref?.();

  return {
    /** Express handler body for GET /api/stream (after requireAuth; req.family optional). */
    connect(req, res, { explicitFamily = false } = {}) {
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');
      const client = {
        id: nextId++,
        res,
        token: req.session?.token,
        userId: req.user.id,
        familyId: req.family?.id ?? null,
        explicit: explicitFamily,
      };
      clients.add(client);
      write(client, 'hello', { user_id: client.userId, family_id: client.familyId });
      req.on('close', () => clients.delete(client));
    },

    /** Send to every client currently viewing `familyId`. */
    broadcast(familyId, type, payload) {
      for (const c of clients) if (c.familyId === Number(familyId)) write(c, type, payload);
    },

    /** Send to specific users. When familyId is given, only to their clients bound to that family. */
    sendToUsers(userIds, type, payload, familyId = null) {
      const ids = new Set((userIds || []).map(Number));
      for (const c of clients) {
        if (!ids.has(c.userId)) continue;
        if (familyId != null && c.familyId !== Number(familyId)) continue;
        write(c, type, payload);
      }
    },

    /** Re-bind a session's streams that follow the session default (no explicit ?family_id). */
    rebindSession(token, familyId) {
      for (const c of clients) if (c.token === token && !c.explicit) c.familyId = familyId ?? null;
    },

    /** Detach a user's streams from a family (user removed / left). */
    detachUser(userId, familyId, payload = {}) {
      for (const c of clients) {
        if (c.userId === Number(userId) && c.familyId === Number(familyId)) {
          write(c, 'family.removed', { family_id: Number(familyId), ...payload });
          c.familyId = null;
        }
      }
    },

    /** Detach every stream from a family (family deleted). */
    detachFamily(familyId, payload = {}) {
      for (const c of clients) {
        if (c.familyId === Number(familyId)) {
          write(c, 'family.removed', { family_id: Number(familyId), ...payload });
          c.familyId = null;
        }
      }
    },

    /** End one session's streams (logout). */
    closeSession(token) {
      for (const c of clients) if (c.token === token) end(c, 'session.ended', null);
    },

    /** End all of a user's streams except those of `exceptToken` (password change). */
    closeUserSessions(userId, { exceptToken = null } = {}) {
      for (const c of clients) {
        if (c.userId === Number(userId) && c.token !== exceptToken) end(c, 'session.ended', null);
      }
    },

    get size() {
      return clients.size;
    },

    close() {
      clearInterval(timer);
      for (const c of clients) {
        try { c.res.end(); } catch { /* ignore */ }
      }
      clients.clear();
    },
  };
}
