import crypto from 'node:crypto';

export const COOKIE_NAME = 'hearth_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

export const PALETTE = [
  '#5B5BD6', '#E5484D', '#F76B15', '#FFB224', '#30A46C',
  '#12A594', '#0090FF', '#8E4EC6', '#D6409F', '#978365',
];

// ---------- passwords ----------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password ?? ''), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- users ----------

/** Strip secrets from a users row. Safe to send to any family member. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: isManagedEmail(row.email) ? null : row.email,
    color: row.color,
    avatar_url: row.avatar_url ?? null,
    birthday: row.birthday ?? null,
    phone: row.phone ?? null,
    created_at: row.created_at,
  };
}

/** Managed (child) members created without an email get a placeholder address. */
export const MANAGED_EMAIL_DOMAIN = 'managed.hearth.local';
export function isManagedEmail(email) {
  return typeof email === 'string' && email.endsWith(`@${MANAGED_EMAIL_DOMAIN}`);
}

// ---------- sessions ----------

export function createSession(db, userId, activeFamilyId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, user_id, active_family_id, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, userId, activeFamilyId, expires);
  return token;
}

/** true when the session token exists and hasn't expired (used to end stale SSE streams). */
export function isSessionValid(db, token) {
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  return !!row && (!row.expires_at || row.expires_at >= new Date().toISOString());
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

/** Memberships of a user, newest family last. */
export function userFamilies(db, userId) {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.cover_url, f.currency, f.invite_code, f.created_at, m.role, m.nickname,
              (SELECT COUNT(*) FROM memberships mm WHERE mm.family_id = f.id) AS member_count
         FROM memberships m JOIN families f ON f.id = m.family_id
        WHERE m.user_id = ? ORDER BY m.created_at, f.id`,
    )
    .all(userId);
  // Only admins may see (and share) a family's invite code.
  return rows.map((f) => ({ ...f, invite_code: f.role === 'admin' ? f.invite_code : null }));
}

export function getMembership(db, familyId, userId) {
  return db
    .prepare('SELECT role, nickname FROM memberships WHERE family_id = ? AND user_id = ?')
    .get(familyId, userId);
}

// ---------- middleware ----------

/**
 * Factory for the auth middlewares. `requireAuth` sets req.user (public shape),
 * req.userRow (full row), req.session. `requireFamily` (after requireAuth) sets
 * req.family, req.role, resolving the session's active family (falls back to the
 * user's first family, 403 when the user belongs to none).
 */
export function makeAuth(db) {
  const findSession = db.prepare(
    `SELECT s.token, s.user_id, s.active_family_id, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
  );
  const touch = db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');

  /** Returns null on success (req.user etc. set) or an error message. */
  function authenticate(req, res) {
    const token = readToken(req);
    if (!token) return 'Please sign in';
    const row = findSession.get(token);
    if (!row || (row.expires_at && row.expires_at < new Date().toISOString())) {
      if (row) destroySession(db, token);
      clearSessionCookie(res);
      return 'Your session has expired, please sign in again';
    }
    // Sliding expiry: extend when less than half the lifetime remains.
    const halfLife = new Date(Date.now() + (SESSION_DAYS / 2) * 864e5).toISOString();
    if (row.expires_at && row.expires_at < halfLife) {
      touch.run(new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), token);
    }
    req.session = { token, user_id: row.user_id, active_family_id: row.active_family_id };
    req.userRow = { ...row, id: row.user_id };
    req.user = publicUser(req.userRow);
    return null;
  }

  function requireAuth(req, res, next) {
    const error = authenticate(req, res);
    if (error) return res.status(401).json({ error });
    next();
  }

  /** Like requireAuth but never rejects: req.user is simply unset when signed out. */
  function optionalAuth(req, res, next) {
    authenticate(req, res);
    next();
  }

  function resolveActiveFamily(req) {
    const userId = req.user.id;
    let familyId = req.session.active_family_id;
    let membership = familyId ? getMembership(db, familyId, userId) : null;
    if (!membership) {
      const first = db
        .prepare('SELECT family_id FROM memberships WHERE user_id = ? ORDER BY created_at, family_id LIMIT 1')
        .get(userId);
      familyId = first?.family_id ?? null;
      membership = familyId ? getMembership(db, familyId, userId) : null;
      if (familyId !== req.session.active_family_id) {
        db.prepare('UPDATE sessions SET active_family_id = ? WHERE token = ?').run(familyId, req.session.token);
        req.session.active_family_id = familyId;
      }
    }
    if (!familyId || !membership) return null;
    const family = db.prepare('SELECT * FROM families WHERE id = ?').get(familyId);
    return family ? { family, role: membership.role } : null;
  }

  /**
   * The family a request is about: the `X-Family-Id` header (each browser tab sends its own) or,
   * for the SSE stream, `?family_id=`. Returns null when absent, NaN when malformed.
   */
  function requestedFamilyId(req) {
    const raw = req.get('x-family-id') ?? req.query?.family_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  }

  /** Resolve the family for this request: explicit header/query first, else the session default. */
  function resolveRequestFamily(req) {
    const requested = requestedFamilyId(req);
    if (requested === null) return resolveActiveFamily(req);
    const membership = Number.isNaN(requested) ? null : getMembership(db, requested, req.user.id);
    if (!membership) return { error: 'NOT_MEMBER' };
    const family = db.prepare('SELECT * FROM families WHERE id = ?').get(requested);
    return family ? { family, role: membership.role, explicit: true } : { error: 'NOT_MEMBER' };
  }

  function requireFamily(req, res, next) {
    const resolved = resolveRequestFamily(req);
    if (resolved?.error) {
      return res.status(403).json({ error: "You're not a member of that family anymore", code: 'NOT_MEMBER' });
    }
    if (!resolved) return res.status(403).json({ error: 'Create or join a family first', code: 'NO_FAMILY' });
    req.family = resolved.family;
    req.role = resolved.role;
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Only family admins can do that' });
    next();
  }

  return { requireAuth, optionalAuth, requireFamily, requireAdmin, resolveActiveFamily, resolveRequestFamily, requestedFamilyId };
}

export function randomInviteCode() {
  // Unambiguous alphabet (no 0/O, 1/I/L).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
