import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('seed creates the Rivera family and is re-runnable', async () => {
  const quiet = { log: () => {} };
  await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
  const { familyId } = await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
  const alex = srv.agent();
  const login = await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: DEMO_PASSWORD });
  assert.equal(login.status, 200);
  const fam = (await alex.get('/api/family')).body;
  assert.equal(fam.id, familyId);
  assert.equal(fam.name, 'Rivera Family');
  assert.deepEqual(fam.members.map((m) => [m.name.split(' ')[0], m.role]), [['Alex', 'admin'], ['Sam', 'member'], ['Mia', 'child'], ['Leo', 'child']]);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM families').get().n, 1);
  const mia = srv.agent();
  assert.equal((await mia.post('/api/auth/login', { email: 'mia@hearth.test', password: DEMO_PASSWORD })).status, 200);
});
