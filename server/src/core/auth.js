import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import {
  PALETTE, clearSessionCookie, isManagedEmail, createSession, destroySession, hashPassword, publicUser,
  setSessionCookie, userFamilies, verifyPassword,
} from '../auth.js';
import { cleanStr, httpError, isColor, isDate, isEmail } from '../util.js';
import { createFamily } from './families.js';
import { groupSecret, hashRecoveryCode, newRecoveryCode, newSecret, verifyTotp } from '../totp.js';

const TICKET_MS = 5 * 60_000;
const TICKET_TRIES = 5;
const RECOVERY_CODES = 10;
const PENDING_MS = 15 * 60_000; // an unfinished setup's secret stops working after this

export function authRouter(ctx) {
  const { db, auth, hub, avatarUpload, removeFile, rateLimit, failureLimit } = ctx;
  const r = Router();

  // Sent only to the signed-in user themself (never to other members), so it may carry account
  // security state that publicUser() must not.
  const payload = (userId, activeFamilyId) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return {
      user: publicUser(row),
      families: userFamilies(db, userId),
      active_family_id: activeFamilyId ?? null,
      two_factor_enabled: !!row.totp_secret,
      recovery_codes_left: row.totp_secret ? recoveryHashes(row).length : 0,
    };
  };

  // ---------- two-factor helpers ----------

  const recoveryHashes = (row) => {
    try {
      const list = JSON.parse(row.totp_recovery || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  /** Fresh recovery codes for a user: stores only their hashes, returns the plain codes once. */
  const issueRecoveryCodes = (userId) => {
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(codes.map(hashRecoveryCode)), userId);
    return codes;
  };

  /**
   * Check a second factor for a user with 2FA on: a 6-digit authenticator code (newer than the last
   * accepted one) or an unused recovery code (consumed). Persists the outcome; returns true/false.
   */
  const useSecondFactor = (row, rawCode) => {
    const code = String(rawCode ?? '').replace(/\s+/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(ctx.box.open(row.totp_secret), code, { lastStep: row.totp_last_step ?? -1 });
      if (step === null) return false;
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
      return true;
    }
    if (code.length > 40) return false;
    const given = Buffer.from(hashRecoveryCode(code), 'hex');
    const hashes = recoveryHashes(row);
    const idx = hashes.findIndex((h) => crypto.timingSafeEqual(Buffer.from(h, 'hex'), given));
    if (idx < 0) return false;
    hashes.splice(idx, 1);
    db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(hashes), row.id);
    return true;
  };

  /**
   * Wrong 2FA codes count against the same failure budget as wrong passwords (per IP and per
   * email+IP), plus a per-account budget that changing IPs can't dodge. Only someone who already
   * has the password (or a session) can spend the per-account one.
   */
  // ponytail: `code-user` is per account from any IP, so whoever already holds the password or a
  // session can burn it and block the real user's code step for one window; per-device budgets if that matters.
  const codeLimit = (req, user) => failureLimit([
    ['login-ip', req.ip],
    ['login-email', `${String(user.email).toLowerCase()}|${req.ip}`],
    ['code-user', String(user.id)],
  ]);

  // Pending sign-ins that passed the password check and wait for a code: ticket -> { userId, email, exp, tries }.
  // ponytail: in-memory, so it only works with one server process (a restart just asks people to sign
  // in again); move to a DB table if Hearth ever runs multiple processes.
  const tickets = new Map();
  const newTicket = (row) => {
    const now = Date.now();
    for (const [k, t] of tickets) if (t.exp <= now) tickets.delete(k);
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(ticket, { userId: row.id, email: row.email, exp: now + TICKET_MS, tries: 0 });
    return ticket;
  };

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
    // Two-factor accounts get a short-lived ticket instead of a session. The email+IP failure
    // counter is only cleared once the code step succeeds, so retrying the password doesn't buy
    // fresh code guesses.
    if (row.totp_secret) return res.json({ two_factor_required: true, ticket: newTicket(row) });
    limit.succeed();
    signIn(res, row.id);
    },
  );

  const signIn = (res, userId) => {
    const families = userFamilies(db, userId);
    const token = createSession(db, userId, families[0]?.id ?? null);
    setSessionCookie(res, token);
    res.json(payload(userId, families[0]?.id ?? null));
  };

  const EXPIRED = { error: 'Your sign-in timed out. Please enter your password again.', code: 'TWO_FACTOR_EXPIRED' };

  r.post('/login/2fa', (req, res) => {
    const key = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const t = tickets.get(key);
    if (!t || t.exp <= Date.now()) {
      tickets.delete(key);
      return res.status(401).json(EXPIRED);
    }
    const limit = codeLimit(req, { id: t.userId, email: t.email });
    if (limit.check(res)) return;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(t.userId);
    if (!row?.totp_secret) {
      tickets.delete(key);
      return res.status(401).json(EXPIRED);
    }
    if (!useSecondFactor(row, req.body?.code)) {
      limit.fail();
      if (++t.tries >= TICKET_TRIES) {
        tickets.delete(key);
        return res.status(401).json({ error: 'Too many wrong codes. Please sign in again.', code: 'TWO_FACTOR_EXPIRED' });
      }
      throw httpError(401, "That code didn't work. Check your authenticator app and try again.");
    }
    tickets.delete(key);
    limit.succeed();
    signIn(res, row.id);
  });

  // ---------- two-factor setup (signed in) ----------

  /**
   * Wrong passwords here count against the failure budget too (a stolen session can't brute-force
   * it). Answers 400 with `field: 'password'` so the client can show it on the right field.
   */
  const passwordOk = (req, res, limit) => {
    if (verifyPassword(req.body?.password ?? '', req.userRow.password_hash)) return true;
    limit.fail();
    res.status(400).json({ error: 'Current password is incorrect', field: 'password' });
    return false;
  };
  const freshRow = (req) => db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  r.post('/2fa/setup', auth.requireAuth, async (req, res) => {
    if (req.userRow.totp_secret) throw httpError(409, 'Two-factor login is already on');
    const limit = codeLimit(req, req.userRow);
    if (limit.check(res) || !passwordOk(req, res, limit)) return;
    const secret = newSecret();
    const label = `${encodeURIComponent('Hearth')}:${encodeURIComponent(req.userRow.email)}`;
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=Hearth&algorithm=SHA1&digits=6&period=30`;
    const qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    // Pending secret + when it was issued, sealed together.
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(ctx.box.seal(JSON.stringify({ secret, at: Date.now() })), req.user.id);
    res.json({ secret: groupSecret(secret), otpauth_uri: otpauthUri, qr_svg: qrSvg });
  });

  r.post('/2fa/enable', auth.requireAuth, (req, res) => {
    const row = freshRow(req);
    if (row.totp_secret) throw httpError(409, 'Two-factor login is already on');
    let pending = null;
    try {
      pending = JSON.parse(ctx.box.open(row.totp_pending));
    } catch { /* none, or unreadable */ }
    if (!pending?.secret || !(Date.now() - pending.at <= PENDING_MS)) throw httpError(400, 'This setup has expired. Please start again.');
    const limit = codeLimit(req, row);
    if (limit.check(res)) return;
    const step = verifyTotp(pending.secret, String(req.body?.code ?? '').replace(/\s+/g, ''));
    if (step === null) {
      limit.fail();
      throw httpError(400, "That code didn't match. Make sure your phone's clock is right and try the newest code.");
    }
    const codes = ctx.tx(db, () => {
      db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(ctx.box.seal(pending.secret), step, req.user.id);
      // Like a password change: sign out every other device.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.session.token);
      return issueRecoveryCodes(req.user.id);
    });
    hub.closeUserSessions(req.user.id, { exceptToken: req.session.token });
    res.json({ ...payload(req.user.id, req.session.active_family_id), recovery_codes: codes });
  });

  // Cancelled setup: forget the pending secret right away.
  r.delete('/2fa/setup', auth.requireAuth, (req, res) => {
    db.prepare('UPDATE users SET totp_pending = NULL WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  r.post('/2fa/disable', auth.requireAuth, (req, res) => {
    const row = freshRow(req);
    if (!row.totp_secret) throw httpError(400, 'Two-factor login is already off');
    const limit = codeLimit(req, row);
    if (limit.check(res) || !passwordOk(req, res, limit)) return;
    if (!useSecondFactor(row, req.body?.code)) {
      limit.fail();
      throw httpError(400, "That code didn't work. Use a current code from your app or an unused recovery code.");
    }
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?').run(req.user.id);
    res.json(payload(req.user.id, req.session.active_family_id));
  });

  r.post('/2fa/recovery-codes', auth.requireAuth, (req, res) => {
    const row = freshRow(req);
    if (!row.totp_secret) throw httpError(400, 'Turn on two-factor login first');
    const limit = codeLimit(req, row);
    if (limit.check(res)) return;
    if (!useSecondFactor(row, req.body?.code)) {
      limit.fail();
      throw httpError(400, "That code didn't work. Use a current code from your app or an unused recovery code.");
    }
    const codes = issueRecoveryCodes(req.user.id);
    res.json({ ...payload(req.user.id, req.session.active_family_id), recovery_codes: codes });
  });

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
    ctx.verifyImage(req.file);
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
