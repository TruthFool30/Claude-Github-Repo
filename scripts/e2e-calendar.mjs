// Calendar browser regression + screenshot run against a running, freshly seeded instance.
//   BASE=http://localhost:4202 SHOTS=/tmp/calendar-shots node scripts/e2e-calendar.mjs
// Exercises: month/week/day/agenda views, create/edit/delete (single + recurring with scopes),
// live updates in a second browser, member filter, deep links, keyboard shortcuts, child view-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4202';
const SHOTS = process.env.SHOTS || '/tmp/calendar-shots';
const TZ = process.env.TZ_ID || 'America/Los_Angeles'; // the seeded family's zone
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let passed = 0;

async function open(email, { width = 1280, height = 800, theme = 'light' } = {}) {
  const mobile = width < 700;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, timezoneId: TZ });
  await ctx.addInitScript((t) => {
    localStorage.setItem('hearth-theme', t);
  }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${email}: ${m.text()}`);
  });
  const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert.equal(r.status(), 200, `login ${email}`);
  return { ctx, page };
}

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n${e.stack}`);
    await browser.close();
    process.exit(1);
  }
}

const pill = (page, text) => page.locator('[data-event-id]').filter({ hasText: text });
const noOverflow = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'horizontal overflow');
const dialog = (page) => page.getByRole('dialog').last();
async function waitCount(loc, n, timeout = 5000) {
  const t0 = Date.now();
  while ((await loc.count()) !== n) {
    if (Date.now() - t0 > timeout) assert.equal(await loc.count(), n);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const today = new Date();
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today);

const alex = await open('alex@hearth.test');
const sam = await open('sam@hearth.test');
const A = alex.page;
const S = sam.page;

console.log('calendar e2e');

await step('month view renders seeded events + birthdays', async () => {
  await A.goto(`${BASE}/calendar?view=month`);
  await pill(A, 'School run').first().waitFor();
  assert.ok((await pill(A, 'School run').count()) >= 5);
  await A.goto(`${BASE}/calendar?view=month&date=${todayKey.slice(0, 4)}-09-01`);
  await pill(A, "Sam's birthday").first().waitFor();
  await A.goto(`${BASE}/calendar?view=month`);
  await noOverflow(A);
});

await step('switch views via toolbar and keyboard', async () => {
  await A.getByRole('radio', { name: 'Week' }).click();
  await A.waitForURL(/view=week/);
  await A.locator('[data-day]').first().waitFor();
  await waitCount(A.locator('[data-day]'), 7);
  await A.keyboard.press('d');
  await A.waitForURL(/view=day/);
  await waitCount(A.locator('[data-day]'), 1);
  await A.keyboard.press('a');
  await A.waitForURL(/view=agenda/);
  await A.getByRole('region', { name: /Today|,/ }).first().waitFor().catch(() => {});
  await A.keyboard.press('ArrowRight');
  await A.keyboard.press('t');
  await A.keyboard.press('m');
  await A.waitForURL(/view=month/);
});

await S.goto(`${BASE}/calendar?view=agenda`);
await pill(S, 'School run').first().waitFor();

await step('create an event (live in second browser)', async () => {
  await A.getByRole('button', { name: 'New event' }).click();
  const d = dialog(A);
  await d.locator('input[name=title]').fill('E2E Pizza night');
  await d.getByLabel('Start date').fill(todayKey);
  await d.getByLabel('Start time').fill('18:00');
  await d.getByLabel('End time').fill('19:30');
  await d.getByRole('button', { name: 'Sam' }).click();
  await d.getByRole('button', { name: '15 min before' }).click();
  await d.locator('input[placeholder="Add a place"]').fill("Tony's Pizza");
  await A.screenshot({ path: `${SHOTS}/e2e-editor-filled.png` });
  await d.getByRole('button', { name: 'Add event' }).click();
  await pill(A, 'E2E Pizza night').first().waitFor();
  await pill(S, 'E2E Pizza night').first().waitFor({ timeout: 8000 }); // live, no reload
});

await step('validation: empty title is rejected client-side', async () => {
  await A.getByRole('button', { name: 'New event' }).click();
  const d = dialog(A);
  await d.getByRole('button', { name: 'Add event' }).click();
  await d.getByText('Give your event a name').waitFor();
  await A.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
});

await step('open details and edit (live rename)', async () => {
  await pill(A, 'E2E Pizza night').first().click();
  const d = dialog(A);
  await d.getByText("Tony's Pizza").waitFor();
  await d.getByText('15 min before').waitFor();
  await A.screenshot({ path: `${SHOTS}/e2e-detail.png` });
  await d.getByRole('button', { name: 'Edit' }).click();
  const e = dialog(A);
  await e.locator('input[name=title]').fill('E2E Pizza & movie night');
  await e.getByRole('button', { name: 'Save changes' }).click();
  await pill(A, 'E2E Pizza & movie night').first().waitFor();
  await pill(S, 'E2E Pizza & movie night').first().waitFor({ timeout: 8000 });
});

await step('recurring: create weekly, edit only this occurrence', async () => {
  await A.getByRole('button', { name: 'New event' }).click();
  const d = dialog(A);
  await d.locator('input[name=title]').fill('E2E Swim lesson');
  await d.getByLabel('Start date').fill(todayKey);
  await d.getByLabel('Start time').fill('07:00');
  await d.getByLabel('End time').fill('07:45');
  await d.locator('select').first().selectOption('weekly');
  await d.locator('p').filter({ hasText: /^Every week on / }).first().waitFor();
  await d.getByRole('button', { name: 'Add event' }).click();
  await A.goto(`${BASE}/calendar?view=agenda`);
  await pill(A, 'E2E Swim lesson').nth(2).waitFor();
  const before = await pill(A, 'E2E Swim lesson').count();
  assert.ok(before >= 5, `expected weekly occurrences, got ${before}`);
  await pill(A, 'E2E Swim lesson').nth(1).click();
  await dialog(A).getByText('Repeats').first().waitFor();
  await dialog(A).getByRole('button', { name: 'Edit' }).click();
  await dialog(A).locator('input[name=title]').fill('E2E Swim lesson (pool closed → gym)');
  await dialog(A).getByRole('button', { name: 'Save changes' }).click();
  const scope = dialog(A);
  await scope.getByRole('radio', { name: /This event/ }).waitFor();
  await A.screenshot({ path: `${SHOTS}/e2e-scope.png` });
  await scope.getByRole('radio', { name: /This event/ }).click();
  await scope.getByTestId('scope-confirm').click();
  await pill(A, 'E2E Swim lesson (pool closed').first().waitFor();
  await waitCount(pill(A, 'E2E Swim lesson (pool closed'), 1);
  await waitCount(pill(A, 'E2E Swim lesson'), before);
});

await step('recurring: delete all occurrences (live removal)', async () => {
  await pill(S, 'E2E Swim lesson').first().waitFor({ timeout: 8000 });
  await pill(A, 'E2E Swim lesson').first().click();
  await dialog(A).getByRole('button', { name: 'Delete' }).click();
  const scope = dialog(A);
  await scope.getByRole('radio', { name: /All events/ }).click();
  await scope.getByTestId('scope-confirm').click();
  await pill(A, 'E2E Swim lesson').first().waitFor({ state: 'detached' });
  await pill(S, 'E2E Swim lesson').first().waitFor({ state: 'detached', timeout: 8000 });
});

await step('delete a single event with confirm', async () => {
  await pill(A, 'E2E Pizza & movie night').first().click();
  await dialog(A).getByRole('button', { name: 'Delete' }).click();
  await A.getByRole('alertdialog').or(dialog(A)).getByRole('button', { name: 'Delete' }).last().click();
  await pill(A, 'E2E Pizza & movie night').first().waitFor({ state: 'detached' });
  await pill(S, 'E2E Pizza & movie night').first().waitFor({ state: 'detached', timeout: 8000 });
});

await step('member filter hides events by person', async () => {
  await A.goto(`${BASE}/calendar?view=agenda`);
  await pill(A, 'Soccer practice').first().waitFor();
  const filter = A.getByRole('group', { name: 'Show events for' }).first();
  await filter.getByRole('checkbox', { name: 'Leo' }).click();
  assert.ok((await pill(A, 'Soccer practice').count()) > 0, 'still visible through Sam');
  await filter.getByRole('checkbox', { name: 'Sam' }).click();
  await pill(A, 'Soccer practice').first().waitFor({ state: 'detached' });
  await filter.getByRole('button', { name: 'Show all' }).click();
  await pill(A, 'Soccer practice').first().waitFor();
});

await step('deep link opens the event', async () => {
  const res = await A.request.get(`${BASE}/api/search?q=Dentist`);
  const hit = (await res.json()).results.find((r) => r.module === 'calendar');
  assert.ok(hit, 'search result');
  await A.goto(BASE + hit.link);
  await dialog(A).getByText('Bright Smile Dental', { exact: false }).waitFor();
  await A.keyboard.press('Escape');
});

await step('?new=1 (Home quick action) opens the editor prefilled with ?date', async () => {
  await A.goto(`${BASE}/calendar?new=1&date=2031-02-14`);
  const d = dialog(A);
  await d.locator('input[name=title]').waitFor();
  assert.equal(await d.getByLabel('Start date').inputValue(), '2031-02-14');
  await A.waitForURL((u) => !u.searchParams.has('new'));
  await A.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
});

await step('/calendar?event=<id> (activity/notification link) opens the event', async () => {
  const acts = await (await A.request.get(`${BASE}/api/activity?module=calendar`)).json();
  let act = null;
  for (const x of acts.filter((y) => y.link?.includes('event='))) {
    if ((await A.request.get(`${BASE}/api/calendar/events/${x.entity_id}`)).status() === 200) {
      act = x;
      break;
    }
  }
  assert.ok(act, 'activity link');
  await A.goto(BASE + act.link);
  await dialog(A).getByRole('button', { name: /Edit|Duplicate/ }).first().waitFor();
  await A.waitForURL((u) => !u.searchParams.has('event'));
  await A.keyboard.press('Escape');
});

await step('click an empty week slot prefills the editor', async () => {
  await A.goto(`${BASE}/calendar?view=week`);
  const col = A.locator('[data-day]').nth(3);
  const box = await col.boundingBox();
  const scroller = await col.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]').boundingBox();
  await A.mouse.click(box.x + box.width / 2, scroller.y + scroller.height / 2); // middle of the visible hours
  const d = dialog(A);
  await d.locator('input[name=title]').waitFor();
  assert.match(await d.getByLabel('Start time').inputValue(), /^\d{2}:(00|30)$/);
  await A.keyboard.press('Escape');
});

await step('drag an event to a new time in week view', async () => {
  const find = async () => (await (await A.request.get(`${BASE}/api/search?q=Dentist`)).json()).results.find((r) => r.module === 'calendar');
  const id = new URL(BASE + (await find()).link).searchParams.get('event');
  const before = await (await A.request.get(`${BASE}/api/calendar/events/${id}`)).json();
  const date = before.start.slice(0, 10);
  await A.goto(`${BASE}/calendar?view=week&date=${date}`);
  const block = pill(A, 'Dentist').first();
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  await A.mouse.move(box.x + box.width / 2, box.y + 10);
  await A.mouse.down();
  await A.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 4 });
  await A.mouse.move(box.x + box.width / 2, box.y + 10 + 52, { steps: 6 }); // one hour lower
  await A.mouse.up();
  await A.getByText('Dentist — Mia moved').waitFor();
  const t0 = Date.now();
  let after;
  do {
    after = await (await A.request.get(`${BASE}/api/calendar/events/${id}`)).json();
  } while (after.start === before.start && Date.now() - t0 < 5000);
  assert.equal(Date.parse(after.start) - Date.parse(before.start), 3600_000, 'moved by one hour');
  assert.equal(Date.parse(after.end) - Date.parse(after.start), Date.parse(before.end) - Date.parse(before.start), 'duration kept');
  // Keyboard alternative: Alt+ArrowDown moves the focused event 15 minutes later.
  await pill(A, 'Dentist').first().focus();
  await A.keyboard.press('Alt+ArrowDown');
  const t1 = Date.now();
  let kb;
  do {
    kb = await (await A.request.get(`${BASE}/api/calendar/events/${id}`)).json();
  } while (kb.start === after.start && Date.now() - t1 < 5000);
  assert.equal(Date.parse(kb.start) - Date.parse(after.start), 15 * 60_000, 'Alt+ArrowDown = +15 min');
});

await step('"+N more" opens a popover with the whole day', async () => {
  const day = '2031-03-12';
  for (const [i, t] of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].entries()) {
    const r = await A.request.post(`${BASE}/api/calendar/events`, { data: { title: `E2E ${t}`, start: new Date(`${day}T${String(9 + i).padStart(2, '0')}:00:00-07:00`).toISOString(), tz: TZ } });
    assert.equal(r.status(), 201);
  }
  await A.goto(`${BASE}/calendar?view=month&date=${day}`);
  const moreBtn = A.getByRole('button', { name: /^\+\d+ more$/ }).first();
  await moreBtn.click();
  const pop = A.getByRole('dialog', { name: /Events on March 12/ });
  await pop.waitFor();
  await pop.locator('[data-event-id]').filter({ hasText: 'E2E Foxtrot' }).waitFor();
  assert.ok((await pop.locator('[data-event-id]').count()) >= 6);
  await A.screenshot({ path: `${SHOTS}/more-popover-1280-light.png` });
  await A.keyboard.press('Escape');
});

await step('ics export keeps the local zone and edited occurrences', async () => {
  const hit = (await (await A.request.get(`${BASE}/api/search?q=Piano`)).json()).results.find((r) => r.module === 'calendar');
  const id = new URL(BASE + hit.link).searchParams.get('event');
  const ics = await (await A.request.get(`${BASE}/api/calendar/events/${id}/ics`)).text();
  assert.match(ics, new RegExp(`DTSTART;TZID=${TZ}:\\d{8}T170000`));
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.match(ics, /RECURRENCE-ID;TZID=/, 'the moved lesson is exported');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l);
});

await step('series edits: "all" shifts weekdays, "following" ignores one-off overrides', async () => {
  const post = await A.request.post(`${BASE}/api/calendar/events`, {
    data: { title: 'E2E Tutoring', start: '2031-09-01T16:00:00-07:00', end: '2031-09-01T17:00:00-07:00', tz: TZ, rrule: { freq: 'weekly', byweekday: [1, 3] } },
  });
  const ev = await post.json();
  const occs = (await (await A.request.get(`${BASE}/api/calendar/events?from=2031-08-31&to=2031-09-14&tz=${TZ}`)).json()).filter((o) => o.event_id === ev.id);
  const r = await A.request.patch(`${BASE}/api/calendar/events/${ev.id}`, {
    data: { scope: 'all', occurrence: occs[0].occurrence, start: '2031-09-02T16:00:00-07:00', end: '2031-09-02T17:00:00-07:00' },
  });
  assert.deepEqual((await r.json()).rrule.byweekday, [2, 4]);
  const hit = (await (await A.request.get(`${BASE}/api/search?q=Piano`)).json()).results.find((x) => x.module === 'calendar');
  const pid = new URL(BASE + hit.link).searchParams.get('event');
  const list = await (await A.request.get(`${BASE}/api/calendar/events?from=${todayKey}&to=${new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10)}&tz=${TZ}`)).json();
  const moved = list.find((o) => o.title === 'Piano lesson (moved)');
  assert.ok(moved, 'seeded moved lesson');
  const f = await A.request.patch(`${BASE}/api/calendar/events/${pid}`, { data: { scope: 'following', occurrence: moved.occurrence, notes: 'New term' } });
  const nf = await f.json();
  assert.equal(nf.title, 'Piano lesson');
  assert.equal(nf.start, moved.occurrence, 'new series starts on the regular Wednesday slot');
  assert.equal(nf.exceptions, 1, 'the moved lesson is carried into the new series, not lost');
});

await step('phones get a readable 3-day view', async () => {
  const m = await open('alex@hearth.test', { width: 390, height: 844 });
  await m.page.goto(`${BASE}/calendar?view=week`);
  await m.page.locator('[data-day]').first().waitFor();
  await waitCount(m.page.locator('[data-day]'), 3);
  await m.page.getByRole('radio', { name: '3 days' }).waitFor();
  await noOverflow(m.page);
  await m.ctx.close();
});

await step('children see parents’ events as view-only', async () => {
  const mia = await open('mia@hearth.test');
  await mia.page.goto(`${BASE}/calendar?view=agenda`);
  await pill(mia.page, 'Date night').first().click();
  await dialog(mia.page).getByText('View only').waitFor();
  assert.equal(await dialog(mia.page).getByRole('button', { name: 'Edit' }).count(), 0);
  await mia.ctx.close();
});

// ---- screenshots of every main screen / dialog: 1280x800 + 390x844, light + dark ----------------
await step('screenshots', async () => {
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    for (const theme of ['light', 'dark']) {
      const { ctx, page } = await open('alex@hearth.test', { width: w, height: h, theme });
      const tag = `${w}-${theme}`;
      for (const v of ['month', 'week', 'day', 'agenda']) {
        await page.goto(`${BASE}/calendar?view=${v}`);
        await page.locator('[data-event-id]').first().waitFor();
        await page.waitForTimeout(300);
        await noOverflow(page);
        await page.screenshot({ path: `${SHOTS}/${v}-${tag}.png` });
      }
      // Next month: the multi-day trip renders as one spanning bar.
      const next = new Date(Date.parse(`${todayKey}T12:00:00Z`) + 17 * 864e5).toISOString().slice(0, 7); // month of the seeded Tahoe trip
      await page.goto(`${BASE}/calendar?view=month&date=${next}-01`);
      await page.locator('[data-event-id]').first().waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/month-next-${tag}.png` });
      // The seeded dentist visit is on this week's Thursday, which the forward-looking agenda no
      // longer lists from Friday on — open it through its deep link instead.
      const dentist = (await (await page.request.get(`${BASE}/api/search?q=Dentist`)).json()).results.find((r) => r.module === 'calendar');
      await page.goto(`${BASE}${dentist.link}`);
      await dialog(page).getByText('Bright Smile', { exact: false }).waitFor();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/detail-${tag}.png` });
      await dialog(page).getByRole('button', { name: 'Edit' }).click();
      await dialog(page).locator('input[name=title]').waitFor();
      await dialog(page).locator('select').first().selectOption('custom');
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/editor-${tag}.png` });
      await page.keyboard.press('Escape');
      await pill(page, 'Soccer practice').first().click();
      await dialog(page).getByRole('button', { name: 'Delete' }).click();
      await dialog(page).getByTestId('scope-confirm').waitFor();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/scope-${tag}.png` });
      await page.keyboard.press('Escape');
      // Empty state: hide every family member in the filter.
      const fam = await (await page.request.get(`${BASE}/api/family`)).json();
      await page.evaluate((ids) => localStorage.setItem('hearth-cal-hidden-members', JSON.stringify(ids)), fam.members.map((m) => m.id));
      await page.goto(`${BASE}/calendar?view=agenda`);
      await page.getByText('Nothing on the calendar').waitFor();
      await page.getByRole('button', { name: 'Show everyone' }).waitFor();
      await page.screenshot({ path: `${SHOTS}/empty-${tag}.png` });
      await ctx.close();
    }
  }
});

await step('no console errors', async () => {
  assert.deepEqual(errors, []);
});

console.log(`\n${passed} checks passed. Screenshots in ${SHOTS}`);
await browser.close();
