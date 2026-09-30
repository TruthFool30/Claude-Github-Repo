import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, collectEvents } from './helpers.js';
import * as calendar from '../src/modules/calendar.js';
import { seedDemo } from '../src/seed.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const TZ = 'America/New_York';
const q = (o) => new URLSearchParams(o).toString();
const range = (agent, from, to, tz = TZ) => agent.get(`/api/calendar/events?${q({ from, to, tz })}`);

describe('events CRUD + validation', () => {
  let fam;
  before(async () => {
    fam = await familyFixture(srv, 'Crud');
  });

  test('create a timed event and read it back', async () => {
    const res = await fam.admin.agent.post('/api/calendar/events', {
      title: '  Dentist  ', start: '2030-03-05T15:30:00.000Z', end: '2030-03-05T16:30:00.000Z', tz: TZ,
      location: 'Bright Smile', notes: 'Bring card', attendees: [fam.member.user.id], reminders: [60, 10, 60],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Dentist');
    assert.equal(res.body.all_day, false);
    assert.deepEqual(res.body.reminders, [10, 60]);
    assert.deepEqual(res.body.attendees, [fam.member.user.id]);
    assert.equal(res.body.color, fam.admin.user.color, 'defaults to the creator color');
    assert.equal(res.body.custom_color, null);

    const one = await fam.member.agent.get(`/api/calendar/events/${res.body.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.occurrence.start, '2030-03-05T15:30:00.000Z');
    assert.equal(one.body.can_edit, true);

    const list = await range(fam.member.agent, '2030-03-01', '2030-03-10');
    assert.equal(list.status, 200);
    const hit = list.body.find((e) => e.event_id === res.body.id);
    assert.ok(hit);
    assert.equal(hit.id, String(res.body.id));
    assert.equal(hit.kind, 'event');
    assert.equal(hit.location, 'Bright Smile');
    // outside the range → not returned
    const none = await range(fam.member.agent, '2030-04-01', '2030-04-10');
    assert.ok(!none.body.some((e) => e.event_id === res.body.id));
  });

  test('all-day multi-day events overlap ranges by day', async () => {
    const res = await fam.admin.agent.post('/api/calendar/events', { title: 'Lake trip', all_day: true, start: '2030-05-10', end: '2030-05-13', tz: TZ });
    assert.equal(res.status, 201);
    const list = await range(fam.admin.agent, '2030-05-12', '2030-05-13');
    const hit = list.body.find((e) => e.event_id === res.body.id);
    assert.ok(hit, 'a trip that started earlier still shows');
    assert.equal(hit.start, '2030-05-10');
    assert.equal(hit.end, '2030-05-13');
    assert.equal(hit.all_day, true);
  });

  test('validation errors are 400 with messages', async () => {
    const a = fam.admin.agent;
    const bad = [
      [{ start: '2030-01-01T10:00:00Z' }, /Title/],
      [{ title: 'x'.repeat(121), start: '2030-01-01T10:00:00Z' }, /too long/],
      [{ title: 'X', start: 'tomorrow' }, /Start/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', end: '2030-01-01T09:00:00Z' }, /end after/],
      [{ title: 'X', all_day: true, start: '2030-02-31' }, /valid date/],
      [{ title: 'X', all_day: true, start: '2030-02-10', end: '2030-02-01' }, /on or after/],
      [{ title: 'X', all_day: 'yes', start: '2030-02-10' }, /all_day/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', tz: 'Mars/Olympus' }, /time zone/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', color: 'red' }, /Color/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', attendees: [999999] }, /members of this family/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', reminders: [-5] }, /Reminders/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', reminders: [1, 2, 3, 4, 5, 6] }, /At most 5/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'hourly' } }, /frequency/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'weekly', byweekday: [] } }, /weekday/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'daily', interval: 0 } }, /interval/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'daily', until: '2029-01-01' } }, /end date/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'daily', until: '2030-02-01', count: 3 } }, /not both/],
      [{ title: 'X', start: '2030-01-01T10:00:00Z', rrule: { freq: 'daily', count: 5000 } }, /count/],
    ];
    for (const [body, re] of bad) {
      const res = await a.post('/api/calendar/events', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, re, JSON.stringify(body));
    }
    assert.equal((await a.get('/api/calendar/events?from=2030-01-01')).status, 400);
    assert.equal((await a.get('/api/calendar/events?from=2030-01-10&to=2030-01-01')).status, 400);
    assert.equal((await a.get('/api/calendar/events?from=2030-01-01&to=2032-01-01')).status, 400);
    assert.equal((await a.get('/api/calendar/events/abc')).status, 400);
    assert.equal((await a.get('/api/calendar/events/999999')).status, 404);
  });

  test('update and delete a single event', async () => {
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'Haircut', start: '2030-06-01T14:00:00Z', end: '2030-06-01T14:30:00Z', tz: TZ });
    const up = await a.patch(`/api/calendar/events/${ev.id}`, { title: 'Haircut (Leo)', start: '2030-06-02T15:00:00Z', end: '2030-06-02T15:30:00Z', color: '#E5484D' });
    assert.equal(up.status, 200);
    assert.equal(up.body.title, 'Haircut (Leo)');
    assert.equal(up.body.start, '2030-06-02T15:00:00.000Z');
    assert.equal(up.body.color, '#E5484D');
    // partial update keeps other fields
    const up2 = await a.patch(`/api/calendar/events/${ev.id}`, { notes: 'Short on the sides' });
    assert.equal(up2.body.title, 'Haircut (Leo)');
    assert.equal(up2.body.notes, 'Short on the sides');
    assert.equal((await a.patch(`/api/calendar/events/${ev.id}`, { title: '' })).status, 400);
    const del = await a.del(`/api/calendar/events/${ev.id}`);
    assert.equal(del.status, 200);
    assert.equal((await a.get(`/api/calendar/events/${ev.id}`)).status, 404);
  });

  test('ics export', async () => {
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', {
      title: 'Piano', start: '2030-01-02T22:00:00Z', end: '2030-01-02T22:45:00Z', tz: TZ, rrule: { freq: 'weekly', byweekday: [3] }, reminders: [30],
    });
    const res = await fam.admin.agent.get(`/api/calendar/events/${ev.id}/ics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    assert.match(res.body, /SUMMARY:Piano/);
    assert.match(res.body, /RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE/);
    assert.match(res.body, /TRIGGER:-PT30M/);
  });
});

describe('family scoping + roles', () => {
  test('other families get 404 and never see events', async () => {
    const a = await familyFixture(srv, 'Scope A');
    const b = await familyFixture(srv, 'Scope B');
    const { body: ev } = await a.admin.agent.post('/api/calendar/events', { title: 'Secret party', start: '2030-07-01T18:00:00Z', tz: TZ });
    assert.equal((await b.admin.agent.get(`/api/calendar/events/${ev.id}`)).status, 404);
    assert.equal((await b.admin.agent.patch(`/api/calendar/events/${ev.id}`, { title: 'Hacked' })).status, 404);
    assert.equal((await b.admin.agent.del(`/api/calendar/events/${ev.id}`)).status, 404);
    assert.equal((await b.admin.agent.get(`/api/calendar/events/${ev.id}/ics`)).status, 404);
    const list = await range(b.admin.agent, '2030-06-25', '2030-07-05');
    assert.ok(!list.body.some((e) => e.title === 'Secret party'));
    // other family's members can't be attendees
    const bad = await a.admin.agent.post('/api/calendar/events', { title: 'X', start: '2030-07-01T18:00:00Z', attendees: [b.admin.user.id] });
    assert.equal(bad.status, 400);
    // search is scoped too
    const sa = await a.admin.agent.get('/api/search?q=Secret');
    assert.ok(sa.body.results.some((r) => r.module === 'calendar' && r.title === 'Secret party'));
    const sb = await b.admin.agent.get('/api/search?q=Secret');
    assert.ok(!sb.body.results.some((r) => r.module === 'calendar'));
    assert.equal((await a.admin.agent.get(`/api/calendar/events/${ev.id}`)).body.title, 'Secret party');
  });

  test('children can only change their own events', async () => {
    const fam = await familyFixture(srv, 'Roles');
    await fam.admin.agent.patch(`/api/family/members/${fam.member.user.id}`, { role: 'child' });
    const kid = fam.member.agent;
    const { body: parentEv } = await fam.admin.agent.post('/api/calendar/events', { title: 'Parents only', start: '2030-08-01T18:00:00Z', tz: TZ });
    const view = await kid.get(`/api/calendar/events/${parentEv.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.can_edit, false);
    const listed = (await range(kid, '2030-07-30', '2030-08-03')).body.find((e) => e.event_id === parentEv.id);
    assert.equal(listed.can_edit, false);
    assert.equal((await kid.patch(`/api/calendar/events/${parentEv.id}`, { title: 'Mine now' })).status, 403);
    assert.equal((await kid.del(`/api/calendar/events/${parentEv.id}`)).status, 403);
    const own = await kid.post('/api/calendar/events', { title: 'Sleepover', start: '2030-08-02T18:00:00Z', tz: TZ });
    assert.equal(own.status, 201);
    assert.equal((await kid.patch(`/api/calendar/events/${own.body.id}`, { title: 'Sleepover!' })).status, 200);
    assert.equal((await kid.del(`/api/calendar/events/${own.body.id}`)).status, 200);
    // parents can edit a child's event
    const own2 = await kid.post('/api/calendar/events', { title: 'Party', start: '2030-08-03T18:00:00Z', tz: TZ });
    assert.equal((await fam.admin.agent.patch(`/api/calendar/events/${own2.body.id}`, { location: 'Bounce World' })).status, 200);
  });
});

describe('recurrence', () => {
  let fam;
  before(async () => {
    fam = await familyFixture(srv, 'Recur');
  });

  test('weekly on chosen weekdays with a count', async () => {
    // Mon 2030-09-02, Mon/Wed 5 times → Sep 2, 4, 9, 11, 16
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', {
      title: 'Soccer', start: '2030-09-02T20:30:00Z', end: '2030-09-02T22:00:00Z', tz: TZ,
      rrule: { freq: 'weekly', byweekday: [1, 3], count: 5 },
    });
    const list = (await range(fam.admin.agent, '2030-09-01', '2030-10-01')).body.filter((e) => e.event_id === ev.id);
    assert.deepEqual(list.map((e) => e.start.slice(0, 10)), ['2030-09-02', '2030-09-04', '2030-09-09', '2030-09-11', '2030-09-16']);
    assert.ok(list.every((e) => e.recurring && e.occurrence === e.start));
    assert.equal(new Set(list.map((e) => e.id)).size, 5, 'occurrence ids are unique');
  });

  test('daily with interval + until, monthly by weekday, yearly on Feb 29', async () => {
    const a = fam.admin.agent;
    const daily = (await a.post('/api/calendar/events', { title: 'Meds', all_day: true, start: '2030-01-01', tz: TZ, rrule: { freq: 'daily', interval: 3, until: '2030-01-10' } })).body;
    let list = (await range(a, '2030-01-01', '2030-02-01')).body.filter((e) => e.event_id === daily.id);
    assert.deepEqual(list.map((e) => e.start), ['2030-01-01', '2030-01-04', '2030-01-07', '2030-01-10']);

    // 2nd Tuesday of the month (2030-01-08 is a Tuesday)
    const monthly = (await a.post('/api/calendar/events', { title: 'Book club', start: '2030-01-09T00:30:00Z', end: '2030-01-09T02:00:00Z', tz: TZ, rrule: { freq: 'monthly', monthly: 'weekday' } })).body;
    list = (await range(a, '2030-01-01', '2030-05-01')).body.filter((e) => e.event_id === monthly.id);
    // Local times: Tue Jan 8, Feb 12, Mar 12, Apr 9 (19:30 NY)
    const local = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    assert.deepEqual(list.map((e) => local(e.start)), ['2030-01-08', '2030-02-12', '2030-03-12', '2030-04-09']);

    const leap = (await a.post('/api/calendar/events', { title: 'Leap day', all_day: true, start: '2028-02-29', tz: TZ, rrule: { freq: 'yearly' } })).body;
    const y2031 = (await range(a, '2031-01-01', '2031-12-31')).body.filter((e) => e.event_id === leap.id);
    assert.equal(y2031.length, 0, 'no Feb 29 in 2031');
    const y2032 = (await range(a, '2032-01-01', '2032-12-31')).body.filter((e) => e.event_id === leap.id);
    assert.deepEqual(y2032.map((e) => e.start), ['2032-02-29']);
  });

  test('keeps local wall-clock time across DST changes', async () => {
    // 9:00 AM New York every Monday from Oct 21 2030 (EDT, -4) into November (EST, -5)
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', {
      title: 'Standup', start: '2030-10-21T13:00:00Z', end: '2030-10-21T13:15:00Z', tz: TZ, rrule: { freq: 'weekly' },
    });
    const list = (await range(fam.admin.agent, '2030-10-20', '2030-11-12')).body.filter((e) => e.event_id === ev.id);
    assert.deepEqual(list.map((e) => e.start), ['2030-10-21T13:00:00.000Z', '2030-10-28T13:00:00.000Z', '2030-11-04T14:00:00.000Z', '2030-11-11T14:00:00.000Z']);
    assert.ok(list.every((e) => Date.parse(e.end) - Date.parse(e.start) === 15 * 60_000));
  });

  test('edit/delete this occurrence, this-and-following, and all', async () => {
    const a = fam.admin.agent;
    // Every day at 17:00 NY, Mar 3 – Mar 12 2031 (10 occurrences)
    const { body: ev } = await a.post('/api/calendar/events', {
      title: 'Piano', start: '2031-03-03T22:00:00Z', end: '2031-03-03T22:45:00Z', tz: TZ, rrule: { freq: 'daily', until: '2031-03-12' }, attendees: [fam.member.user.id],
    });
    const occs = async () => (await range(a, '2031-03-01', '2031-03-20')).body.filter((e) => e.title.startsWith('Piano') || e.title === 'Lesson');
    let list = await occs();
    assert.equal(list.length, 10);

    // This occurrence: move Mar 5 by an hour + rename
    const k5 = list[2].occurrence;
    const t = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: k5, title: 'Piano (moved)', start: '2031-03-05T23:00:00Z', end: '2031-03-05T23:45:00Z' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.occurrence.exception, true);
    list = await occs();
    const moved = list.find((e) => e.occurrence === k5);
    assert.equal(moved.title, 'Piano (moved)');
    assert.equal(moved.start, '2031-03-05T23:00:00.000Z');
    assert.equal(list.filter((e) => e.title === 'Piano').length, 9);
    // invalid occurrence key → 400
    assert.equal((await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: '2031-03-05T21:00:00.000Z', title: 'x' })).status, 400);
    assert.equal((await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', title: 'x' })).status, 400);
    assert.equal((await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'sometimes', title: 'x' })).status, 400);

    // Delete Mar 6 only
    const k6 = list.find((e) => e.start.startsWith('2031-03-06')).occurrence;
    assert.equal((await a.del(`/api/calendar/events/${ev.id}`, { body: { scope: 'this', occurrence: k6 } })).status, 200);
    list = await occs();
    assert.equal(list.length, 9);
    assert.ok(!list.some((e) => e.occurrence === k6));
    assert.equal((await a.get(`/api/calendar/events/${ev.id}?occurrence=${encodeURIComponent(k6)}`)).status, 404);

    // "All" from an occurrence: shift the whole series 30 minutes later; exceptions move along.
    const k4 = list.find((e) => e.start.startsWith('2031-03-04')).occurrence;
    const all = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'all', occurrence: k4, start: '2031-03-04T22:30:00Z', end: '2031-03-04T23:15:00Z' });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.start, '2031-03-03T22:30:00.000Z', 'series start shifted, keeping its first day');
    list = await occs();
    assert.equal(list.length, 9, 'the cancelled occurrence stays cancelled');
    const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    assert.ok(list.filter((e) => !e.exception).every((e) => hm(e.start) === '17:30'), 'local 5:30 PM, also after DST starts on Mar 9');
    assert.ok(list.some((e) => e.title === 'Piano (moved)'), 'the edited occurrence keeps its override');

    // This and following from Mar 9: rename → series split in two
    const k9 = list.find((e) => e.start.startsWith('2031-03-09')).occurrence;
    const f = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'following', occurrence: k9, title: 'Lesson' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.notEqual(f.body.id, ev.id);
    assert.equal(f.body.split_from, ev.id);
    list = await occs();
    assert.equal(list.filter((e) => e.title === 'Lesson').length, 4, 'Mar 9–12');
    assert.equal(list.filter((e) => e.event_id === ev.id).length, 5, 'Mar 3–8 minus the cancelled one');
    assert.equal((await a.get(`/api/calendar/events/${ev.id}`)).body.rrule.until, '2031-03-08');

    // Delete following from Mar 11 on the new series
    const k11 = list.find((e) => e.title === 'Lesson' && e.start.startsWith('2031-03-11')).occurrence;
    assert.equal((await a.del(`/api/calendar/events/${f.body.id}?scope=following&occurrence=${encodeURIComponent(k11)}`)).status, 200);
    list = await occs();
    assert.equal(list.filter((e) => e.title === 'Lesson').length, 2);

    // Delete all of the original series
    assert.equal((await a.del(`/api/calendar/events/${ev.id}`, { body: { scope: 'all' } })).status, 200);
    list = await occs();
    assert.ok(!list.some((e) => e.event_id === ev.id));
  });

  test('changing the rule of a series drops stale exceptions', async () => {
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'Walk', all_day: true, start: '2031-06-02', tz: TZ, rrule: { freq: 'daily', count: 5 } });
    await a.del(`/api/calendar/events/${ev.id}`, { body: { scope: 'this', occurrence: '2031-06-03' } });
    assert.equal((await range(a, '2031-06-01', '2031-06-10')).body.filter((e) => e.event_id === ev.id).length, 4);
    await a.patch(`/api/calendar/events/${ev.id}`, { rrule: { freq: 'daily', count: 3 } });
    assert.equal((await range(a, '2031-06-01', '2031-06-10')).body.filter((e) => e.event_id === ev.id).length, 3);
    // turning off repeat makes it a single event
    const once = await a.patch(`/api/calendar/events/${ev.id}`, { rrule: null });
    assert.equal(once.body.rrule, null);
    assert.equal((await range(a, '2031-06-01', '2031-06-10')).body.filter((e) => e.event_id === ev.id).length, 1);
  });
});

describe('birthdays, dashboard, search', () => {
  test('member birthdays appear as yearly all-day entries', async () => {
    const fam = await familyFixture(srv, 'Bday');
    await fam.member.agent.patch('/api/auth/me', { birthday: '2015-06-21' });
    const list = (await range(fam.admin.agent, '2031-06-01', '2031-07-01')).body;
    const b = list.find((e) => e.kind === 'birthday');
    assert.ok(b);
    assert.equal(b.start, '2031-06-21');
    assert.equal(b.all_day, true);
    assert.equal(b.age, 16);
    assert.equal(b.can_edit, false);
    assert.match(b.title, /birthday/);
    const noB = (await fam.admin.agent.get(`/api/calendar/events?${q({ from: '2031-06-01', to: '2031-07-01', tz: TZ, birthdays: '0' })}`)).body;
    assert.ok(!noB.some((e) => e.kind === 'birthday'));
  });

  test('dashboard returns { today, upcoming } with the documented Event fields', async () => {
    const fam = await familyFixture(srv, 'Dash');
    const a = fam.admin.agent;
    const now = Date.now();
    const soon = new Date(now + 5 * 60_000).toISOString();
    const in3 = new Date(now + 3 * 86_400_000).toISOString();
    const in20 = new Date(now + 20 * 86_400_000).toISOString();
    await a.post('/api/calendar/events', { title: 'Soon', start: soon, tz: 'UTC' });
    await a.post('/api/calendar/events', { title: 'In three days', start: in3, tz: 'UTC' });
    await a.post('/api/calendar/events', { title: 'Far away', start: in20, tz: 'UTC' });
    const res = await a.get('/api/dashboard?tz=UTC');
    assert.equal(res.status, 200);
    const d = res.body.calendar;
    assert.deepEqual(Object.keys(d).sort(), ['today', 'upcoming']);
    // "Soon" is today unless we're 5 minutes before UTC midnight.
    const all = [...d.today, ...d.upcoming];
    assert.ok(all.some((e) => e.title === 'Soon'));
    assert.ok(d.upcoming.some((e) => e.title === 'In three days'));
    assert.ok(!all.some((e) => e.title === 'Far away'));
    for (const e of all) for (const k of ['id', 'title', 'start', 'end', 'all_day', 'color', 'location']) assert.ok(k in e, `missing ${k}`);
    assert.ok(all.every((e) => typeof e.link === 'string' && e.link.startsWith('/calendar')));
  });

  test('search finds events by title, location and notes', async () => {
    const fam = await familyFixture(srv, 'Search');
    await fam.admin.agent.post('/api/calendar/events', { title: 'Orthodontist', location: 'Smile Center', notes: 'retainer check', start: '2031-01-01T15:00:00Z', tz: TZ });
    for (const term of ['Ortho', 'Smile', 'retainer']) {
      const r = await fam.admin.agent.get(`/api/search?q=${term}`);
      const hit = r.body.results.find((x) => x.module === 'calendar');
      assert.ok(hit, term);
      assert.equal(hit.title, 'Orthodontist');
      assert.match(hit.link, /^\/calendar\?event=\d+/);
    }
  });
});

describe('realtime, activity, notifications, reminders', () => {
  test('mutations broadcast calendar.* events to the family', async () => {
    const fam = await familyFixture(srv, 'Live');
    const other = await familyFixture(srv, 'Live other');
    const stream = await collectEvents(fam.member.agent, { until: (e) => e.type === 'calendar.event.deleted', timeoutMs: 4000 });
    const otherStream = await collectEvents(other.admin.agent, { count: 1, timeoutMs: 1500 });
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', { title: 'Live one', start: '2031-02-01T10:00:00Z', tz: TZ, attendees: [fam.member.user.id] });
    await fam.admin.agent.patch(`/api/calendar/events/${ev.id}`, { title: 'Live two' });
    await fam.admin.agent.del(`/api/calendar/events/${ev.id}`);
    const types = (await stream.events).map((e) => e.type);
    assert.ok(types.includes('calendar.event.created'));
    assert.ok(types.includes('calendar.event.updated'));
    assert.ok(types.includes('calendar.event.deleted'));
    assert.ok(types.includes('notification'), 'attendee notified live');
    assert.ok(types.includes('activity'));
    const otherTypes = (await otherStream.events).map((e) => e.type);
    assert.ok(!otherTypes.some((t) => t.startsWith('calendar.')), 'other families hear nothing');
  });

  test('activity entries + attendee notifications', async () => {
    const fam = await familyFixture(srv, 'Notify');
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', { title: 'Swim meet', start: '2031-02-01T14:00:00Z', tz: TZ, attendees: [fam.member.user.id, fam.admin.user.id] });
    const acts = (await fam.member.agent.get('/api/activity?module=calendar')).body;
    const created = acts.find((x) => x.entity_id === ev.id && x.verb === 'created');
    assert.ok(created);
    assert.match(created.summary, /Swim meet/);
    assert.match(created.link, /^\/calendar/);
    const memberN = (await fam.member.agent.get('/api/notifications')).body.items;
    assert.ok(memberN.some((n) => /added you to Swim meet/.test(n.title)));
    const adminN = (await fam.admin.agent.get('/api/notifications')).body.items;
    assert.ok(!adminN.some((n) => /Swim meet/.test(n.title)), 'no self-notification');

    await fam.admin.agent.patch(`/api/calendar/events/${ev.id}`, { start: '2031-02-02T14:00:00Z', end: '2031-02-02T15:00:00Z' });
    assert.ok((await fam.member.agent.get('/api/notifications')).body.items.some((n) => /rescheduled Swim meet/.test(n.title)));
    assert.ok((await fam.member.agent.get('/api/activity?module=calendar')).body.some((x) => x.verb === 'rescheduled'));
    await fam.admin.agent.del(`/api/calendar/events/${ev.id}`);
    assert.ok((await fam.member.agent.get('/api/notifications')).body.items.some((n) => /Swim meet was cancelled/.test(n.title)));
  });

  test('reminders notify attendees once when due', async () => {
    const fam = await familyFixture(srv, 'Remind');
    const start = Date.now() + 3 * 86_400_000; // far enough that the real background tick never fires it
    const { body: ev } = await fam.admin.agent.post('/api/calendar/events', {
      title: 'Soccer practice', start: new Date(start).toISOString(), tz: TZ, reminders: [30, 1440], attendees: [fam.member.user.id], location: 'Field 3',
    });
    const count = () => fam.member.agent.get('/api/notifications').then((r) => r.body.items.filter((n) => /Soccer practice (starts|is)/.test(n.title)));
    const before = (await count()).length;
    // not due yet 10 minutes before the reminder time
    calendar.runReminders(srv.ctx, start - 40 * 60_000);
    assert.equal((await count()).length, before);
    // due now
    const sent = calendar.runReminders(srv.ctx, start - 30 * 60_000 + 1000);
    assert.ok(sent >= 1);
    const items = await count();
    assert.equal(items.length, before + 1);
    assert.match(items[0].title, /starts in 30 min/);
    assert.match(items[0].body, /Field 3/);
    assert.match(items[0].link, new RegExp(`event=${ev.id}`));
    // never twice
    calendar.runReminders(srv.ctx, start - 30 * 60_000 + 5000);
    assert.equal((await count()).length, before + 1);
    // no attendees → the creator gets it
    const t2 = Date.now() + 4 * 86_400_000;
    await fam.admin.agent.post('/api/calendar/events', { title: 'Call grandma', start: new Date(t2).toISOString(), tz: TZ, reminders: [10] });
    calendar.runReminders(srv.ctx, t2 - 10 * 60_000 + 1000);
    assert.ok((await fam.admin.agent.get('/api/notifications')).body.items.some((n) => /Call grandma/.test(n.title)));
  });
});

test('seed creates a lively Rivera calendar', async () => {
  const s = await startServer();
  try {
    const { familyId, users } = await seedDemo(s.ctx, undefined, { log: () => {} });
    const n = s.db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE family_id = ?').get(familyId).n;
    assert.ok(n >= 15, `seeded ${n} events`);
    const agent = s.agent();
    await agent.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
    const now = Date.now();
    const list = (await agent.get(`/api/calendar/events?${q({ from: new Date(now - 7 * 864e5).toISOString(), to: new Date(now + 14 * 864e5).toISOString(), tz: 'UTC' })}`)).body;
    assert.ok(list.length >= 25, `only ${list.length} occurrences`);
    for (const t of ['School run', 'Soccer practice', 'Dentist — Mia', 'Date night', 'Piano lesson', 'Sunday family dinner']) {
      assert.ok(list.some((e) => e.title.startsWith(t)), t);
    }
    assert.ok(list.some((e) => e.exception), 'has an edited occurrence');
    // Demo users have no remembered zone yet: family-local wall clock in the default demo zone.
    const run = list.find((e) => e.title === 'School run');
    assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' }).format(new Date(run.start)), '07:45');
    assert.ok(list.some((e) => e.attendees.includes(users.mia.id)));
    const dash = (await agent.get('/api/dashboard')).body.calendar;
    assert.ok(Array.isArray(dash.today) && Array.isArray(dash.upcoming));
    assert.ok(dash.today.length + dash.upcoming.length > 5);
    const acts = (await agent.get('/api/activity?module=calendar')).body;
    assert.ok(acts.length >= 5);
    // re-seeding is clean
    await seedDemo(s.ctx, undefined, { log: () => {} });
    const fams = s.db.prepare("SELECT id FROM families WHERE invite_code = 'HRTH-2026'").all();
    assert.equal(fams.length, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, n, 'old demo events purged, not duplicated');
  } finally {
    await s.close();
  }
});

describe('review fixes', () => {
  let fam;
  before(async () => {
    fam = await familyFixture(srv, 'Fixes');
  });
  const list = async (agent, from, to, id) => (await range(agent, from, to)).body.filter((e) => e.event_id === id);
  const local = (iso, tz = TZ) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso)).replace(',', '');

  test('ics uses TZID + VTIMEZONE, zone-local UNTIL, RECURRENCE-ID overrides, EXDATE, 75-octet folding', async () => {
    const a = fam.admin.agent;
    // 9:00 AM New York every Monday from Oct 21 2030 until Nov 18 (crosses the DST change)
    const { body: ev } = await a.post('/api/calendar/events', {
      title: 'Standup', start: '2030-10-21T13:00:00Z', end: '2030-10-21T13:30:00Z', tz: TZ,
      rrule: { freq: 'weekly', until: '2030-11-18' }, notes: 'Agenda: ' + 'wins, blockers and plans — ünïcødé '.repeat(6),
    });
    const occs = await list(a, '2030-10-20', '2030-11-20', ev.id);
    await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: occs[1].occurrence, title: 'Standup (late)', start: '2030-10-28T15:00:00Z', end: '2030-10-28T15:30:00Z' });
    await a.del(`/api/calendar/events/${ev.id}`, { body: { scope: 'this', occurrence: occs[2].occurrence } });
    const ics = (await a.get(`/api/calendar/events/${ev.id}/ics`)).body;
    const lines = ics.split('\r\n');
    for (const l of lines) assert.ok(Buffer.byteLength(l) <= 75, `line too long: ${l}`);
    assert.ok(lines.some((l) => l.startsWith(' ')), 'long DESCRIPTION is folded');
    const unfolded = ics.replace(/\r\n /g, '');
    assert.match(unfolded, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
    assert.match(unfolded, /BEGIN:DAYLIGHT[\s\S]*TZOFFSETTO:-0400/);
    assert.match(unfolded, /BEGIN:STANDARD[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU[\s\S]*TZOFFSETTO:-0500/);
    assert.match(unfolded, /DTSTART;TZID=America\/New_York:20301021T090000/);
    assert.match(unfolded, /UNTIL=20301119T045959Z/, 'end of Nov 18 in New York (EST)');
    assert.match(unfolded, /EXDATE;TZID=America\/New_York:20301104T090000/);
    assert.match(unfolded, /RECURRENCE-ID;TZID=America\/New_York:20301028T090000\r\nDTSTART;TZID=America\/New_York:20301028T110000/);
    assert.match(unfolded, /SUMMARY:Standup \(late\)/);
    assert.equal((unfolded.match(/BEGIN:VEVENT/g) || []).length, 2);
  });

  test('"all" edit that moves the day shifts weekdays and keeps valid exceptions', async () => {
    const a = fam.admin.agent;
    // Mon + Wed at 16:00 New York from Mon Sep 2 2030
    const { body: ev } = await a.post('/api/calendar/events', {
      title: 'Tutoring', start: '2030-09-02T20:00:00Z', end: '2030-09-02T21:00:00Z', tz: TZ, rrule: { freq: 'weekly', byweekday: [1, 3] },
    });
    let occs = await list(a, '2030-09-01', '2030-09-15', ev.id);
    const wed4 = occs.find((o) => o.start.startsWith('2030-09-04'));
    const mon9 = occs.find((o) => o.start.startsWith('2030-09-09'));
    await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: wed4.occurrence, title: 'Tutoring (math test)' });
    await a.del(`/api/calendar/events/${ev.id}`, { body: { scope: 'this', occurrence: mon9.occurrence } });
    // Move the whole series one day later from the first occurrence, sending the same (unchanged) rule
    const res = await a.patch(`/api/calendar/events/${ev.id}`, {
      scope: 'all', occurrence: occs[0].occurrence, start: '2030-09-03T20:00:00Z', end: '2030-09-03T21:00:00Z', rrule: { freq: 'weekly', byweekday: [1, 3] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.rrule.byweekday, [2, 4], 'Mon/Wed → Tue/Thu');
    assert.equal(res.body.dropped_exceptions, 0);
    occs = await list(a, '2030-09-01', '2030-09-15', ev.id);
    assert.deepEqual(occs.map((o) => o.start.slice(0, 10)), ['2030-09-03', '2030-09-05', '2030-09-12'], 'first occurrence kept, Tue Sep 10 still cancelled');
    assert.equal(occs.find((o) => o.start.startsWith('2030-09-05')).title, 'Tutoring (math test)');

    // Explicitly choosing other weekdays keeps them; the series start snaps to the first of them.
    const res2 = await a.patch(`/api/calendar/events/${ev.id}`, { rrule: { freq: 'weekly', byweekday: [5] } });
    assert.equal(res2.status, 200);
    assert.equal(local(res2.body.start), '2030-09-06 16:00', 'starts on the first Friday');
    assert.equal(res2.body.dropped_exceptions, 2, 'rule change resets per-day edits (reported)');
    occs = await list(a, '2030-09-01', '2030-09-15', ev.id);
    assert.deepEqual(occs.map((o) => o.start.slice(0, 10)), ['2030-09-06', '2030-09-13']);

    // Creating a weekly series whose start isn't one of its weekdays starts on the first match.
    const c = await a.post('/api/calendar/events', { title: 'Gym', start: '2030-09-02T12:00:00Z', tz: TZ, rrule: { freq: 'weekly', byweekday: [4] } });
    assert.equal(local(c.body.start), '2030-09-05 08:00');
  });

  test('"this and following" starts from the generated occurrence and carries later edits over', async () => {
    const a = fam.admin.agent;
    // Wednesdays 17:00 NY from Wed Jan 8 2031
    const { body: ev } = await a.post('/api/calendar/events', {
      title: 'Piano', start: '2031-01-08T22:00:00Z', end: '2031-01-08T22:45:00Z', tz: TZ, rrule: { freq: 'weekly' }, location: 'Studio A',
    });
    let occs = await list(a, '2031-01-01', '2031-02-10', ev.id);
    const [, o2, o3, o4] = occs;
    await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: o2.occurrence, title: 'Piano (moved)', start: '2031-01-16T22:30:00Z', end: '2031-01-16T23:15:00Z' });
    await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: o4.occurrence, title: 'Piano recital' });
    // "Following" from the MOVED occurrence, changing only the location
    const f = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'following', occurrence: o2.occurrence, location: 'Studio B' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.title, 'Piano', 'does not inherit the one-off title');
    assert.equal(f.body.start, o2.occurrence, 'starts at the generated Wednesday time, not the moved Thursday');
    assert.equal(f.body.location, 'Studio B');
    occs = (await range(a, '2031-01-01', '2031-02-10')).body.filter((e) => e.title.startsWith('Piano'));
    assert.equal(occs.filter((o) => o.event_id === ev.id).length, 1, 'old series ends before o2');
    const recital = occs.find((o) => o.title === 'Piano recital');
    assert.ok(recital, 'later exception survives');
    assert.equal(recital.event_id, f.body.id, 'and moved to the new series');
    assert.equal(recital.occurrence, o4.occurrence);
    assert.ok(occs.some((o) => o.occurrence === o3.occurrence && o.event_id === f.body.id && o.location === 'Studio B'));
    const moved = occs.find((o) => o.title === 'Piano (moved)');
    assert.ok(moved, 'the split-point edit is carried into the new series');
    assert.equal(moved.event_id, f.body.id);
    assert.equal(moved.start, '2031-01-16T22:30:00.000Z');
    assert.equal(moved.location, 'Studio B', 'with the new edit applied on top');
  });

  test('ranges default to the X-Timezone zone; LIKE wildcards are literal', async () => {
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'Late call 100%', start: '2032-05-12T02:00:00Z', tz: TZ }); // May 11 22:00 in NY
    const ny = await a.get('/api/calendar/events?from=2032-05-12&to=2032-05-13', { headers: { 'x-timezone': TZ } });
    assert.equal(ny.status, 200);
    assert.ok(!ny.body.some((e) => e.event_id === ev.id), 'May 12 in New York does not include May 11 22:00');
    const utc = await a.get('/api/calendar/events?from=2032-05-12&to=2032-05-13', { headers: { 'x-timezone': 'UTC' } });
    assert.ok(utc.body.some((e) => e.event_id === ev.id));
    const pct = (await a.get('/api/search?q=%25%25')).body.results.filter((r) => r.module === 'calendar');
    assert.equal(pct.length, 0, '"%%" is not a wildcard');
    const hit = (await a.get('/api/search?q=100%25')).body.results.filter((r) => r.module === 'calendar');
    assert.equal(hit.length, 1);
  });

  test('deleting an event rewrites its old links', async () => {
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'Temp', start: '2032-06-01T15:00:00Z', tz: TZ, attendees: [fam.member.user.id] });
    await a.del(`/api/calendar/events/${ev.id}`);
    const acts = (await a.get('/api/activity?module=calendar')).body.filter((x) => x.entity_id === ev.id);
    assert.ok(acts.length && acts.every((x) => x.link === '/calendar'));
    const n = (await fam.member.agent.get('/api/notifications')).body.items.filter((x) => /Temp/.test(x.title));
    assert.ok(n.length && n.every((x) => !x.link.includes(`event=${ev.id}`)));
  });

  test('upgradeSchema rebuilds old tables with AUTOINCREMENT, keeping rows and cascades', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE families (id INTEGER PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY)');
    for (const m of calendar.migrations.map((x) => x.replace(/ AUTOINCREMENT/g, ''))) db.exec(m);
    db.exec('INSERT INTO families VALUES (1); INSERT INTO users VALUES (1)');
    db.exec(`INSERT INTO calendar_events (id, family_id, title, start, "end") VALUES (5, 1, 'Old', '2030-01-01', '2030-01-01')`);
    db.exec("INSERT INTO calendar_exceptions (event_id, occurrence, cancelled) VALUES (5, '2030-01-01', 1)");
    db.exec('INSERT INTO calendar_event_attendees VALUES (5, 1)');
    assert.equal(calendar.upgradeSchema(db), true);
    assert.equal(calendar.upgradeSchema(db), false, 'idempotent');
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'calendar_events'").get().sql, /AUTOINCREMENT/);
    assert.equal(db.prepare('SELECT title FROM calendar_events WHERE id = 5').get().title, 'Old');
    db.exec('DELETE FROM calendar_events WHERE id = 5');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_exceptions').get().n, 0, 'cascade still works');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_event_attendees').get().n, 0);
    db.exec(`INSERT INTO calendar_events (family_id, title, start, "end") VALUES (1, 'New', '2030-01-01', '2030-01-01')`);
    assert.equal(db.prepare("SELECT id FROM calendar_events WHERE title = 'New'").get().id, 6, 'ids are not reused');
    db.close();
  });
});

describe('review round 2', () => {
  test('"following" from an edited occurrence carries that edit into the new series', async () => {
    const fam = await familyFixture(srv, 'Split');
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'W', start: '2033-10-05T17:00:00Z', end: '2033-10-05T18:00:00Z', tz: 'UTC', rrule: { freq: 'daily', count: 6 } });
    const key = '2033-10-07T17:00:00.000Z';
    await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: key, title: 'W special', start: '2033-10-07T20:00:00Z', end: '2033-10-07T21:00:00Z' });
    const f = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'following', occurrence: key, location: 'Gym' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.exceptions, 1, 'the split-point edit lives on in the new series');
    assert.equal(f.body.title, 'W');
    const list = (await range(a, '2033-10-01', '2033-10-15', 'UTC')).body.filter((e) => e.title.startsWith('W'));
    assert.equal(list.length, 6, 'count preserved across both halves');
    const d7 = list.find((e) => e.occurrence === key);
    assert.equal(d7.event_id, f.body.id);
    assert.equal(d7.title, 'W special');
    assert.equal(d7.start, '2033-10-07T20:00:00.000Z');
    assert.equal(d7.location, 'Gym', 'edited field applied on top');
    assert.ok(list.filter((e) => e.event_id === f.body.id && e.occurrence !== key).every((e) => e.location === 'Gym' && e.title === 'W'));
  });

  test('moving a series (drag, no tz sent) keeps the series zone', async () => {
    const fam = await familyFixture(srv, 'DragTz');
    const a = fam.admin.agent;
    const { body: ev } = await a.post('/api/calendar/events', { title: 'Swim', start: '2033-10-24T13:00:00Z', end: '2033-10-24T14:00:00Z', tz: TZ, rrule: { freq: 'weekly' } });
    const r = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'all', occurrence: '2033-10-24T13:00:00.000Z', all_day: false, start: '2033-10-24T14:00:00Z', end: '2033-10-24T15:00:00Z' }, { headers: { 'x-timezone': 'Asia/Tokyo' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.tz, TZ);
    // 10 AM New York every week, also after the November DST change
    const list = (await range(a, '2033-10-20', '2033-11-15')).body.filter((e) => e.event_id === ev.id);
    const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    assert.ok(list.length >= 3 && list.every((e) => hm(e.start) === '10:00'));
  });
});

test('"following" applies edited details to later per-day edits unless they overrode that field', async () => {
  const fam = await familyFixture(srv, 'SplitDetails');
  const a = fam.admin.agent;
  const { body: ev } = await a.post('/api/calendar/events', {
    title: 'Piano', start: '2034-01-04T22:00:00Z', end: '2034-01-04T22:45:00Z', tz: 'UTC', rrule: { freq: 'weekly' }, location: 'Studio A',
  });
  const occs = (await range(a, '2034-01-01', '2034-02-15', 'UTC')).body.filter((e) => e.event_id === ev.id);
  const [, , o3, o4, o5] = occs;
  await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: o4.occurrence, title: 'Piano recital' });
  await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'this', occurrence: o5.occurrence, location: 'Concert hall' });
  const f = await a.patch(`/api/calendar/events/${ev.id}`, { scope: 'following', occurrence: o3.occurrence, location: 'Studio B', notes: 'Bring the music book' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const list = (await range(a, '2034-01-01', '2034-02-15', 'UTC')).body.filter((e) => e.event_id === f.body.id);
  const d4 = list.find((e) => e.occurrence === o4.occurrence);
  const d5 = list.find((e) => e.occurrence === o5.occurrence);
  assert.equal(d4.title, 'Piano recital', 'own override kept');
  assert.equal(d4.location, 'Studio B', 'series edit applied');
  assert.equal(d4.notes, 'Bring the music book');
  assert.equal(d5.location, 'Concert hall', 'own location override wins');
  assert.equal(d5.notes, 'Bring the music book');
  assert.equal(d5.title, 'Piano');
});
