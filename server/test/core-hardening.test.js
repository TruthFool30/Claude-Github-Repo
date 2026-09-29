import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { startServer, familyFixture, registerUser, collectEvents, PNG_1X1 } from './helpers.js';
import { modules as realModules } from '../src/modules/index.js';
import { isDate, cleanStr } from '../src/util.js';
import { tx } from '../src/db.js';
import { seedDemo, DEMO_INVITE_CODE } from '../src/seed.js';

// Probe module: notifications + uploads that fail validation.
const probe = {
  name: 'probe',
  migrations: [`CREATE TABLE IF NOT EXISTS probe_rows (id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL, v TEXT)`],
  router(ctx) {
    const r = Router();
    r.post('/ping', (req, res) => {
      ctx.notify({ familyId: req.family.id, userIds: req.body.user_ids, module: 'probe', title: 'Ping' });
      res.json({ ok: true });
    });
    r.post('/write', (req, res) => {
      ctx.db.prepare('INSERT INTO probe_rows (family_id, v) VALUES (?, ?)').run(req.family.id, req.body.v);
      res.json({ family_id: req.family.id });
    });
    r.post('/upload-reject', ctx.upload.single('file'), (req, res) => res.status(400).json({ error: 'nope' }));
    r.post('/upload-throw', ctx.upload.single('file'), () => { throw ctx.httpError(422, 'bad'); });
    r.post('/upload-ok', ctx.upload.single('file'), (req, res) => res.json({ url: req.file.url }));
    return r;
  },
};

let srv;
before(async () => { srv = await startServer({ modules: [...realModules, probe] }); });
after(() => srv.close());

const uploadFiles = (familyId) => {
  const dir = path.join(srv.dir, 'uploads', String(familyId));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('hardening', () => {
  test('(3) notifications are delivered only to streams viewing that family', async () => {
    const a = await familyFixture(srv, 'A');
    const b = await familyFixture(srv, 'B');
    // a.member also belongs to B, and currently views B
    await a.member.agent.post('/api/families/join', { invite_code: b.family.invite_code });
    const viewingB = a.member.agent.tab();
    viewingB.familyId = b.family.id;
    const viewingA = a.member.agent.tab();
    viewingA.familyId = a.family.id;
    const sB = await collectEvents(viewingB, { count: 1, timeoutMs: 700 });
    const sA = await collectEvents(viewingA, { until: (e) => e.type === 'notification', timeoutMs: 3000 });
    await a.admin.agent.post('/api/probe/ping', { user_ids: [a.member.user.id] });
    assert.equal((await sB.events).filter((e) => e.type === 'notification').length, 0);
    const got = (await sA.events).find((e) => e.type === 'notification');
    assert.equal(got.payload.family_id, a.family.id);
  });

  test('(4) X-Family-Id pins requests per tab; non-members are refused', async () => {
    const a = await familyFixture(srv, 'TabA');
    const b = await familyFixture(srv, 'TabB');
    await a.admin.agent.post('/api/families/join', { invite_code: b.family.invite_code }); // session default now B
    const tabA = a.admin.agent.tab();
    tabA.familyId = a.family.id;
    const tabB = a.admin.agent.tab();
    tabB.familyId = b.family.id;
    assert.equal((await tabA.get('/api/family')).body.id, a.family.id);
    assert.equal((await tabB.get('/api/family')).body.id, b.family.id);
    // switching the session default in one tab does not move the other tab
    await tabB.post(`/api/families/${b.family.id}/activate`);
    assert.equal((await tabA.post('/api/probe/write', { v: 'x' })).body.family_id, a.family.id);
    // no header -> session default
    assert.equal((await a.admin.agent.get('/api/family')).body.id, b.family.id);
    // a family you don't belong to
    const outsider = await familyFixture(srv, 'Outsider');
    const bad = a.admin.agent.tab();
    bad.familyId = outsider.family.id;
    const res = await bad.get('/api/family');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_MEMBER');
    bad.familyId = 'abc';
    assert.equal((await bad.get('/api/family')).status, 403);
    // stream bound per tab via ?family_id
    const s = await collectEvents(tabA, { count: 1, timeoutMs: 700 });
    srv.ctx.broadcast(b.family.id, 'probe.b', {});
    assert.equal((await s.events).length, 0);
    const bs = await fetch(`${srv.base}/api/stream?family_id=${outsider.family.id}`, { headers: { cookie: a.admin.agent.cookie } });
    assert.equal(bs.status, 403);
  });

  test('(6) password change ends other sessions\' streams', async () => {
    const { agent, user } = await registerUser(srv, { family_name: 'Pw', password: 'secret123' });
    const other = srv.agent();
    await other.post('/api/auth/login', { email: user.email, password: 'secret123' });
    const stream = await collectEvents(other, { until: (e) => e.type === 'session.ended', timeoutMs: 3000 });
    await agent.patch('/api/auth/me', { password: 'newpass123', current_password: 'secret123' });
    const events = await stream.events;
    assert.ok(events.some((e) => e.type === 'session.ended'));
    assert.equal((await other.get('/api/family')).status, 401);
    assert.equal((await agent.get('/api/family')).status, 200);
  });

  test('(8) leaving: sole admin must promote; last login member deletes family; DELETE /api/family', async () => {
    const { admin, member, family } = await familyFixture(srv, 'Leave');
    assert.equal((await admin.agent.del(`/api/family/members/${admin.user.id}`)).status, 400);
    // member leaves; now admin (plus a managed child) is the only login member
    await admin.agent.post('/api/family/members', { name: 'Kid' });
    await admin.agent.post('/api/probe/write', { v: 'data' });
    assert.equal((await member.agent.del(`/api/family/members/${member.user.id}`)).status, 200);
    const left = await admin.agent.del(`/api/family/members/${admin.user.id}`);
    assert.equal(left.status, 200);
    assert.equal(left.body.family_deleted, true);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM families WHERE id = ?').get(family.id).n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM probe_rows WHERE family_id = ?').get(family.id).n, 0);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Kid' AND email LIKE '%@managed.hearth.local'").get().n, 0);

    const f2 = await familyFixture(srv, 'Doomed');
    assert.equal((await f2.member.agent.del('/api/family', { body: { confirm_name: 'Doomed' } })).status, 403);
    assert.equal((await f2.admin.agent.del('/api/family', { body: { confirm_name: 'wrong' } })).status, 400);
    const stream = await collectEvents(f2.member.agent, { until: (e) => e.type === 'family.removed', timeoutMs: 3000 });
    const del = await f2.admin.agent.del('/api/family', { body: { confirm_name: 'doomed' } });
    assert.equal(del.status, 200);
    assert.ok((await stream.events).some((e) => e.type === 'family.removed'));
    assert.equal((await f2.member.agent.get('/api/family')).status, 403);
  });

  test('(9) changing email requires the current password', async () => {
    const { agent } = await registerUser(srv, { password: 'secret123' });
    assert.equal((await agent.patch('/api/auth/me', { email: 'new1@example.test' })).status, 400);
    assert.equal((await agent.patch('/api/auth/me', { email: 'new1@example.test', current_password: 'nope' })).status, 400);
    const ok = await agent.patch('/api/auth/me', { email: 'new1@example.test', current_password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, 'new1@example.test');
  });

  test('(10) managed placeholder emails are rejected', async () => {
    const res = await srv.agent().post('/api/auth/register', { name: 'X', email: 'abc@managed.hearth.local', password: 'secret123' });
    assert.equal(res.status, 400);
    const { agent } = await registerUser(srv, { password: 'secret123', family_name: 'M' });
    assert.equal((await agent.patch('/api/auth/me', { email: 'abc@managed.hearth.local', current_password: 'secret123' })).status, 400);
    assert.equal((await agent.post('/api/family/members', { name: 'K', email: 'k@managed.hearth.local', password: 'secret123' })).status, 400);
  });

  test('(11) invite code is visible to admins only', async () => {
    const { admin, member } = await familyFixture(srv, 'Codes');
    assert.match((await admin.agent.get('/api/family')).body.invite_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal((await member.agent.get('/api/family')).body.invite_code, null);
    const me = (await member.agent.get('/api/auth/me')).body;
    assert.ok(me.families.every((f) => f.invite_code === null));
  });

  test('(12) invite preview endpoint', async () => {
    const { admin, family } = await familyFixture(srv, 'Preview Fam');
    const anon = await srv.agent().get(`/api/families/invite/${family.invite_code.toLowerCase()}`);
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.body, { name: 'Preview Fam', member_count: 2, already_member: false, family_id: null });
    const mine = await admin.agent.get(`/api/families/invite/${family.invite_code}`);
    assert.equal(mine.body.already_member, true);
    assert.equal(mine.body.family_id, family.id);
    assert.equal((await srv.agent().get('/api/families/invite/ZZZZ-ZZZZ')).status, 404);
  });

  test('(15) strict validators', () => {
    assert.equal(isDate('2020-02-31'), false);
    assert.equal(isDate('2024-02-29'), true);
    assert.equal(isDate('2024-13-01'), false);
    assert.throws(() => cleanStr({ a: 1 }, { field: 'Name' }), /must be text/);
    assert.throws(() => cleanStr(['x'], { field: 'Name' }), /must be text/);
    assert.equal(cleanStr('  hi '), 'hi');
  });

  test('(15) API rejects non-string names and impossible dates', async () => {
    const { agent } = await registerUser(srv, { family_name: 'V' });
    assert.equal((await agent.patch('/api/auth/me', { name: { $ne: 1 } })).status, 400);
    assert.equal((await agent.patch('/api/auth/me', { birthday: '2021-02-30' })).status, 400);
  });

  test('(16) failed requests delete their uploaded files; tx is re-entrant', async () => {
    const { admin, family } = await familyFixture(srv, 'Files');
    await admin.agent.upload('/api/probe/upload-reject', { file: PNG_1X1 });
    await admin.agent.upload('/api/probe/upload-throw', { file: PNG_1X1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(uploadFiles(family.id).length, 0);
    const ok = await admin.agent.upload('/api/probe/upload-ok', { file: PNG_1X1 });
    assert.equal(ok.status, 200);
    assert.equal(uploadFiles(family.id).length, 1);

    const db = srv.db;
    tx(db, () => {
      db.prepare("INSERT INTO probe_rows (family_id, v) VALUES (0, 'outer')").run();
      assert.throws(() => tx(db, () => {
        db.prepare("INSERT INTO probe_rows (family_id, v) VALUES (0, 'inner')").run();
        throw new Error('inner fails');
      }));
      tx(db, () => db.prepare("INSERT INTO probe_rows (family_id, v) VALUES (0, 'inner-ok')").run());
    });
    const vals = db.prepare('SELECT v FROM probe_rows WHERE family_id = 0 ORDER BY id').all().map((r) => r.v);
    assert.deepEqual(vals, ['outer', 'inner-ok']);
  });

  test('(17) seeding only replaces the demo family', async () => {
    const quiet = { log: () => {} };
    await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    // Sam also creates their own family
    const sam = srv.agent();
    await sam.post('/api/auth/login', { email: 'sam@hearth.test', password: 'hearth123' });
    const own = (await sam.post('/api/families', { name: "Sam's Book Club" })).body;
    await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM families WHERE id = ?').get(own.id).n, 1);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM families WHERE invite_code = ?').get(DEMO_INVITE_CODE).n, 1);
    const again = srv.agent();
    await again.post('/api/auth/login', { email: 'sam@hearth.test', password: 'hearth123' });
    assert.equal((await again.get('/api/auth/me')).body.families.length, 2);
  });
});

describe('rate limiting (14)', () => {
  let limited;
  before(async () => {
    limited = await startServer({
      limits: {
        'login-email': { max: 3, windowMs: 60_000 },
        'register-ip': { max: 2, windowMs: 60_000 },
        'invite-ip': { max: 2, windowMs: 60_000 },
      },
    });
  });
  after(() => limited.close());

  test('login, register and invite lookup return 429 with a friendly message', async () => {
    const a = limited.agent();
    for (let i = 0; i < 3; i++) assert.equal((await a.post('/api/auth/login', { email: 'x@y.test', password: 'bad' })).status, 401);
    const blocked = await a.post('/api/auth/login', { email: 'x@y.test', password: 'bad' });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many attempts/);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // successful sign-ins never use up the budget
    await a.post('/api/auth/register', { name: 'Ok', email: 'ok@y.test', password: 'secret123' });
    for (let i = 0; i < 5; i++) assert.equal((await a.post('/api/auth/login', { email: 'ok@y.test', password: 'secret123' })).status, 200);
    // a different email is not blocked by the per-email rule
    assert.equal((await a.post('/api/auth/login', { email: 'other@y.test', password: 'bad' })).status, 401);
    assert.equal((await a.post('/api/auth/register', { name: 'A', email: 'a1@y.test', password: 'secret123' })).status, 201);
    assert.equal((await a.post('/api/auth/register', { name: 'A', email: 'a3@y.test', password: 'secret123' })).status, 429);
    await a.get('/api/families/invite/AAAA-AAAA');
    await a.get('/api/families/invite/AAAA-AAAA');
    assert.equal((await a.get('/api/families/invite/AAAA-AAAA')).status, 429);
  });
});
