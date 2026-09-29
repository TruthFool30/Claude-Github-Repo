import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { startServer, familyFixture, collectEvents } from './helpers.js';
import { modules as realModules } from '../src/modules/index.js';

// A fake extra module exercising the optional hooks.
const probe = {
  name: 'probe',
  migrations: [`CREATE TABLE IF NOT EXISTS probe_items (id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL, title TEXT NOT NULL)`],
  router(ctx) {
    const r = Router();
    r.post('/', (req, res) => {
      const { lastInsertRowid } = ctx.db.prepare('INSERT INTO probe_items (family_id, title) VALUES (?, ?)').run(req.family.id, req.body.title);
      ctx.logActivity({ familyId: req.family.id, userId: req.user.id, module: 'probe', verb: 'created', entityId: Number(lastInsertRowid), summary: `added ${req.body.title}`, link: '/probe' });
      ctx.broadcast(req.family.id, 'probe.created', { id: Number(lastInsertRowid) });
      res.status(201).json({ id: Number(lastInsertRowid) });
    });
    r.post('/ping', (req, res) => {
      ctx.notify({ familyId: req.family.id, userIds: req.body.user_ids, module: 'probe', title: 'Ping', body: 'hello', link: '/probe', excludeUserId: req.user.id });
      res.json({ ok: true });
    });
    r.get('/boom', () => { throw new Error('kaboom'); });
    r.get('/teapot', () => { throw ctx.httpError(418, 'short and stout'); });
    return r;
  },
  search(ctx, familyId, q) {
    return ctx.db.prepare('SELECT * FROM probe_items WHERE family_id = ? AND title LIKE ?').all(familyId, `%${q}%`)
      .map((row) => ({ title: row.title, subtitle: 'Probe', link: `/probe/${row.id}` }));
  },
  dashboard(ctx, req) {
    return { count: ctx.db.prepare('SELECT COUNT(*) AS n FROM probe_items WHERE family_id = ?').get(req.family.id).n };
  },
};
const broken = { name: 'broken', migrations: [], router: () => Router(), dashboard() { throw new Error('nope'); }, search() { throw new Error('nope'); } };

let srv;
before(async () => { srv = await startServer({ modules: [...realModules, probe, broken] }); });
after(() => srv.close());

describe('activity, notifications, realtime, search, dashboard', () => {
  test('module stubs are mounted behind auth + family', async () => {
    const { admin } = await familyFixture(srv);
    for (const m of realModules) {
      const res = await admin.agent.get(`/api/${m.name}`);
      assert.equal(res.status, 200, m.name);
    }
    assert.equal((await srv.agent().get('/api/wall')).status, 401);
  });

  test('activity feed with pagination and family scoping', async () => {
    const { admin, member } = await familyFixture(srv);
    for (let i = 0; i < 5; i++) await admin.agent.post('/api/probe', { title: `Thing ${i}` });
    const page1 = (await member.agent.get('/api/activity?limit=3')).body;
    assert.equal(page1.length, 3);
    assert.equal(page1[0].summary, 'added Thing 4');
    assert.equal(page1[0].user.name, 'Admin');
    assert.equal(page1[0].user.password_hash, undefined);
    const page2 = (await member.agent.get(`/api/activity?limit=3&before=${page1[2].id}`)).body;
    assert.ok(page2.length >= 2);
    assert.ok(page2[0].id < page1[2].id);
    const onlyProbe = (await member.agent.get('/api/activity?module=probe')).body;
    assert.ok(onlyProbe.every((a) => a.module === 'probe'));
    const other = await familyFixture(srv, 'Other');
    const otherFeed = (await other.admin.agent.get('/api/activity')).body;
    assert.ok(!otherFeed.some((a) => a.module === 'probe'));
  });

  test('notifications: create, list, mark read, never to outsiders', async () => {
    const { admin, member } = await familyFixture(srv);
    const outsider = await familyFixture(srv, 'Outsiders');
    await admin.agent.post('/api/probe/ping', { user_ids: [member.user.id, admin.user.id, outsider.admin.user.id] });
    const list = (await member.agent.get('/api/notifications')).body;
    assert.equal(list.unread, 1);
    assert.equal(list.items[0].title, 'Ping');
    assert.equal((await admin.agent.get('/api/notifications')).body.unread, 0, 'actor excluded');
    assert.equal((await outsider.admin.agent.get('/api/notifications')).body.items.length, 0);
    await member.agent.post('/api/notifications/read', { ids: [list.items[0].id] });
    assert.equal((await member.agent.get('/api/notifications')).body.unread, 0);
    await admin.agent.post('/api/probe/ping', { user_ids: [member.user.id] });
    await admin.agent.post('/api/probe/ping', { user_ids: [member.user.id] });
    assert.equal((await member.agent.get('/api/notifications')).body.unread, 2);
    await member.agent.post('/api/notifications/read', {});
    assert.equal((await member.agent.get('/api/notifications')).body.unread, 0);
  });

  test('SSE delivers family broadcasts, activity and per-user notifications', async () => {
    const { admin, member } = await familyFixture(srv);
    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'notification', timeoutMs: 4000 });
    await admin.agent.post('/api/probe', { title: 'Live' });
    await admin.agent.post('/api/probe/ping', { user_ids: [member.user.id] });
    const events = await stream.events;
    const types = events.map((e) => e.type);
    assert.ok(types.includes('activity'), types.join());
    assert.ok(types.includes('probe.created'), types.join());
    assert.ok(types.includes('notification'), types.join());
    assert.ok(events.every((e) => typeof e.at === 'string'));
  });

  test('SSE does not leak events across families', async () => {
    const a = await familyFixture(srv, 'A');
    const b = await familyFixture(srv, 'B');
    const stream = await collectEvents(b.member.agent, { count: 1, timeoutMs: 800 });
    await a.admin.agent.post('/api/probe', { title: 'Secret' });
    const events = await stream.events;
    assert.equal(events.length, 0);
  });

  test('search aggregates members and module hooks; failing hooks are ignored', async () => {
    const { admin } = await familyFixture(srv);
    await admin.agent.post('/api/probe', { title: 'Birthday cake' });
    const short = (await admin.agent.get('/api/search?q=b')).body;
    assert.deepEqual(short.results, []);
    const res = await admin.agent.get('/api/search?q=cake');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results.map((r) => [r.module, r.title]), [['probe', 'Birthday cake']]);
    const members = (await admin.agent.get('/api/search?q=memb')).body.results;
    assert.equal(members[0].module, 'family');
  });

  test('dashboard merges module hooks', async () => {
    const { admin } = await familyFixture(srv);
    await admin.agent.post('/api/probe', { title: 'x' });
    const res = await admin.agent.get('/api/dashboard');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.probe, { count: 1 });
    assert.equal(res.body.broken, null);
  });

  test('errors are JSON', async () => {
    const { admin } = await familyFixture(srv);
    const boom = await admin.agent.get('/api/probe/boom');
    assert.equal(boom.status, 500);
    assert.ok(boom.body.error);
    assert.ok(!boom.body.error.includes('kaboom'));
    const tea = await admin.agent.get('/api/probe/teapot');
    assert.equal(tea.status, 418);
    assert.equal(tea.body.error, 'short and stout');
  });
});
