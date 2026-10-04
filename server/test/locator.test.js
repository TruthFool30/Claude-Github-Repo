import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';
import { distanceMeters, placeFor } from '../src/modules/locator/geo.js';
import { buildVisits } from '../src/modules/locator.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const HOME = { name: 'Home', icon: 'home', lat: 30.30052, lng: -97.75611, radius: 120 };
const SCHOOL = { name: 'School', icon: 'school', lat: 30.30921, lng: -97.74418, radius: 160 };
const OUTSIDE = { lat: 30.2849, lng: -97.7672 };

async function childIn(fx, name = 'Kid') {
  const kid = await registerUser(srv, { name });
  await kid.agent.post('/api/families/join', { invite_code: fx.family.invite_code });
  await fx.admin.agent.patch(`/api/family/members/${kid.user.id}`, { role: 'child' });
  return kid;
}

describe('geo helpers', () => {
  test('distance and place containment with exit margin', () => {
    const d = distanceMeters(HOME.lat, HOME.lng, SCHOOL.lat, SCHOOL.lng);
    assert.ok(d > 1400 && d < 1600, `distance ${d}`);
    const places = [{ id: 1, ...HOME }, { id: 2, ...SCHOOL }];
    assert.equal(placeFor(places, HOME.lat, HOME.lng)?.id, 1);
    assert.equal(placeFor(places, OUTSIDE.lat, OUTSIDE.lng), null);
    // 130 m north of home: outside the 120 m radius, but within the exit margin while already there.
    const lat130 = HOME.lat + 130 / 111320;
    assert.equal(placeFor(places, lat130, HOME.lng), null);
    assert.equal(placeFor(places, lat130, HOME.lng, 1)?.id, 1);
  });

  test('buildVisits merges consecutive check-ins at one place', () => {
    const t = (m) => new Date(Date.UTC(2026, 8, 29, 8, m)).toISOString();
    const rows = [
      { id: 1, place_id: 1, lat: HOME.lat, lng: HOME.lng, created_at: t(0), updated_at: t(5), source: 'live' },
      { id: 2, place_id: 1, lat: HOME.lat, lng: HOME.lng, created_at: t(10), updated_at: t(20), source: 'checkin', note: 'hi' },
      { id: 3, place_id: null, lat: OUTSIDE.lat, lng: OUTSIDE.lng, created_at: t(30), updated_at: t(31), source: 'live' },
      { id: 4, place_id: null, lat: OUTSIDE.lat + 0.0002, lng: OUTSIDE.lng, created_at: t(35), updated_at: t(40), source: 'live' },
      { id: 5, place_id: 2, lat: SCHOOL.lat, lng: SCHOOL.lng, created_at: t(50), updated_at: t(55), source: 'live' },
    ];
    const v = buildVisits(rows, new Map([[1, { id: 1, ...HOME }], [2, { id: 2, ...SCHOOL }]]));
    assert.equal(v.length, 3);
    assert.deepEqual(v[0].checkin_ids, [1, 2]);
    assert.equal(v[0].end, t(20));
    assert.equal(v[0].note, 'hi');
    assert.equal(v[0].checked_in, true);
    assert.equal(v[1].place, null);
    assert.equal(v[1].points, 2);
    assert.equal(v[2].place.name, 'School');
  });
});

describe('places', () => {
  test('CRUD, validation and defaults', async () => {
    const { admin } = await familyFixture(srv, 'Places');
    const a = admin.agent;
    const created = await a.post('/api/locator/places', { ...HOME, address: ' 1 Main St ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Home');
    assert.equal(created.body.radius, 120);
    assert.equal(created.body.address, '1 Main St');
    assert.equal(created.body.notify, true);
    assert.match(created.body.color, /^#[0-9A-F]{6}$/i);

    const bad = [
      [{ ...HOME, name: '' }, /Name is required/],
      [{ ...HOME, lat: 91 }, /Latitude/],
      [{ ...HOME, lng: 'abc' }, /Longitude must be a number/],
      [{ ...HOME, radius: 5 }, /Radius/],
      [{ ...HOME, radius: 9000 }, /Radius/],
      [{ ...HOME, icon: 'castle' }, /icon/],
      [{ ...HOME, color: 'red' }, /Color/],
      [{ ...HOME, notify: 'yes' }, /Notify/],
      [{ ...HOME, name: 'x'.repeat(61) }, /too long/],
      [{ name: 'No coords' }, /Latitude is required/],
    ];
    for (const [body, re] of bad) {
      const res = await a.post('/api/locator/places', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, re);
    }

    const recolored = await a.patch(`/api/locator/places/${created.body.id}`, { icon: 'school' });
    assert.equal(recolored.body.color, '#FFB224', 'changing the icon alone picks that icon’s color');
    assert.equal((await a.patch(`/api/locator/places/${created.body.id}`, { icon: 'work', color: '#30A46C' })).body.color, '#30A46C');
    const patched = await a.patch(`/api/locator/places/${created.body.id}`, { name: 'Our house', radius: 200, notify: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, 'Our house');
    assert.equal(patched.body.radius, 200);
    assert.equal(patched.body.notify, false);
    assert.equal(patched.body.lat, HOME.lat);
    assert.equal((await a.patch(`/api/locator/places/${created.body.id}`, { radius: 1 })).status, 400);

    const detail = await a.get(`/api/locator/places/${created.body.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.events, []);

    const list = await a.get('/api/locator/places');
    assert.equal(list.body.length, 1);

    assert.equal((await a.del(`/api/locator/places/${created.body.id}`)).status, 200);
    assert.equal((await a.get(`/api/locator/places/${created.body.id}`)).status, 404);
    assert.equal((await a.del(`/api/locator/places/${created.body.id}`)).status, 404);
    assert.equal((await a.get('/api/locator/places/abc')).status, 400);
  });

  test('children may add places but only change their own', async () => {
    const fx = await familyFixture(srv, 'Kids places');
    const kid = await childIn(fx);
    const adultPlace = (await fx.member.agent.post('/api/locator/places', HOME)).body;
    const kidPlace = await kid.agent.post('/api/locator/places', { ...SCHOOL, name: 'Best friend' });
    assert.equal(kidPlace.status, 201);
    assert.equal((await kid.agent.patch(`/api/locator/places/${adultPlace.id}`, { name: 'Mine' })).status, 403);
    assert.equal((await kid.agent.del(`/api/locator/places/${adultPlace.id}`)).status, 403);
    assert.equal((await kid.agent.patch(`/api/locator/places/${kidPlace.body.id}`, { name: 'Zoe’s house' })).status, 200);
    // Adults can manage anyone's places.
    assert.equal((await fx.member.agent.del(`/api/locator/places/${kidPlace.body.id}`)).status, 200);
    assert.equal((await kid.agent.del(`/api/locator/places/${adultPlace.id}`)).status, 403);
  });

  test('creating a place logs Wall activity and search finds it', async () => {
    const { admin } = await familyFixture(srv, 'Search');
    const p = (await admin.agent.post('/api/locator/places', { ...SCHOOL, name: 'Maple Grove Elementary', address: 'Exposition Blvd' })).body;
    const act = (await admin.agent.get('/api/activity?module=locator')).body;
    assert.ok(act.some((e) => e.summary === 'added the place Maple Grove Elementary' && e.link === `/locator/places/${p.id}`));
    const s = (await admin.agent.get('/api/search?q=maple')).body;
    const hit = s.results.find((r) => r.module === 'locator');
    assert.ok(hit);
    assert.equal(hit.link, `/locator/places/${p.id}`);
    const byAddr = (await admin.agent.get('/api/search?q=exposition')).body;
    assert.ok(byAddr.results.some((r) => r.module === 'locator'));
  });
});

describe('check-ins and geofences', () => {
  test('check-in validation', async () => {
    const { admin } = await familyFixture(srv, 'Validate');
    const bad = [
      [{}, /Latitude is required/],
      [{ lat: 10 }, /Longitude is required/],
      [{ lat: -91, lng: 0 }, /Latitude/],
      [{ lat: 0, lng: 181 }, /Longitude/],
      [{ lat: 0, lng: 0, source: 'gps' }, /Source/],
      [{ lat: 0, lng: 0, accuracy: -1 }, /Accuracy/],
      [{ lat: 0, lng: 0, battery: 120 }, /Battery/],
      [{ lat: 0, lng: 0, note: 'x'.repeat(141) }, /too long/],
      [{ lat: 0, lng: 0, note: 5 }, /Note must be text/],
    ];
    for (const [body, re] of bad) {
      const res = await admin.agent.post('/api/locator/checkins', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, re);
    }
  });

  test('arrivals and departures are detected, notified and logged', async () => {
    const fx = await familyFixture(srv, 'Geofence');
    const home = (await fx.admin.agent.post('/api/locator/places', HOME)).body;
    const school = (await fx.admin.agent.post('/api/locator/places', SCHOOL)).body;
    const m = fx.member.agent;

    const first = await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng, accuracy: 12.4, battery: 81 });
    assert.equal(first.status, 201);
    assert.equal(first.body.checkin.place_id, home.id);
    assert.equal(first.body.checkin.accuracy, 12);
    assert.equal(first.body.checkin.battery, 81);
    assert.deepEqual(first.body.transitions.map((t) => [t.kind, t.place_name]), [['arrived', 'Home']]);
    assert.equal(first.body.member.location.place.name, 'Home');

    const moved = await m.post('/api/locator/checkins', { lat: SCHOOL.lat, lng: SCHOOL.lng, note: 'Drop-off done' });
    assert.deepEqual(moved.body.transitions.map((t) => [t.kind, t.place_name]), [['left', 'Home'], ['arrived', 'School']]);

    const out = await m.post('/api/locator/checkins', OUTSIDE);
    assert.deepEqual(out.body.transitions.map((t) => t.kind), ['left']);
    assert.equal(out.body.member.location.place, null);
    assert.equal(out.body.member.location.nearest.name, 'Home');
    assert.ok(out.body.member.location.nearest.meters > 1000);

    // The admin was notified about every transition; the member (actor) was not.
    const notes = (await fx.admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'locator');
    const titles = notes.map((n) => n.title);
    // A single jump from Home to School is one notification, not two.
    assert.deepEqual(titles.slice().reverse(), ['Member arrived at Home', 'Member left Home and arrived at School', 'Member left School']);
    assert.equal(notes.find((n) => n.title === 'Member left Home and arrived at School').body, '“Drop-off done”');
    assert.equal(notes[0].link, `/locator/member/${fx.member.user.id}?c=${out.body.checkin.id}`);
    const own = (await m.get('/api/notifications')).body.items.filter((n) => n.module === 'locator');
    assert.equal(own.length, 0);

    // Wall activity: one entry per manual check-in.
    const act = (await m.get('/api/activity?module=locator')).body.map((a) => a.summary);
    assert.ok(act.includes('checked in at Home'));
    assert.ok(act.includes('checked in at School — “Drop-off done”'));
    assert.ok(act.includes('checked in'), 'far from every place: plain "checked in"');
    const near = await m.post('/api/locator/checkins', { lat: HOME.lat + 250 / 111320, lng: HOME.lng });
    assert.equal(near.body.member.location.place, null);
    const act2 = (await m.get('/api/activity?module=locator')).body.map((a) => a.summary);
    assert.ok(act2.includes('checked in near Home'));

    // Overview reflects the current location and recent events.
    const ov = (await fx.admin.agent.get('/api/locator')).body;
    const mem = ov.members.find((x) => x.id === fx.member.user.id);
    assert.equal(mem.sharing, true);
    assert.equal(mem.location.place, null);
    assert.equal(ov.places.length, 2);
    assert.equal(ov.recent.length, 4);
    assert.equal(ov.recent[0].kind, 'left');
    assert.equal(ov.recent[0].user.name, 'Member');
    const adminRow = ov.members.find((x) => x.id === fx.admin.user.id);
    assert.equal(adminRow.location, null);

    // Place detail shows visits there.
    const detail = (await fx.admin.agent.get(`/api/locator/places/${school.id}`)).body;
    assert.deepEqual(detail.events.map((e) => e.kind).sort(), ['arrived', 'left']);
  });

  test('places with notifications off do not notify, and "since" tracks the arrival', async () => {
    const fx = await familyFixture(srv, 'Quiet');
    await fx.admin.agent.post('/api/locator/places', { ...HOME, notify: false });
    const r = await fx.member.agent.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng, source: 'live' });
    assert.equal(r.body.transitions.length, 1);
    assert.equal(r.body.member.location.since, r.body.transitions[0].created_at);
    const notes = (await fx.admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'locator');
    assert.equal(notes.length, 0);
    // Live arrivals still show up on the Wall.
    const act = (await fx.admin.agent.get('/api/activity?module=locator')).body.map((a) => a.summary);
    assert.ok(act.includes('arrived at Home'));
  });

  test('continuous sharing merges reports from the same spot', async () => {
    const { admin } = await familyFixture(srv, 'Live');
    const a = admin.agent;
    const one = await a.post('/api/locator/checkins', { ...OUTSIDE, source: 'live' });
    assert.equal(one.status, 201);
    assert.equal(one.body.merged, false);
    const two = await a.post('/api/locator/checkins', { lat: OUTSIDE.lat + 0.0001, lng: OUTSIDE.lng, source: 'live', note: 'ignored' });
    assert.equal(two.status, 200);
    assert.equal(two.body.merged, true);
    assert.equal(two.body.checkin.id, one.body.checkin.id);
    assert.equal(two.body.checkin.note, null);
    const far = await a.post('/api/locator/checkins', { lat: OUTSIDE.lat + 0.01, lng: OUTSIDE.lng, source: 'live' });
    assert.equal(far.body.merged, false);
    const hist = (await a.get(`/api/locator/history/${admin.user.id}`)).body;
    assert.equal(hist.checkins.length, 2);
    // A live report with no place change logs nothing on the Wall.
    const act = (await a.get('/api/activity?module=locator')).body;
    assert.equal(act.length, 0);
  });
});

describe('history and privacy', () => {
  test('history returns visits, events and stats for 1–7 days', async () => {
    const fx = await familyFixture(srv, 'History');
    await fx.admin.agent.post('/api/locator/places', HOME);
    await fx.admin.agent.post('/api/locator/places', SCHOOL);
    const m = fx.member.agent;
    await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng });
    await m.post('/api/locator/checkins', { lat: HOME.lat + 0.0003, lng: HOME.lng });
    await m.post('/api/locator/checkins', { lat: SCHOOL.lat, lng: SCHOOL.lng });
    const h = await fx.admin.agent.get(`/api/locator/history/${fx.member.user.id}?days=3`);
    assert.equal(h.status, 200);
    assert.equal(h.body.days, 3);
    assert.equal(h.body.hidden, false);
    assert.equal(h.body.checkins.length, 3);
    assert.equal(h.body.visits.length, 2);
    assert.equal(h.body.visits[0].place.name, 'Home');
    assert.equal(h.body.visits[0].points, 2);
    assert.equal(h.body.events.length, 3);
    assert.equal(h.body.stats.places_visited, 2);
    assert.ok(h.body.stats.meters > 1400);
    assert.equal((await fx.admin.agent.get(`/api/locator/history/${fx.member.user.id}?days=8`)).status, 400);
    assert.equal((await fx.admin.agent.get(`/api/locator/history/${fx.member.user.id}?days=0`)).status, 400);
    assert.equal((await fx.admin.agent.get('/api/locator/history/999999')).status, 404);
    const ev = await fx.admin.agent.get('/api/locator/events?hours=24');
    assert.equal(ev.body.length, 3);
    assert.equal((await fx.admin.agent.get('/api/locator/events?hours=0')).status, 400);
  });

  test('pausing sharing hides location and history from others and blocks check-ins', async () => {
    const fx = await familyFixture(srv, 'Privacy');
    await fx.admin.agent.post('/api/locator/places', HOME);
    const m = fx.member.agent;
    await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng });
    assert.deepEqual((await m.get('/api/locator/settings')).body.sharing, true);

    assert.equal((await m.patch('/api/locator/settings', { sharing: 'no' })).status, 400);
    const paused = await m.patch('/api/locator/settings', { sharing: false });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.sharing, false);
    assert.ok(paused.body.changed_at);

    const blocked = await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /paused/);

    const ov = (await fx.admin.agent.get('/api/locator')).body;
    const row = ov.members.find((x) => x.id === fx.member.user.id);
    assert.equal(row.sharing, false);
    assert.equal(row.location, null);
    assert.equal(ov.recent.length, 0);
    const h = (await fx.admin.agent.get(`/api/locator/history/${fx.member.user.id}`)).body;
    assert.equal(h.hidden, true);
    assert.equal(h.checkins.length, 0);
    const dash = (await fx.admin.agent.get('/api/dashboard')).body.locator;
    assert.ok(!dash.members.some((x) => x.user_id === fx.member.user.id));

    // The member still sees their own data.
    const mine = (await m.get('/api/locator')).body;
    assert.equal(mine.me.sharing, false);
    assert.ok(mine.members.find((x) => x.id === fx.member.user.id).location);
    assert.equal((await m.get(`/api/locator/history/${fx.member.user.id}`)).body.checkins.length, 1);

    await m.patch('/api/locator/settings', { sharing: true });
    const back = (await fx.admin.agent.get('/api/locator')).body.members.find((x) => x.id === fx.member.user.id);
    assert.equal(back.location.place.name, 'Home');
  });

  test('members delete their own check-ins and clear history', async () => {
    const fx = await familyFixture(srv, 'Delete');
    const c1 = (await fx.member.agent.post('/api/locator/checkins', OUTSIDE)).body.checkin;
    await fx.member.agent.post('/api/locator/checkins', { lat: OUTSIDE.lat + 0.02, lng: OUTSIDE.lng });
    assert.equal((await fx.admin.agent.del(`/api/locator/checkins/${c1.id}`)).status, 403);
    assert.equal((await fx.member.agent.del(`/api/locator/checkins/${c1.id}`)).status, 200);
    assert.equal((await fx.member.agent.del(`/api/locator/checkins/${c1.id}`)).status, 404);
    let h = (await fx.member.agent.get(`/api/locator/history/${fx.member.user.id}`)).body;
    assert.equal(h.checkins.length, 1);
    const cleared = await fx.member.agent.del('/api/locator/history');
    assert.equal(cleared.body.deleted, 1);
    h = (await fx.member.agent.get(`/api/locator/history/${fx.member.user.id}`)).body;
    assert.equal(h.checkins.length, 0);
    const ov = (await fx.admin.agent.get('/api/locator')).body;
    assert.equal(ov.members.find((x) => x.id === fx.member.user.id).location, null);
  });
});

describe('family isolation', () => {
  test('another family cannot see or touch places, check-ins or members', async () => {
    const a = await familyFixture(srv, 'Iso A');
    const b = await familyFixture(srv, 'Iso B');
    const place = (await a.admin.agent.post('/api/locator/places', HOME)).body;
    const c = (await a.member.agent.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng })).body.checkin;

    const x = b.admin.agent;
    assert.equal((await x.get(`/api/locator/places/${place.id}`)).status, 404);
    assert.equal((await x.patch(`/api/locator/places/${place.id}`, { name: 'Hacked' })).status, 404);
    assert.equal((await x.del(`/api/locator/places/${place.id}`)).status, 404);
    assert.equal((await x.del(`/api/locator/checkins/${c.id}`)).status, 404);
    assert.equal((await x.get(`/api/locator/history/${a.member.user.id}`)).status, 404);
    const ov = (await x.get('/api/locator')).body;
    assert.equal(ov.places.length, 0);
    assert.equal(ov.recent.length, 0);
    assert.ok(!ov.members.some((m) => m.id === a.member.user.id));
    assert.equal((await x.get('/api/search?q=home')).body.results.filter((r) => r.module === 'locator').length, 0);

    // A place in family B does not capture family A's check-ins.
    await x.post('/api/locator/places', { ...SCHOOL, name: 'B school' });
    const r = await a.member.agent.post('/api/locator/checkins', { lat: SCHOOL.lat, lng: SCHOOL.lng });
    assert.equal(r.body.member.location.place, null);

    // Pinned to family A via X-Family-Id, a non-member gets 403.
    x.familyId = a.family.id;
    assert.equal((await x.get('/api/locator')).status, 403);
    x.familyId = null;
    assert.equal((await srv.agent().get('/api/locator')).status, 401);
  });
});

describe('realtime', () => {
  test('mutations broadcast locator.* events to the family', async () => {
    const fx = await familyFixture(srv, 'Live events');
    const types = ['locator.place.created', 'locator.place.updated', 'locator.checkin', 'locator.settings.updated', 'locator.checkin.deleted', 'locator.history.cleared', 'locator.place.deleted'];
    const seen = [];
    const { events } = await collectEvents(fx.admin.agent, {
      timeoutMs: 5000,
      until: (e) => { if (e.type.startsWith('locator.')) seen.push(e.type); return seen.length >= types.length; },
    });
    const m = fx.member.agent;
    const p = (await m.post('/api/locator/places', HOME)).body;
    await m.patch(`/api/locator/places/${p.id}`, { name: 'Casa' });
    const c = (await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng })).body.checkin;
    await m.patch('/api/locator/settings', { sharing: true });
    await m.del(`/api/locator/checkins/${c.id}`);
    await m.del('/api/locator/history');
    await m.del(`/api/locator/places/${p.id}`);
    const all = await events;
    const loc = all.filter((e) => e.type.startsWith('locator.'));
    assert.deepEqual(loc.map((e) => e.type), types);
    const checkin = loc.find((e) => e.type === 'locator.checkin');
    assert.equal(checkin.payload.user_id, fx.member.user.id);
    assert.equal(checkin.payload.transitions[0].kind, 'arrived');
    // The admin also got a live notification about the arrival.
    assert.ok(all.some((e) => e.type === 'notification' && e.payload.title === 'Member arrived at Casa'));
  });

  test('other families do not receive events', async () => {
    const a = await familyFixture(srv, 'RT A');
    const b = await familyFixture(srv, 'RT B');
    const { events } = await collectEvents(b.admin.agent, { timeoutMs: 800, until: (e) => e.type.startsWith('locator.') });
    await a.admin.agent.post('/api/locator/places', HOME);
    const got = await events;
    assert.equal(got.filter((e) => e.type.startsWith('locator.')).length, 0);
  });
});

describe('seed and dashboard', () => {
  test('demo seed creates places, history and a lively current state', async () => {
    const { familyId, users } = await seedDemo(srv.ctx, undefined, { log: () => {} });
    const places = srv.db.prepare('SELECT * FROM locator_places WHERE family_id = ?').all(familyId);
    assert.ok(places.length >= 8);
    assert.ok(places.some((p) => p.name === 'Home'));
    const alex = srv.agent();
    const login = await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
    assert.equal(login.status, 200);
    alex.familyId = familyId;
    const ov = (await alex.get('/api/locator')).body;
    assert.equal(ov.members.length, 4);
    for (const m of ov.members) assert.ok(m.location, `${m.name} has a location`);
    const byName = Object.fromEntries(ov.members.map((m) => [m.name.split(' ')[0], m]));
    assert.equal(byName.Sam.location.source, 'checkin');
    assert.ok(byName.Sam.location.note, 'Sam checked in with a note');
    for (const m of ov.members) assert.ok(Date.now() - Date.parse(m.location.updated_at) < 15 * 60e3, `${m.name} updated recently`);
    assert.ok(ov.members.some((m) => m.location.place), 'someone is at a saved place');

    const hist = (await alex.get(`/api/locator/history/${users.mia.id}`)).body;
    assert.ok(hist.visits.length > 10, `mia visits: ${hist.visits.length}`);
    const days = new Set(hist.visits.map((v) => v.start.slice(0, 10)));
    assert.ok(days.size >= 6, `history spans ${days.size} days`);

    const dash = (await alex.get('/api/dashboard')).body.locator;
    assert.equal(dash.members.length, 4);
    const act = (await alex.get('/api/activity?module=locator')).body;
    assert.ok(act.length >= 1, 'recent arrivals on the Wall');

    // Re-seeding is clean (no duplicates).
    const again = await seedDemo(srv.ctx, undefined, { log: () => {} });
    const n = srv.db.prepare('SELECT COUNT(*) AS n FROM locator_places WHERE family_id = ?').get(again.familyId).n;
    assert.equal(n, places.length);
    if (again.familyId !== familyId) {
      assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM locator_places WHERE family_id = ?').get(familyId).n, 0);
    }
    const orphans = srv.db.prepare('SELECT COUNT(*) AS n FROM locator_checkins WHERE family_id NOT IN (SELECT id FROM families)').get().n;
    assert.equal(orphans, 0);
  });
});

describe('privacy cleanup of shared traces', () => {
  async function setup(name) {
    const fx = await familyFixture(srv, name);
    await fx.admin.agent.post('/api/locator/places', HOME);
    await fx.admin.agent.post('/api/locator/places', SCHOOL);
    const m = fx.member.agent;
    const c1 = (await m.post('/api/locator/checkins', { lat: HOME.lat, lng: HOME.lng })).body.checkin;
    const c2 = (await m.post('/api/locator/checkins', { lat: SCHOOL.lat, lng: SCHOOL.lng, source: 'live' })).body.checkin;
    return { fx, m, c1, c2 };
  }
  const memberActs = async (fx) => (await fx.admin.agent.get('/api/activity?module=locator')).body.filter((a) => a.user_id === fx.member.user.id);
  const memberNotes = async (fx) => (await fx.admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'locator' && n.link?.startsWith(`/locator/member/${fx.member.user.id}`));

  test('pausing removes the member’s check-ins/arrivals from the Wall and others’ notifications', async () => {
    const { fx, m } = await setup('Scrub pause');
    await m.post('/api/locator/places', { ...HOME, name: 'Park', lat: 30.25, lng: -97.7 });
    assert.equal((await memberActs(fx)).filter((a) => a.verb !== 'created').length, 2);
    assert.equal((await memberNotes(fx)).length, 2);
    const seen = [];
    const { events } = await collectEvents(fx.admin.agent, { timeoutMs: 3000, until: (e) => { seen.push(e.type); return seen.filter((t) => t === 'activity.removed').length >= 2 && seen.includes('notification.removed'); } });
    await m.patch('/api/locator/settings', { sharing: false });
    const got = await events;
    assert.equal(got.filter((e) => e.type === 'activity.removed').length, 2);
    assert.equal(got.find((e) => e.type === 'notification.removed').payload.ids.length, 2);
    const left = await memberActs(fx);
    assert.deepEqual(left.map((a) => a.verb), ['created'], 'only the non-location "added the place" entry remains');
    assert.equal((await memberNotes(fx)).length, 0);
  });

  test('clearing history removes activity + notifications; deleting one check-in removes only its traces', async () => {
    const { fx, m, c1, c2 } = await setup('Scrub clear');
    assert.equal((await m.del(`/api/locator/checkins/${c1.id}`)).status, 200);
    const acts = await memberActs(fx);
    assert.deepEqual(acts.map((a) => a.entity_id), [c2.id]);
    const notes = await memberNotes(fx);
    assert.deepEqual(notes.map((n) => n.link), [`/locator/member/${fx.member.user.id}?c=${c2.id}`]);
    await m.del('/api/locator/history');
    assert.equal((await memberActs(fx)).length, 0);
    assert.equal((await memberNotes(fx)).length, 0);
  });

  test('a child pausing notifies admins without any location', async () => {
    const fx = await familyFixture(srv, 'Child pause');
    const kid = await childIn(fx, 'Zoe');
    await kid.agent.patch('/api/locator/settings', { sharing: false });
    const notes = (await fx.admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'locator');
    assert.equal(notes[0].title, 'Zoe paused location sharing');
    assert.equal(notes[0].body, null);
    assert.equal(notes[0].link, '/locator');
    // Adults pausing don't alert anyone.
    await fx.member.agent.patch('/api/locator/settings', { sharing: false });
    assert.equal((await fx.admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'locator').length, 1);
  });

  test('location data of someone who left the family is removed', async () => {
    const { fx } = await setup('Departed');
    assert.equal((await fx.member.agent.del(`/api/family/members/${fx.member.user.id}`)).status, 200);
    // Removed immediately by the onMemberLeft hook (no page visit needed).
    const n = srv.db.prepare('SELECT COUNT(*) AS n FROM locator_checkins WHERE family_id = ? AND user_id = ?').get(fx.family.id, fx.member.user.id).n;
    assert.equal(n, 0);
    const e = srv.db.prepare('SELECT COUNT(*) AS n FROM locator_events WHERE family_id = ? AND user_id = ?').get(fx.family.id, fx.member.user.id).n;
    assert.equal(e, 0);
  });
});
