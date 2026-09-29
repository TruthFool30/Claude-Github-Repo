/**
 * Server-Sent Events hub.
 * Each connected client is bound to (sessionToken, userId, familyId). Events are
 * delivered either to every client of a family (`broadcast`) or to specific users
 * (`sendToUsers`, optionally only while they're viewing a given family).
 *
 * Wire format: `data: {"type": "...", "payload": {...}, "at": "<iso>"}\n\n`
 */
export function createHub({ heartbeatMs = 25000 } = {}) {
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

  const timer = setInterval(() => {
    for (const c of clients) {
      try {
        c.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clients.delete(c);
      }
    }
  }, heartbeatMs);
  timer.unref?.();

  return {
    /** Express handler body for GET /api/stream (after requireAuth; family optional). */
    connect(req, res) {
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

    /** Re-bind a session's open streams to another family (after /families/:id/activate). */
    rebindSession(token, familyId) {
      for (const c of clients) if (c.token === token) c.familyId = familyId ?? null;
    },

    /** Detach a user's streams from a family (user removed / left). */
    detachUser(userId, familyId) {
      for (const c of clients) {
        if (c.userId === Number(userId) && c.familyId === Number(familyId)) {
          c.familyId = null;
          write(c, 'family.removed', { family_id: Number(familyId) });
        }
      }
    },

    /** End sessions' streams (logout). */
    closeSession(token) {
      for (const c of clients) {
        if (c.token === token) {
          clients.delete(c);
          try { c.res.end(); } catch { /* ignore */ }
        }
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
