import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, registerUser } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

describe('auth', () => {
  test('register creates user + session cookie, no family by default', async () => {
    const agent = srv.agent();
    const res = await agent.post('/api/auth/register', { name: 'Jo', email: 'JO@Example.test', password: 'secret123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'jo@example.test');
    assert.equal(res.body.user.password_hash, undefined);
    assert.match(res.body.user.color, /^#[0-9A-F]{6}$/i);
    assert.deepEqual(res.body.families, []);
    assert.ok(agent.cookie.startsWith('hearth_session='));
    const me = await agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.name, 'Jo');
    assert.equal(me.body.active_family_id, null);
  });

  test('register with family_name creates family as admin', async () => {
    const { agent, families } = await registerUser(srv, { family_name: 'Smiths' });
    assert.equal(families.length, 1);
    assert.equal(families[0].role, 'admin');
    const me = await agent.get('/api/auth/me');
    assert.equal(me.body.active_family_id, families[0].id);
  });

  test('validation errors', async () => {
    const a = srv.agent();
    assert.equal((await a.post('/api/auth/register', { name: '', email: 'x@y.z', password: 'secret123' })).status, 400);
    assert.equal((await a.post('/api/auth/register', { name: 'X', email: 'nope', password: 'secret123' })).status, 400);
    assert.equal((await a.post('/api/auth/register', { name: 'X', email: 'short@y.z', password: '123' })).status, 400);
    const dup = await a.post('/api/auth/register', { name: 'X', email: 'jo@example.test', password: 'secret123' });
    assert.equal(dup.status, 409);
    assert.ok(dup.body.error);
  });

  test('login / logout / me', async () => {
    const a = srv.agent();
    const anon = await a.get('/api/auth/me');
    assert.equal(anon.status, 200);
    assert.equal(anon.body.user, null);
    const bad = await a.post('/api/auth/login', { email: 'jo@example.test', password: 'wrong' });
    assert.equal(bad.status, 401);
    const ok = await a.post('/api/auth/login', { email: 'jo@example.test', password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Jo');
    assert.equal((await a.get('/api/auth/me')).status, 200);
    assert.equal((await a.post('/api/auth/logout')).status, 200);
    assert.equal((await a.get('/api/auth/me')).body.user, null);
    assert.equal((await a.get('/api/family')).status, 401);
  });

  test('bearer token works as an alternative to the cookie', async () => {
    const a = srv.agent();
    await a.post('/api/auth/login', { email: 'jo@example.test', password: 'secret123' });
    const token = a.cookie.split('=')[1];
    const res = await fetch(`${srv.base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
  });

  test('update profile and password', async () => {
    const { agent, user } = await registerUser(srv, { password: 'first123' });
    const upd = await agent.patch('/api/auth/me', { name: 'New Name', color: '#30A46C', birthday: '2001-02-03', phone: '555' });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.user.name, 'New Name');
    assert.equal(upd.body.user.color, '#30A46C');
    assert.equal(upd.body.user.birthday, '2001-02-03');
    assert.equal((await agent.patch('/api/auth/me', { color: 'red' })).status, 400);
    assert.equal((await agent.patch('/api/auth/me', { birthday: '03/02/2001' })).status, 400);
    assert.equal((await agent.patch('/api/auth/me', { password: 'second123', current_password: 'nope' })).status, 400);
    assert.equal((await agent.patch('/api/auth/me', { password: 'second123', current_password: 'first123' })).status, 200);
    const b = srv.agent();
    assert.equal((await b.post('/api/auth/login', { email: user.email, password: 'first123' })).status, 401);
    assert.equal((await b.post('/api/auth/login', { email: user.email, password: 'second123' })).status, 200);
  });

  test('protected routes require auth and a family', async () => {
    const anon = srv.agent();
    assert.equal((await anon.get('/api/family')).status, 401);
    assert.equal((await anon.get('/api/lists')).status, 401);
    const { agent } = await registerUser(srv);
    const res = await agent.get('/api/family');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NO_FAMILY');
  });

  test('unknown api route is JSON 404', async () => {
    const res = await srv.agent().get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  test('malformed JSON is a 400', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });
});
