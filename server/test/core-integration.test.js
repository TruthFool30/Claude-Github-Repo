import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, collectEvents } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('API JSON is compressed (br/gzip) while the SSE stream stays uncompressed and live', async () => {
  const { admin, family } = await familyFixture(srv, 'Zip');
  for (let i = 0; i < 40; i++) srv.ctx.logActivity({ familyId: family.id, userId: admin.user.id, module: 'lists', verb: 'created', summary: `made list number ${i}`, link: '/lists' });
  const headers = { cookie: admin.agent.cookie, 'x-family-id': String(family.id) };
  const br = await fetch(srv.base + '/api/activity?limit=40', { headers: { ...headers, 'accept-encoding': 'br, gzip' } });
  assert.equal(br.status, 200);
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.equal((await br.json()).length, 40);
  const gz = await fetch(srv.base + '/api/activity?limit=40', { headers: { ...headers, 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  await gz.arrayBuffer();

  // SSE: no content-encoding, and events still arrive promptly.
  const ctrl = new AbortController();
  const raw = await fetch(srv.base + '/api/stream', { headers: { ...headers, 'accept-encoding': 'br, gzip' }, signal: ctrl.signal });
  assert.equal(raw.headers.get('content-encoding'), null);
  assert.match(raw.headers.get('content-type'), /text\/event-stream/);
  ctrl.abort();
  admin.agent.familyId = family.id;
  const stream = await collectEvents(admin.agent, { timeoutMs: 2000, until: (e) => e.type === 'activity' });
  srv.ctx.logActivity({ familyId: family.id, userId: admin.user.id, module: 'lists', verb: 'created', summary: 'live one', link: '/lists' });
  const events = await stream.events;
  assert.equal(events.find((e) => e.type === 'activity')?.payload.summary, 'live one');
});

test('global search ignores punctuation: "wifi" finds "Wi-Fi", "wi fi" too', async () => {
  const { admin } = await familyFixture(srv, 'Search');
  const list = await admin.agent.post('/api/lists', { name: 'Guest Wi-Fi setup', type: 'todo' });
  assert.equal(list.status, 201);
  for (const q of ['wifi', 'WIFI', 'wi fi', 'Wi-Fi']) {
    const res = await admin.agent.get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.ok(res.body.results.some((r) => r.module === 'lists' && r.title.includes('Guest Wi-Fi setup')), `"${q}" matches`);
  }
  // Punctuation-only queries don't match everything.
  assert.equal((await admin.agent.get('/api/search?q=--')).body.results.length, 0);
});
