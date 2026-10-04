import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { startServer, registerUser, familyFixture } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

describe('families', () => {
  test('create, join with code, activate/switch', async () => {
    const { agent: alex } = await registerUser(srv, { name: 'Alex' });
    const created = await alex.post('/api/families', { name: 'Riveras' });
    assert.equal(created.status, 201);
    assert.equal(created.body.role, 'admin');
    assert.match(created.body.invite_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(created.body.members.length, 1);

    const { agent: sam } = await registerUser(srv, { name: 'Sam' });
    assert.equal((await sam.post('/api/families/join', { invite_code: 'ZZZZ-ZZZZ' })).status, 404);
    // codes are case/format-insensitive
    const joined = await sam.post('/api/families/join', { invite_code: created.body.invite_code.toLowerCase().replace('-', '') });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.role, 'member');
    assert.equal(joined.body.members.length, 2);
    // joining twice is harmless
    assert.equal((await sam.post('/api/families/join', { invite_code: created.body.invite_code })).status, 200);
    assert.equal((await alex.get('/api/family')).body.members.length, 2);

    // Sam creates a second family, then switches back
    const second = await sam.post('/api/families', { name: 'Sam Solo' });
    assert.equal((await sam.get('/api/family')).body.id, second.body.id);
    const me = await sam.get('/api/auth/me');
    assert.equal(me.body.families.length, 2);
    assert.equal((await sam.post(`/api/families/${created.body.id}/activate`)).status, 200);
    assert.equal((await sam.get('/api/family')).body.id, created.body.id);
    // cannot activate a family you don't belong to
    assert.equal((await alex.post(`/api/families/${second.body.id}/activate`)).status, 404);
  });

  test('admin can rename, set currency, rotate invite code; members cannot', async () => {
    const { admin, member, family } = await familyFixture(srv);
    const upd = await admin.agent.patch('/api/family', { name: 'Renamed', currency: 'eur' });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.name, 'Renamed');
    assert.equal(upd.body.currency, 'EUR');
    assert.equal((await admin.agent.patch('/api/family', { currency: 'EURO' })).status, 400);
    assert.equal((await member.agent.patch('/api/family', { name: 'Hack' })).status, 403);
    const rot = await admin.agent.post('/api/family/invite-code/rotate');
    assert.notEqual(rot.body.invite_code, family.invite_code);
    assert.equal((await member.agent.post('/api/family/invite-code/rotate')).status, 403);
    const late = await registerUser(srv);
    assert.equal((await late.agent.post('/api/families/join', { invite_code: family.invite_code })).status, 404);
  });

  test('member management: add child, change role, remove, leave', async () => {
    const { admin, member } = await familyFixture(srv);
    const child = await admin.agent.post('/api/family/members', { name: 'Kiddo', birthday: '2015-05-05' });
    assert.equal(child.status, 201);
    assert.equal(child.body.role, 'child');
    assert.equal(child.body.managed, true);
    assert.equal(child.body.email, null);
    assert.equal((await member.agent.post('/api/family/members', { name: 'Nope' })).status, 403);

    // child with login
    const teen = await admin.agent.post('/api/family/members', { name: 'Teen', email: 'teen@example.test', password: 'teen1234' });
    assert.equal(teen.status, 201);
    const teenAgent = srv.agent();
    assert.equal((await teenAgent.post('/api/auth/login', { email: 'teen@example.test', password: 'teen1234' })).status, 200);
    assert.equal((await teenAgent.get('/api/family')).body.role, 'child');
    assert.equal((await admin.agent.post('/api/family/members', { name: 'X', email: 'teen@example.test', password: 'abcdef' })).status, 409);

    // role changes
    const promoted = await admin.agent.patch(`/api/family/members/${member.user.id}`, { role: 'admin', nickname: 'Mum' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.role, 'admin');
    assert.equal(promoted.body.nickname, 'Mum');
    assert.equal((await admin.agent.patch(`/api/family/members/${member.user.id}`, { role: 'boss' })).status, 400);

    // removal
    assert.equal((await teenAgent.del(`/api/family/members/${member.user.id}`)).status, 403);
    assert.equal((await admin.agent.del(`/api/family/members/${child.body.id}`)).status, 200);
    let fam = (await admin.agent.get('/api/family')).body;
    assert.ok(!fam.members.some((m) => m.id === child.body.id));

    // self leave
    assert.equal((await teenAgent.del(`/api/family/members/${teen.body.id}`)).status, 200);
    assert.equal((await teenAgent.get('/api/family')).status, 403);
    fam = (await admin.agent.get('/api/family')).body;
    assert.equal(fam.members.length, 2);
  });

  test('last admin cannot be demoted or leave while others remain', async () => {
    const { admin, member } = await familyFixture(srv);
    assert.equal((await admin.agent.patch(`/api/family/members/${admin.user.id}`, { role: 'member' })).status, 400);
    assert.equal((await admin.agent.del(`/api/family/members/${admin.user.id}`)).status, 400);
    await admin.agent.patch(`/api/family/members/${member.user.id}`, { role: 'admin' });
    assert.equal((await admin.agent.del(`/api/family/members/${admin.user.id}`)).status, 200);
  });

  test('permission scoping: family A cannot see or touch family B', async () => {
    const a = await familyFixture(srv, 'Family A');
    const b = await familyFixture(srv, 'Family B');
    const famA = (await a.admin.agent.get('/api/family')).body;
    const famB = (await b.admin.agent.get('/api/family')).body;
    assert.notEqual(famA.id, famB.id);
    assert.ok(!famA.members.some((m) => famB.members.some((n) => n.id === m.id)));
    // can't activate B
    assert.equal((await a.admin.agent.post(`/api/families/${famB.id}/activate`)).status, 404);
    // can't manage B's members through own family endpoints
    assert.equal((await a.admin.agent.del(`/api/family/members/${b.member.user.id}`)).status, 404);
    assert.equal((await a.admin.agent.patch(`/api/family/members/${b.member.user.id}`, { role: 'child' })).status, 404);
    // activity & notifications are family-scoped
    const actA = (await a.admin.agent.get('/api/activity')).body;
    assert.ok(actA.every((x) => x.family_id === famA.id));
    // search only returns own members
    const s = (await a.admin.agent.get('/api/search?q=Member')).body;
    assert.ok(s.results.every((r) => famA.members.some((m) => m.id === r.avatar?.id)));
  });
});

test('modules receive onMemberJoined / onMemberLeft lifecycle hooks', async () => {
  const events = [];
  const mod = {
    name: 'hooks',
    migrations: [],
    router: () => Router(),
    onMemberJoined: (ctx, info) => events.push(['joined', info.userId, info.reason]),
    onMemberLeft: (ctx, info) => events.push(['left', info.userId, info.reason]),
  };
  const hsrv = await startServer({ modules: [mod] });
  try {
    const { admin, family } = await familyFixture(hsrv);
    const newbie = await registerUser(hsrv, { name: 'Newbie' });
    await newbie.agent.post('/api/families/join', { invite_code: family.invite_code });
    await admin.agent.del(`/api/family/members/${newbie.user.id}`);
    assert.deepEqual(events.filter((e) => e[1] === newbie.user.id), [['joined', newbie.user.id, 'joined'], ['left', newbie.user.id, 'removed']]);
  } finally {
    await hsrv.close();
  }
});
