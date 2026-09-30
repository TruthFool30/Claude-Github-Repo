import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { startServer, familyFixture } from './helpers.js';
import { dateIn, isValidTz, offsetMinutes } from '../src/time.js';

test('time helpers: validation, local dates and offsets', () => {
  assert.equal(isValidTz('America/Denver'), true);
  assert.equal(isValidTz('Not/AZone'), false);
  assert.equal(isValidTz('<script>'), false);
  const instant = new Date('2026-03-01T03:30:00Z'); // still Feb 28 in the Americas
  assert.equal(dateIn('UTC', instant), '2026-03-01');
  assert.equal(dateIn('America/Los_Angeles', instant), '2026-02-28');
  assert.equal(dateIn('Asia/Tokyo', instant), '2026-03-01');
  assert.equal(offsetMinutes('Asia/Kolkata', instant), 330);
  assert.equal(offsetMinutes('America/Los_Angeles', instant), -480);
});

// A module that echoes what ctx.time sees for the request.
let seenCtx;
const echo = {
  name: 'tzecho',
  migrations: [],
  router: (ctx) => {
    seenCtx = ctx;
    const r = Router();
    r.get('/', (req, res) => res.json({ tz: ctx.time.tz(req), today: ctx.time.today(req) }));
    return r;
  },
};

test('X-Timezone sets req.tz/req.today, is remembered per user and drives familyTz', async () => {
  const srv = await startServer({ modules: [echo] });
  try {
    const { admin, member, family } = await familyFixture(srv);
    const a = await admin.agent.get('/api/tzecho', { headers: { 'x-timezone': 'Pacific/Auckland' } });
    assert.equal(a.status, 200);
    assert.equal(a.body.tz, 'Pacific/Auckland');
    assert.equal(a.body.today, dateIn('Pacific/Auckland'));
    // remembered: a later request without the header still uses it
    const b = await admin.agent.get('/api/tzecho');
    assert.equal(b.body.tz, 'Pacific/Auckland');
    // invalid header ignored
    const c = await admin.agent.get('/api/tzecho', { headers: { 'x-timezone': 'Mars/Olympus' } });
    assert.equal(c.body.tz, 'Pacific/Auckland');
    // background-job helpers
    assert.equal(seenCtx.time.tzOf(admin.user.id), 'Pacific/Auckland');
    await member.agent.get('/api/tzecho', { headers: { 'x-timezone': 'Pacific/Auckland' } });
    assert.equal(seenCtx.time.familyTz(family.id), 'Pacific/Auckland');
    assert.equal(seenCtx.time.todayForFamily(family.id), dateIn('Pacific/Auckland'));
  } finally {
    await srv.close();
  }
});
