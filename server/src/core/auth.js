import { Router } from 'express';
import {
  PALETTE, clearSessionCookie, isManagedEmail, createSession, destroySession, hashPassword, publicUser,
  setSessionCookie, userFamilies, verifyPassword,
} from '../auth.js';
import { cleanStr, httpError, isColor, isDate, isEmail } from '../util.js';
import { createFamily } from './families.js';

export function authRouter(ctx) {
  const { db, auth, hub, avatarUpload, removeFile, rateLimit, failureLimit } = ctx;
  const r = Router();

  const payload = (userId, activeFamilyId) => ({
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)),
    families: userFamilies(db, userId),
    active_family_id: activeFamilyId ?? null,
  });

  r.post('/register', rateLimit('register-ip', (req) => req.ip), (req, res) => {
    const name = cleanStr(req.body?.name, { field: 'Name', required: true, max: 80 });
    const email = cleanStr(req.body?.email, { field: 'Email', required: true, max: 200 })?.toLowerCase();
    const password = String(req.body?.password ?? '');
    const familyName = cleanStr(req.body?.family_name, { field: 'Family name', max: 80 });
    if (!isEmail(email) || isManagedEmail(email)) throw httpError(400, 'Please enter a valid email address');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw httpError(409, 'An account with this email already exists');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const color = isColor(req.body?.color) ? req.body.color : PALETTE[count % PALETTE.length];
    const { lastInsertRowid: userId } = db
      .prepare('INSERT INTO users (email, password_hash, name, color) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), name, color);
    let familyId = null;
    if (familyName) familyId = createFamily(db, { name: familyName, userId: Number(userId) }).id;
    const token = createSession(db, Number(userId), familyId);
    setSessionCookie(res, token);
    res.status(201).json(payload(Number(userId), familyId));
  });

  // Brute-force protection counts FAILED attempts per IP (global) and per email+IP. Keying the
  // email rule by IP too means strangers can't lock a real user out of their account.
  r.post(
    '/login',
    (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const limit = failureLimit([['login-ip', req.ip], ['login-email', `${email}|${req.ip}`]]);
    if (limit.check(res)) return;
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      limit.fail();
      throw httpError(401, 'Incorrect email or password');
    }
    limit.succeed();
    const families = userFamilies(db, row.id);
    const token = createSession(db, row.id, families[0]?.id ?? null);
    setSessionCookie(res, token);
    res.json(payload(row.id, families[0]?.id ?? null));
    },
  );

  r.post('/logout', auth.requireAuth, (req, res) => {
    hub.closeSession(req.session.token);
    destroySession(db, req.session.token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Signed out -> 200 { user: null } so public pages don't log a 401.
  r.get('/me', auth.optionalAuth, (req, res) => {
    if (!req.user) return res.json({ user: null, families: [], active_family_id: null });
    const resolved = auth.resolveActiveFamily(req); // repairs a stale active family
    res.json(payload(req.user.id, resolved?.family.id ?? null));
  });

  r.patch('/me', auth.requireAuth, (req, res) => {
    const b = req.body ?? {};
    const updates = {};
    if ('name' in b) updates.name = cleanStr(b.name, { field: 'Name', required: true, max: 80 });
    if ('color' in b) {
      if (!isColor(b.color)) throw httpError(400, 'Color must be a hex value like #5B5BD6');
      updates.color = b.color;
    }
    if ('birthday' in b) {
      if (b.birthday && !isDate(b.birthday)) throw httpError(400, 'Birthday must be YYYY-MM-DD');
      updates.birthday = b.birthday || null;
    }
    if ('phone' in b) updates.phone = cleanStr(b.phone, { field: 'Phone', max: 40 });
    if ('email' in b) {
      const email = cleanStr(b.email, { field: 'Email', required: true, max: 200 }).toLowerCase();
      if (!isEmail(email) || isManagedEmail(email)) throw httpError(400, 'Please enter a valid email address');
      if (email !== String(req.userRow.email).toLowerCase() && !verifyPassword(b.current_password ?? '', req.userRow.password_hash)) {
        throw httpError(400, 'Enter your current password to change your email');
      }
      const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (clash) throw httpError(409, 'That email is already in use');
      updates.email = email;
    }
    if (b.password) {
      if (!verifyPassword(b.current_password ?? '', req.userRow.password_hash)) {
        throw httpError(400, 'Current password is incorrect');
      }
      if (String(b.password).length < 6) throw httpError(400, 'Password must be at least 6 characters');
      updates.password_hash = hashPassword(b.password);
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => updates[k]), req.user.id);
      if (updates.password_hash) {
        // Sign out other devices after a password change.
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.session.token);
        hub.closeUserSessions(req.user.id, { exceptToken: req.session.token });
      }
      broadcastMemberChange(ctx, req.user.id);
    }
    res.json(payload(req.user.id, req.session.active_family_id));
  });

  r.post('/me/avatar', auth.requireAuth, avatarUpload.single('file'), (req, res) => {
    if (!req.file) throw httpError(400, 'Please choose an image');
    const old = req.userRow.avatar_url;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(req.file.url, req.user.id);
    if (old) removeFile(old);
    broadcastMemberChange(ctx, req.user.id);
    res.json(payload(req.user.id, req.session.active_family_id));
  });

  r.delete('/me/avatar', auth.requireAuth, (req, res) => {
    const old = req.userRow.avatar_url;
    db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
    if (old) removeFile(old);
    broadcastMemberChange(ctx, req.user.id);
    res.json(payload(req.user.id, req.session.active_family_id));
  });

  return r;
}

/** Tell every family the user belongs to that their member list changed. */
export function broadcastMemberChange(ctx, userId) {
  const fams = ctx.db.prepare('SELECT family_id FROM memberships WHERE user_id = ?').all(userId);
  for (const f of fams) ctx.hub.broadcast(f.family_id, 'family.updated', { user_id: userId });
}
