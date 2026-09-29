import crypto from 'node:crypto';
import { Router } from 'express';
import {
  MANAGED_EMAIL_DOMAIN, PALETTE, getMembership, hashPassword, isManagedEmail, publicUser,
  randomInviteCode, userFamilies,
} from '../auth.js';
import { tx } from '../db.js';
import { cleanStr, httpError, isColor, isDate, isEmail, toId } from '../util.js';

export function uniqueInviteCode(db) {
  for (;;) {
    const code = randomInviteCode();
    if (!db.prepare('SELECT 1 FROM families WHERE invite_code = ?').get(code)) return code;
  }
}

/** Create a family with `userId` as admin. Returns the families row. */
export function createFamily(db, { name, userId, currency = 'USD' }) {
  return tx(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO families (name, invite_code, currency, created_by) VALUES (?, ?, ?, ?)')
      .run(name, uniqueInviteCode(db), currency, userId);
    db.prepare("INSERT INTO memberships (family_id, user_id, role) VALUES (?, ?, 'admin')").run(lastInsertRowid, userId);
    return db.prepare('SELECT * FROM families WHERE id = ?').get(lastInsertRowid);
  });
}

/** Members of a family in a stable order (admins first, then by join date). */
export function listMembers(db, familyId) {
  return db
    .prepare(
      `SELECT u.*, m.role, m.nickname, m.created_at AS joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ?
        ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.created_at, u.id`,
    )
    .all(familyId)
    .map((row) => ({
      ...publicUser(row),
      role: row.role,
      nickname: row.nickname ?? null,
      joined_at: row.joined_at,
      managed: isManagedEmail(row.email),
    }));
}

function familyPayload(db, family, role) {
  return {
    id: family.id,
    name: family.name,
    invite_code: family.invite_code,
    cover_url: family.cover_url ?? null,
    currency: family.currency,
    created_by: family.created_by,
    created_at: family.created_at,
    role,
    members: listMembers(db, family.id),
  };
}

const CURRENCY = /^[A-Z]{3}$/;

/** /api/families — requires auth only (no active family needed). */
export function familiesRouter(ctx) {
  const { db, hub, logActivity } = ctx;
  const r = Router();

  r.get('/', (req, res) => res.json(userFamilies(db, req.user.id)));

  r.post('/', (req, res) => {
    const name = cleanStr(req.body?.name, { field: 'Family name', required: true, max: 80 });
    const currency = req.body?.currency ? String(req.body.currency).toUpperCase() : 'USD';
    if (!CURRENCY.test(currency)) throw httpError(400, 'Currency must be a 3-letter code like USD');
    const family = createFamily(db, { name, userId: req.user.id, currency });
    db.prepare('UPDATE sessions SET active_family_id = ? WHERE token = ?').run(family.id, req.session.token);
    hub.rebindSession(req.session.token, family.id);
    res.status(201).json(familyPayload(db, family, 'admin'));
  });

  r.post('/join', (req, res) => {
    const code = String(req.body?.invite_code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) throw httpError(400, 'Please enter an invite code');
    const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    const family = db.prepare('SELECT * FROM families WHERE invite_code = ?').get(formatted);
    if (!family) throw httpError(404, 'That invite code does not match any family');
    let membership = getMembership(db, family.id, req.user.id);
    if (!membership) {
      db.prepare("INSERT INTO memberships (family_id, user_id, role) VALUES (?, ?, 'member')").run(family.id, req.user.id);
      membership = { role: 'member' };
      logActivity({ familyId: family.id, userId: req.user.id, module: 'family', verb: 'joined', summary: 'joined the family', link: '/family' });
      hub.broadcast(family.id, 'family.member.joined', { user: req.user });
    }
    db.prepare('UPDATE sessions SET active_family_id = ? WHERE token = ?').run(family.id, req.session.token);
    hub.rebindSession(req.session.token, family.id);
    res.json(familyPayload(db, family, membership.role));
  });

  r.post('/:id/activate', (req, res) => {
    const id = toId(req.params.id, 'family id');
    const membership = getMembership(db, id, req.user.id);
    if (!membership) throw httpError(404, 'Family not found');
    db.prepare('UPDATE sessions SET active_family_id = ? WHERE token = ?').run(id, req.session.token);
    hub.rebindSession(req.session.token, id);
    const family = db.prepare('SELECT * FROM families WHERE id = ?').get(id);
    res.json(familyPayload(db, family, membership.role));
  });

  return r;
}

/** /api/family — the active family (requireAuth + requireFamily). */
export function familyRouter(ctx) {
  const { db, hub, auth, logActivity, coverUpload, removeFile } = ctx;
  const { requireAdmin } = auth;
  const r = Router();

  const reload = (req) => db.prepare('SELECT * FROM families WHERE id = ?').get(req.family.id);
  const changed = (familyId, extra = {}) => hub.broadcast(familyId, 'family.updated', extra);

  r.get('/', (req, res) => res.json(familyPayload(db, req.family, req.role)));

  r.get('/members', (req, res) => res.json(listMembers(db, req.family.id)));

  r.patch('/', requireAdmin, (req, res) => {
    const b = req.body ?? {};
    const updates = {};
    if ('name' in b) updates.name = cleanStr(b.name, { field: 'Family name', required: true, max: 80 });
    if ('currency' in b) {
      const c = String(b.currency ?? '').toUpperCase();
      if (!CURRENCY.test(c)) throw httpError(400, 'Currency must be a 3-letter code like USD');
      updates.currency = c;
    }
    if ('cover_url' in b && b.cover_url === null) {
      if (req.family.cover_url) removeFile(req.family.cover_url);
      updates.cover_url = null;
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(`UPDATE families SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => updates[k]), req.family.id);
      changed(req.family.id);
    }
    res.json(familyPayload(db, reload(req), req.role));
  });

  r.post('/cover', requireAdmin, coverUpload.single('file'), (req, res) => {
    if (!req.file) throw httpError(400, 'Please choose an image');
    const old = req.family.cover_url;
    db.prepare('UPDATE families SET cover_url = ? WHERE id = ?').run(req.file.url, req.family.id);
    if (old) removeFile(old);
    changed(req.family.id);
    res.json(familyPayload(db, reload(req), req.role));
  });

  r.post('/invite-code/rotate', requireAdmin, (req, res) => {
    db.prepare('UPDATE families SET invite_code = ? WHERE id = ?').run(uniqueInviteCode(db), req.family.id);
    changed(req.family.id);
    res.json(familyPayload(db, reload(req), req.role));
  });

  // Add a managed member (typically a child without their own login, or with a password set by the admin).
  r.post('/members', requireAdmin, (req, res) => {
    const b = req.body ?? {};
    const name = cleanStr(b.name, { field: 'Name', required: true, max: 80 });
    const role = b.role ?? 'child';
    if (!['child', 'member'].includes(role)) throw httpError(400, 'Role must be child or member');
    let email = cleanStr(b.email, { field: 'Email', max: 200 })?.toLowerCase() ?? null;
    const password = b.password ? String(b.password) : null;
    if (email && !isEmail(email)) throw httpError(400, 'Please enter a valid email address');
    if (email && !password) throw httpError(400, 'Set a password so they can sign in with that email');
    if (password && password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    if (b.birthday && !isDate(b.birthday)) throw httpError(400, 'Birthday must be YYYY-MM-DD');
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw httpError(409, 'That email already has a Hearth account — share your invite code instead');
    }
    if (!email) email = `${crypto.randomBytes(6).toString('hex')}@${MANAGED_EMAIL_DOMAIN}`;
    const count = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE family_id = ?').get(req.family.id).n;
    const color = isColor(b.color) ? b.color : PALETTE[count % PALETTE.length];
    const hash = hashPassword(password ?? crypto.randomBytes(24).toString('hex'));
    const userId = tx(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (email, password_hash, name, color, birthday) VALUES (?, ?, ?, ?, ?)')
        .run(email, hash, name, color, b.birthday || null);
      db.prepare('INSERT INTO memberships (family_id, user_id, role) VALUES (?, ?, ?)').run(req.family.id, lastInsertRowid, role);
      return Number(lastInsertRowid);
    });
    logActivity({ familyId: req.family.id, userId: req.user.id, module: 'family', verb: 'added', entityId: userId, summary: `added ${name} to the family`, link: '/family' });
    hub.broadcast(req.family.id, 'family.member.joined', { user_id: userId });
    const member = listMembers(db, req.family.id).find((m) => m.id === userId);
    res.status(201).json(member);
  });

  r.patch('/members/:userId', requireAdmin, (req, res) => {
    const userId = toId(req.params.userId, 'user id');
    const current = getMembership(db, req.family.id, userId);
    if (!current) throw httpError(404, 'Member not found');
    const b = req.body ?? {};
    if ('role' in b) {
      if (!['admin', 'member', 'child'].includes(b.role)) throw httpError(400, 'Role must be admin, member or child');
      if (current.role === 'admin' && b.role !== 'admin') {
        const admins = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE family_id = ? AND role = 'admin'").get(req.family.id).n;
        if (admins <= 1) throw httpError(400, 'A family needs at least one admin');
      }
      db.prepare('UPDATE memberships SET role = ? WHERE family_id = ? AND user_id = ?').run(b.role, req.family.id, userId);
    }
    if ('nickname' in b) {
      db.prepare('UPDATE memberships SET nickname = ? WHERE family_id = ? AND user_id = ?')
        .run(cleanStr(b.nickname, { field: 'Nickname', max: 40 }), req.family.id, userId);
    }
    // Admins may edit managed members' profile basics.
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (isManagedEmail(target.email) || userId === req.user.id) {
      if ('name' in b) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanStr(b.name, { field: 'Name', required: true, max: 80 }), userId);
      if ('color' in b && isColor(b.color)) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(b.color, userId);
      if ('birthday' in b) {
        if (b.birthday && !isDate(b.birthday)) throw httpError(400, 'Birthday must be YYYY-MM-DD');
        db.prepare('UPDATE users SET birthday = ? WHERE id = ?').run(b.birthday || null, userId);
      }
    }
    changed(req.family.id, { user_id: userId });
    res.json(listMembers(db, req.family.id).find((m) => m.id === userId));
  });

  r.delete('/members/:userId', (req, res) => {
    const userId = toId(req.params.userId, 'user id');
    const self = userId === req.user.id;
    if (!self && req.role !== 'admin') throw httpError(403, 'Only family admins can remove members');
    const current = getMembership(db, req.family.id, userId);
    if (!current) throw httpError(404, 'Member not found');
    const total = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE family_id = ?').get(req.family.id).n;
    if (current.role === 'admin' && total > 1) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE family_id = ? AND role = 'admin'").get(req.family.id).n;
      if (admins <= 1) throw httpError(400, 'Make someone else an admin before leaving');
    }
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    db.prepare('DELETE FROM memberships WHERE family_id = ? AND user_id = ?').run(req.family.id, userId);
    db.prepare('UPDATE sessions SET active_family_id = NULL WHERE user_id = ? AND active_family_id = ?').run(userId, req.family.id);
    hub.detachUser(userId, req.family.id);
    logActivity({
      familyId: req.family.id,
      userId: self ? userId : req.user.id,
      module: 'family',
      verb: self ? 'left' : 'removed',
      entityId: userId,
      summary: self ? 'left the family' : `removed ${target.name} from the family`,
      link: '/family',
    });
    hub.broadcast(req.family.id, 'family.member.left', { user_id: userId });
    // Managed accounts that no longer belong anywhere are deleted (best effort).
    if (isManagedEmail(target.email)) {
      const others = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get(userId).n;
      if (!others) {
        try { db.prepare('DELETE FROM users WHERE id = ?').run(userId); } catch { /* referenced by module data */ }
      }
    }
    res.json({ ok: true });
  });

  return r;
}
