// Shared family calendar — module "calendar", mounted at /api/calendar.
//
// Storage model
//   calendar_events       one row per event / series. All-day events store `start`/`end` as
//                         'YYYY-MM-DD' (end inclusive); timed events store ISO-8601 UTC instants and
//                         keep their wall-clock time in `tz` (IANA) so recurrences survive DST.
//   calendar_exceptions   per-occurrence overrides ("edit this occurrence") and cancellations
//                         ("delete this occurrence"), keyed by the occurrence's ORIGINAL start
//                         (ISO instant for timed series, 'YYYY-MM-DD' for all-day series).
//   calendar_reminders_sent  de-duplicates reminder notifications per occurrence.
// Occurrences are expanded server-side for a requested range: GET /events?from&to&tz.
// Member birthdays are added automatically as yearly all-day entries (kind: 'birthday').
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { cleanStr, httpError, isColor, isDate, toId } from '../util.js';
import {
  dayFromKey, dayKey, dayNum, dayTimeToUtc, describeWhen, isValidTz, localClock, localDay, occurrenceIndex, offsetMs,
  seriesDays, weekday, ymd, zonedParts,
} from './calendar/time.js';

export const name = 'calendar';

const DAY = 86_400_000;
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const DEFAULT_COLOR = '#0090FF';
const REMINDER_WINDOW = 15 * 60_000; // reminders due within the last 15 min still fire (server restarts, 30 s tick)
const ALL_DAY_REMINDER_HOUR = 9;
const DEMO_TZ = 'America/Los_Angeles'; // all-day reminders are relative to 9:00 AM on the day

export const migrations = [
  `CREATE TABLE IF NOT EXISTS calendar_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     notes TEXT,
     location TEXT,
     all_day INTEGER NOT NULL DEFAULT 0,
     start TEXT NOT NULL,
     "end" TEXT NOT NULL,
     tz TEXT NOT NULL DEFAULT 'UTC',
     color TEXT,
     rrule TEXT,
     reminders TEXT NOT NULL DEFAULT '[]',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS calendar_events_family ON calendar_events(family_id, start)`,
  `CREATE TABLE IF NOT EXISTS calendar_event_attendees (
     event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (event_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS calendar_exceptions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
     occurrence TEXT NOT NULL,
     cancelled INTEGER NOT NULL DEFAULT 0,
     title TEXT, notes TEXT, location TEXT, all_day INTEGER, start TEXT, "end" TEXT, color TEXT,
     attendees TEXT, reminders TEXT,
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     UNIQUE (event_id, occurrence))`,
  `CREATE TABLE IF NOT EXISTS calendar_reminders_sent (
     event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
     occurrence TEXT NOT NULL,
     minutes INTEGER NOT NULL,
     sent_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (event_id, occurrence, minutes))`,
];

// ---------------------------------------------------------------------------------------------
// Loading + expansion
// ---------------------------------------------------------------------------------------------

const parseJson = (s, fallback) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** Load event rows (optionally only some ids / a coarse date window) with attendees + exceptions. */
function loadEvents(db, familyId, { ids, fromKey, toKey, withReminders } = {}) {
  const where = ['e.family_id = ?'];
  const args = [familyId];
  if (ids) {
    if (!ids.length) return [];
    where.push(`e.id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (fromKey) {
    where.push('(e.rrule IS NOT NULL OR e."end" >= ? OR EXISTS (SELECT 1 FROM calendar_exceptions x WHERE x.event_id = e.id AND x."end" >= ?))');
    args.push(fromKey, fromKey);
  }
  if (toKey) {
    where.push('(e.start <= ? OR EXISTS (SELECT 1 FROM calendar_exceptions x WHERE x.event_id = e.id AND x.start <= ?))');
    args.push(toKey, toKey);
  }
  if (withReminders) where.push(`(e.reminders != '[]' OR EXISTS (SELECT 1 FROM calendar_exceptions x WHERE x.event_id = e.id AND x.reminders IS NOT NULL AND x.reminders != '[]'))`);
  const rows = db
    .prepare(
      `SELECT e.*, u.color AS creator_color, u.name AS creator_name
         FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by
        WHERE ${where.join(' AND ')} ORDER BY e.start, e.id`,
    )
    .all(...args);
  if (!rows.length) return [];
  const idList = rows.map((r) => r.id);
  const marks = idList.map(() => '?').join(',');
  const att = new Map();
  for (const a of db.prepare(`SELECT event_id, user_id FROM calendar_event_attendees WHERE event_id IN (${marks}) ORDER BY rowid`).all(...idList)) {
    if (!att.has(a.event_id)) att.set(a.event_id, []);
    att.get(a.event_id).push(a.user_id);
  }
  const exc = new Map();
  for (const x of db.prepare(`SELECT * FROM calendar_exceptions WHERE event_id IN (${marks})`).all(...idList)) {
    if (!exc.has(x.event_id)) exc.set(x.event_id, new Map());
    exc.get(x.event_id).set(x.occurrence, x);
  }
  return rows.map((r) => hydrate(r, att.get(r.id) ?? [], exc.get(r.id) ?? new Map()));
}

function hydrate(r, attendees, exceptions) {
  return {
    ...r,
    all_day: !!r.all_day,
    rrule: parseJson(r.rrule, null),
    reminders: parseJson(r.reminders, []),
    attendees,
    exceptions,
  };
}

/** Local day of an occurrence start in its own frame (all-day: the date; timed: the tz wall date). */
const startDayOf = (allDay, start, tz) => (allDay ? dayFromKey(start) : localDay(Date.parse(start), tz));
const endDayOf = (allDay, end, tz) => (allDay ? dayFromKey(end) : localDay(Math.max(Date.parse(end) - 1, 0), tz));

/** Values of a generated (un-overridden) occurrence starting on `day`. */
function generated(ev, day) {
  if (ev.all_day) {
    const span = dayFromKey(ev.end) - dayFromKey(ev.start);
    return { key: dayKey(day), start: dayKey(day), end: dayKey(day + span) };
  }
  const startMs = Date.parse(ev.start);
  const dur = Date.parse(ev.end) - startMs;
  if (!ev.rrule) return { key: new Date(startMs).toISOString(), start: new Date(startMs).toISOString(), end: new Date(startMs + dur).toISOString() };
  const { h, mi } = localClock(startMs, ev.tz);
  const s = dayTimeToUtc(day, h, mi, ev.tz) + (((startMs % 60_000) + 60_000) % 60_000); // keep seconds
  const iso = new Date(s).toISOString();
  return { key: iso, start: iso, end: new Date(s + dur).toISOString() };
}

const untilDayOf = (rule) => (rule?.until ? dayFromKey(rule.until) : Infinity);
const countOf = (rule) => (rule?.count ? rule.count : Infinity);

/** Is `key` a real occurrence of the series (respecting until/count)? Returns its day or null. */
function validOccurrenceDay(ev, key) {
  if (typeof key !== 'string') return null;
  let day;
  if (ev.all_day) {
    if (!isDate(key)) return null;
    day = dayFromKey(key);
  } else {
    const ms = Date.parse(key);
    if (Number.isNaN(ms)) return null;
    day = localDay(ms, ev.tz);
    if (generated(ev, day).key !== new Date(ms).toISOString()) return null;
  }
  const startDay = startDayOf(ev.all_day, ev.start, ev.tz);
  if (day < startDay || day > untilDayOf(ev.rrule)) return null;
  const idx = occurrenceIndex(ev.rrule, startDay, day);
  if (idx < 0 || idx >= countOf(ev.rrule)) return null;
  return day;
}

/** Build the API object for one occurrence (applying an override row when present). */
function occurrenceObject(ev, gen, override) {
  const o = override && !override.cancelled ? override : null;
  const allDay = o && o.all_day !== null ? !!o.all_day : ev.all_day;
  const color = (o ? o.color : ev.color) || ev.creator_color || DEFAULT_COLOR;
  const recurring = !!ev.rrule;
  return {
    id: recurring ? `${ev.id}:${gen.key}` : String(ev.id),
    event_id: ev.id,
    occurrence: recurring ? gen.key : null,
    kind: 'event',
    title: o?.title ?? ev.title,
    start: o?.start ?? gen.start,
    end: o?.end ?? gen.end,
    all_day: allDay,
    tz: ev.tz,
    color,
    custom_color: (o ? o.color : ev.color) || null,
    location: o ? o.location : ev.location,
    notes: o ? o.notes : ev.notes,
    attendees: o?.attendees ? parseJson(o.attendees, []) : ev.attendees,
    reminders: o?.reminders ? parseJson(o.reminders, []) : ev.reminders,
    rrule: ev.rrule,
    recurring,
    exception: !!o,
    created_by: ev.created_by,
    creator_name: ev.creator_name ?? null,
  };
}

/** Does an occurrence overlap the range? */
function overlaps(occ, range) {
  if (occ.all_day) return dayFromKey(occ.start) <= range.toDay && dayFromKey(occ.end) >= range.fromDay;
  const s = Date.parse(occ.start);
  const e = Date.parse(occ.end);
  return s < range.toMs && (e > range.fromMs || (e === s && s >= range.fromMs));
}

/** All occurrences of one event overlapping the range. */
function expandEvent(ev, range) {
  const out = [];
  const seen = new Set();
  const startDay = startDayOf(ev.all_day, ev.start, ev.tz);
  const spanDays = endDayOf(ev.all_day, ev.end, ev.tz) - startDay;
  const days = seriesDays(ev.rrule, startDay, {
    minDay: range.fromDay - spanDays - 2,
    maxDay: range.toDay + 2,
    untilDay: untilDayOf(ev.rrule),
    count: countOf(ev.rrule),
  });
  for (const { day } of days) {
    const gen = generated(ev, day);
    const key = ev.rrule ? gen.key : null;
    const override = key ? ev.exceptions.get(key) : null;
    if (key) seen.add(key);
    if (override?.cancelled) continue;
    const occ = occurrenceObject(ev, gen, override);
    if (overlaps(occ, range)) out.push(occ);
  }
  // Occurrences moved INTO the range from outside it.
  if (ev.rrule) {
    for (const [key, x] of ev.exceptions) {
      if (x.cancelled || seen.has(key) || !x.start) continue;
      const day = validOccurrenceDay(ev, key);
      if (day === null) continue;
      const occ = occurrenceObject(ev, generated(ev, day), x);
      if (overlaps(occ, range)) out.push(occ);
    }
  }
  return out;
}

/** Member birthdays as yearly all-day occurrences in the range. */
function birthdayOccurrences(db, familyId, range) {
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.color, u.birthday, m.nickname FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = ? AND u.birthday IS NOT NULL`,
    )
    .all(familyId);
  const out = [];
  for (const u of members) {
    if (!isDate(u.birthday)) continue;
    const b = ymd(dayFromKey(u.birthday));
    const first = u.nickname || u.name.split(/\s+/)[0];
    for (let y = ymd(range.fromDay).y; y <= ymd(range.toDay).y; y++) {
      if (y < b.y) continue;
      // Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
      const d = b.m === 2 && b.d === 29 && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1 ? 28 : b.d;
      const day = dayNum(y, b.m, d);
      if (day < range.fromDay || day > range.toDay) continue;
      const age = y - b.y;
      const key = dayKey(day);
      out.push({
        id: `birthday-${u.id}-${y}`,
        event_id: null,
        occurrence: key,
        kind: 'birthday',
        user_id: u.id,
        title: `${first}'s birthday`,
        start: key,
        end: key,
        all_day: true,
        tz: null,
        color: u.color || DEFAULT_COLOR,
        custom_color: null,
        location: null,
        notes: age > 0 ? `Turns ${age}` : 'Born today!',
        age,
        attendees: [u.id],
        reminders: [],
        rrule: { freq: 'yearly', interval: 1 },
        recurring: true,
        exception: false,
        created_by: null,
        creator_name: null,
      });
    }
  }
  return out;
}

const sortKey = (o, tz) => {
  if (o.all_day) return dayTimeToUtc(dayFromKey(o.start), 0, 0, tz) - 1;
  return Date.parse(o.start);
};

/** Every occurrence (events + birthdays) in a range, sorted. */
export function listOccurrences(db, familyId, range, { ids, birthdays = true, withReminders = false } = {}) {
  const events = loadEvents(db, familyId, {
    ids,
    fromKey: dayKey(range.fromDay - 3),
    toKey: dayKey(range.toDay + 3) + '~',
    withReminders,
  });
  const out = [];
  for (const ev of events) out.push(...expandEvent(ev, range));
  if (birthdays && !ids) out.push(...birthdayOccurrences(db, familyId, range));
  const tz = range.tz;
  out.sort((a, b) => sortKey(a, tz) - sortKey(b, tz) || (b.all_day - a.all_day) || a.title.localeCompare(b.title));
  return out;
}

/** Range from ISO instants or 'YYYY-MM-DD' (local midnight in tz). `to` is exclusive. */
export function makeRange(from, to, tz) {
  const toMsOf = (v, field) => {
    if (typeof v !== 'string' || !v) throw httpError(400, `${field} is required`);
    if (isDate(v)) return dayTimeToUtc(dayFromKey(v), 0, 0, tz);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) throw httpError(400, `${field} must be a date or an ISO timestamp`);
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw httpError(400, `${field} must be a date or an ISO timestamp`);
    return ms;
  };
  const fromMs = toMsOf(from, 'from');
  const toMs = toMsOf(to, 'to');
  if (toMs <= fromMs) throw httpError(400, '"to" must be after "from"');
  if (toMs - fromMs > 400 * DAY) throw httpError(400, 'Range is too long (max 400 days)');
  return { fromMs, toMs, fromDay: localDay(fromMs, tz), toDay: localDay(toMs - 1, tz), tz };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function memberIds(db, familyId) {
  return new Set(db.prepare('SELECT user_id FROM memberships WHERE family_id = ?').all(familyId).map((r) => r.user_id));
}

function parseRrule(raw, startDay) {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Repeat rule is invalid');
  if (raw.freq === 'none' || raw.freq === null || raw.freq === undefined || raw.freq === '') return null;
  if (!FREQS.includes(raw.freq)) throw httpError(400, 'Repeat frequency must be daily, weekly, monthly or yearly');
  const interval = raw.interval === undefined || raw.interval === null ? 1 : Number(raw.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw httpError(400, 'Repeat interval must be between 1 and 99');
  const rule = { freq: raw.freq, interval };
  if (raw.freq === 'weekly') {
    let days = raw.byweekday;
    if (days === undefined || days === null) days = [weekday(startDay)];
    if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw httpError(400, 'Choose at least one weekday');
    }
    rule.byweekday = [...new Set(days)].sort((a, b) => a - b);
  }
  if (raw.freq === 'monthly') {
    const mode = raw.monthly ?? 'day';
    if (mode !== 'day' && mode !== 'weekday') throw httpError(400, 'Monthly repeat must be "day" or "weekday"');
    rule.monthly = mode;
  }
  const hasUntil = raw.until !== undefined && raw.until !== null && raw.until !== '';
  const hasCount = raw.count !== undefined && raw.count !== null && raw.count !== '';
  if (hasUntil && hasCount) throw httpError(400, 'A repeat can end on a date or after a number of times, not both');
  if (hasUntil) {
    if (!isDate(raw.until)) throw httpError(400, 'Repeat end date is invalid');
    if (dayFromKey(raw.until) < startDay) throw httpError(400, 'Repeat end date must be on or after the start date');
    rule.until = raw.until;
  }
  if (hasCount) {
    const count = Number(raw.count);
    if (!Number.isInteger(count) || count < 1 || count > 730) throw httpError(400, 'Repeat count must be between 1 and 730');
    rule.count = count;
  }
  return rule;
}

function parseReminders(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError(400, 'Reminders must be a list of minutes');
  const set = new Set();
  for (const m of raw) {
    const n = Number(m);
    if (!Number.isInteger(n) || n < 0 || n > 40320) throw httpError(400, 'Reminders must be between 0 minutes and 4 weeks before');
    set.add(n);
  }
  if (set.size > 5) throw httpError(400, 'At most 5 reminders per event');
  return [...set].sort((a, b) => a - b);
}

function parseAttendees(db, familyId, raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError(400, 'Attendees must be a list of family members');
  const members = memberIds(db, familyId);
  const out = [];
  for (const v of raw) {
    const id = Number(v);
    if (!Number.isInteger(id) || !members.has(id)) throw httpError(400, 'Attendees must be members of this family');
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Normalize an event payload, falling back to `base` for fields that are not provided.
 * Returns { title, notes, location, all_day, start, end, tz, color, attendees, rrule, reminders }.
 */
function parseInput(db, familyId, body, base = {}, { allowRrule = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid request body');
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const pick = (k) => (has(k) ? body[k] : base[k]);

  const title = cleanStr(pick('title'), { field: 'Title', required: true, max: 120 });
  const notes = cleanStr(pick('notes'), { field: 'Notes', max: 4000 });
  const location = cleanStr(pick('location'), { field: 'Location', max: 200 });

  const allDayRaw = pick('all_day');
  if (allDayRaw !== undefined && typeof allDayRaw !== 'boolean') throw httpError(400, 'all_day must be true or false');
  const all_day = !!allDayRaw;

  const tz = pick('tz') ?? 'UTC';
  if (!isValidTz(tz)) throw httpError(400, 'Unknown time zone');

  let start = pick('start');
  let end = has('end') ? body.end : has('start') || has('all_day') ? undefined : base.end;
  if (all_day) {
    if (!isDate(start)) throw httpError(400, 'Start must be a valid date (YYYY-MM-DD)');
    if (end === undefined || end === null || end === '') end = start;
    if (!isDate(end)) throw httpError(400, 'End must be a valid date (YYYY-MM-DD)');
    const span = dayFromKey(end) - dayFromKey(start);
    if (span < 0) throw httpError(400, 'The event must end on or after its start date');
    if (span > 366) throw httpError(400, 'Events can last at most a year');
  } else {
    const parse = (v, field) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) {
        throw httpError(400, `${field} must be a valid date and time`);
      }
      return Date.parse(v);
    };
    const s = parse(start, 'Start');
    const e = end === undefined || end === null || end === '' ? s + 3_600_000 : parse(end, 'End');
    if (e < s) throw httpError(400, 'The event must end after it starts');
    if (e - s > 60 * DAY) throw httpError(400, 'Timed events can last at most 60 days');
    start = new Date(s).toISOString();
    end = new Date(e).toISOString();
  }

  const color = pick('color') ?? null;
  if (color !== null && !isColor(color)) throw httpError(400, 'Color must be a hex color like #5B5BD6');

  const attendees = parseAttendees(db, familyId, pick('attendees'));
  const reminders = parseReminders(pick('reminders'));
  const startDay = startDayOf(all_day, start, tz);
  const rrule = allowRrule ? parseRrule(pick('rrule'), startDay) : null;
  return { title, notes, location, all_day, start, end, tz, color, attendees, rrule, reminders };
}

// ---------------------------------------------------------------------------------------------
// Serialization + helpers
// ---------------------------------------------------------------------------------------------

function masterObject(ev) {
  return {
    id: ev.id,
    family_id: ev.family_id,
    title: ev.title,
    notes: ev.notes,
    location: ev.location,
    all_day: ev.all_day,
    start: ev.start,
    end: ev.end,
    tz: ev.tz,
    color: ev.color || ev.creator_color || DEFAULT_COLOR,
    custom_color: ev.color || null,
    rrule: ev.rrule,
    reminders: ev.reminders,
    attendees: ev.attendees,
    recurring: !!ev.rrule,
    created_by: ev.created_by,
    creator_name: ev.creator_name ?? null,
    created_at: ev.created_at,
    updated_at: ev.updated_at,
    exceptions: ev.exceptions ? ev.exceptions.size : 0,
  };
}

const canEdit = (req, ev) => req.role !== 'child' || ev.created_by === req.user.id;

function withPerms(req, occ) {
  return { ...occ, can_edit: occ.kind === 'event' && canEdit(req, occ) };
}

function getEvent(db, familyId, id) {
  const [ev] = loadEvents(db, familyId, { ids: [id] });
  if (!ev) throw httpError(404, 'Event not found');
  return ev;
}

/** Current (possibly overridden) values of one occurrence of a series. */
function resolveOccurrence(ev, key) {
  const day = validOccurrenceDay(ev, key);
  if (day === null) throw httpError(400, 'That occurrence is not part of this event');
  const gen = generated(ev, day);
  const x = ev.exceptions.get(gen.key);
  if (x?.cancelled) throw httpError(404, 'That occurrence was deleted');
  return { day, gen, occ: occurrenceObject(ev, gen, x) };
}

function linkFor(ev, occ) {
  const tz = ev.tz || 'UTC';
  const date = occ ? dayKey(startDayOf(occ.all_day, occ.start, tz)) : dayKey(startDayOf(ev.all_day, ev.start, tz));
  const params = new URLSearchParams({ event: String(ev.id ?? ev.event_id), date });
  if (occ?.occurrence) params.set('occurrence', occ.occurrence);
  return `/calendar?${params}`;
}

/** The requesting user's zone: ?tz=, else the X-Timezone header / remembered zone (ctx.time). */
function requestTz(ctx, req) {
  const cand = req.query?.tz;
  if (cand && isValidTz(cand)) return cand;
  const tz = ctx.time?.tz(req);
  return tz && isValidTz(tz) ? tz : 'UTC';
}

const recipientsOf = (ev) => (ev.attendees?.length ? ev.attendees : ev.created_by ? [ev.created_by] : []);

function insertAttendees(db, eventId, ids) {
  db.prepare('DELETE FROM calendar_event_attendees WHERE event_id = ?').run(eventId);
  const ins = db.prepare('INSERT INTO calendar_event_attendees (event_id, user_id) VALUES (?, ?)');
  for (const id of ids) ins.run(eventId, id);
}

function insertEvent(db, familyId, userId, v) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO calendar_events (family_id, title, notes, location, all_day, start, "end", tz, color, rrule, reminders, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(familyId, v.title, v.notes, v.location, v.all_day ? 1 : 0, v.start, v.end, v.tz, v.color, v.rrule ? JSON.stringify(v.rrule) : null,
      JSON.stringify(v.reminders ?? []), userId);
  const id = Number(lastInsertRowid);
  insertAttendees(db, id, v.attendees ?? []);
  return id;
}

function updateEventRow(db, id, v) {
  db.prepare(
    `UPDATE calendar_events SET title = ?, notes = ?, location = ?, all_day = ?, start = ?, "end" = ?, tz = ?, color = ?, rrule = ?,
       reminders = ?, updated_at = ? WHERE id = ?`,
  ).run(v.title, v.notes, v.location, v.all_day ? 1 : 0, v.start, v.end, v.tz, v.color, v.rrule ? JSON.stringify(v.rrule) : null,
    JSON.stringify(v.reminders ?? []), new Date().toISOString(), id);
  insertAttendees(db, id, v.attendees ?? []);
}

function upsertException(db, eventId, key, v) {
  db.prepare(
    `INSERT INTO calendar_exceptions (event_id, occurrence, cancelled, title, notes, location, all_day, start, "end", color, attendees, reminders, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, occurrence) DO UPDATE SET cancelled = excluded.cancelled, title = excluded.title, notes = excluded.notes,
       location = excluded.location, all_day = excluded.all_day, start = excluded.start, "end" = excluded."end", color = excluded.color,
       attendees = excluded.attendees, reminders = excluded.reminders, updated_at = excluded.updated_at`,
  ).run(
    eventId, key, v ? 0 : 1,
    v?.title ?? null, v?.notes ?? null, v?.location ?? null, v ? (v.all_day ? 1 : 0) : null, v?.start ?? null, v?.end ?? null,
    v?.color ?? null, v ? JSON.stringify(v.attendees ?? []) : null, v ? JSON.stringify(v.reminders ?? []) : null, new Date().toISOString(),
  );
  db.prepare('UPDATE calendar_events SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), eventId);
}

const DETAIL_FIELDS = ['title', 'notes', 'location', 'color', 'attendees', 'reminders'];
const detailOf = (o, k) => (k === 'attendees' || k === 'reminders' ? JSON.stringify(o[k] ?? []) : o[k] ?? null);

/**
 * After a split, the detail fields the user just edited also apply to the moved per-day edits —
 * except where that day had overridden the same field itself.
 */
function applyEditsToExceptions(db, eventId, rows, fields, oldEv, v) {
  const edited = DETAIL_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(fields, k) && detailOf(oldEv, k) !== detailOf(v, k));
  if (!edited.length || !rows.length) return;
  const get = db.prepare('SELECT * FROM calendar_exceptions WHERE id = ? AND event_id = ?');
  for (const x of rows) {
    const row = get.get(x.id, eventId);
    if (!row || row.cancelled) continue;
    const next = edited.filter((k) => (row[k] ?? null) === detailOf(oldEv, k));
    if (!next.length) continue;
    db.prepare(`UPDATE calendar_exceptions SET ${next.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...next.map((k) => detailOf(v, k)), x.id);
  }
}

/** End a series just before `day` (used by "this and following"). */
function truncateSeries(db, ev, day, key, { keepLater = false } = {}) {
  const rule = { ...ev.rrule, until: dayKey(day - 1) };
  delete rule.count;
  db.prepare('UPDATE calendar_events SET rrule = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rule), new Date().toISOString(), ev.id);
  if (!keepLater) db.prepare('DELETE FROM calendar_exceptions WHERE event_id = ? AND occurrence >= ?').run(ev.id, key);
}

const timingOf = (v) => JSON.stringify([v.all_day, v.start, v.end, v.tz, v.rrule ?? null]);
const sameRule = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Weekly rule with its weekdays moved by `shift` days (a series dragged to another weekday). */
function shiftWeekdays(rule, shift) {
  if (!rule || rule.freq !== 'weekly' || !rule.byweekday || ((shift % 7) + 7) % 7 === 0) return rule;
  return { ...rule, byweekday: [...new Set(rule.byweekday.map((d) => (((d + shift) % 7) + 7) % 7))].sort((x, y) => x - y) };
}

/** Move an event's start/end by whole local days (keeps wall-clock time in its zone). */
function shiftByDays(v, n) {
  if (!n) return v;
  if (v.all_day) return { ...v, start: dayKey(dayFromKey(v.start) + n), end: dayKey(dayFromKey(v.end) + n) };
  const sMs = Date.parse(v.start);
  const { day, h, mi } = localClock(sMs, v.tz);
  const s = dayTimeToUtc(day + n, h, mi, v.tz) + (((sMs % 60_000) + 60_000) % 60_000);
  return { ...v, start: new Date(s).toISOString(), end: new Date(s + (Date.parse(v.end) - sMs)).toISOString() };
}

/** A weekly series always starts on one of its weekdays, so its first occurrence is never lost. */
function alignSeries(v) {
  if (v.rrule?.freq !== 'weekly' || !v.rrule.byweekday?.length) return v;
  const startDay = startDayOf(v.all_day, v.start, v.tz);
  let n = 0;
  while (n < 7 && !v.rrule.byweekday.includes(weekday(startDay + n))) n++;
  const out = shiftByDays(v, n);
  if (out.rrule.until && dayFromKey(out.rrule.until) < startDay + n) throw httpError(400, 'The repeat ends before its first occurrence');
  return out;
}

/**
 * Re-home exception rows onto `toEv` (same event after a timing change, or the new half of a split
 * series), shifting their keys by `dayShift`. Rows that no longer land on a real occurrence are
 * dropped; returns how many were dropped.
 */
function moveExceptions(db, fromEv, toEv, rows, dayShift) {
  if (!rows.length) return 0;
  const park = db.prepare("UPDATE calendar_exceptions SET occurrence = '~' || id WHERE id = ?");
  const move = db.prepare('UPDATE calendar_exceptions SET event_id = ?, occurrence = ? WHERE id = ?');
  const retime = db.prepare('UPDATE calendar_exceptions SET start = ?, "end" = ? WHERE id = ?');
  const full = db.prepare('SELECT start, "end" FROM calendar_exceptions WHERE id = ?');
  const drop = db.prepare('DELETE FROM calendar_exceptions WHERE id = ?');
  for (const x of rows) park.run(x.id);
  let dropped = 0;
  for (const x of rows) {
    const oldDay = startDayOf(fromEv.all_day, x.occurrence, fromEv.tz);
    const next = generated(toEv, oldDay + dayShift);
    if (validOccurrenceDay(toEv, next.key) === null) {
      drop.run(x.id);
      dropped++;
      continue;
    }
    move.run(toEv.id, next.key, x.id);
    // An override that only changed details (not its time) follows the series' new timing.
    const row = full.get(x.id);
    const prev = generated(fromEv, oldDay);
    if (row?.start && row.start === prev.start && row.end === prev.end) retime.run(next.start, next.end, x.id);
  }
  return dropped;
}

// ---------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------

function relativeWhen(occ, base, now, tz) {
  if (occ.all_day) {
    const diff = dayFromKey(occ.start) - localDay(now, tz);
    if (diff <= 0) return 'is today';
    if (diff === 1) return 'is tomorrow';
    if (diff < 7) return `is in ${diff} days`;
    return `is in ${Math.round(diff / 7)} week${Math.round(diff / 7) === 1 ? '' : 's'}`;
  }
  const mins = Math.round((base - now) / 60_000);
  if (mins <= 1) return 'is starting now';
  if (mins < 60) return `starts in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (mins < 24 * 60) return `starts in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(mins / 1440);
  if (days === 1) return 'is tomorrow';
  return `is in ${days} days`;
}

/**
 * Send due reminder notifications. Runs on an interval (every 30 s) and is exported for tests.
 * A reminder is due at (start − minutes); all-day events count from 9:00 AM on their first day.
 */
export function runReminders(ctx, now = Date.now()) {
  const { db } = ctx;
  const families = db
    .prepare(
      `SELECT DISTINCT e.family_id FROM calendar_events e
        WHERE e.reminders != '[]' OR EXISTS (SELECT 1 FROM calendar_exceptions x WHERE x.event_id = e.id AND x.reminders IS NOT NULL AND x.reminders != '[]')`,
    )
    .all()
    .map((r) => r.family_id);
  const mark = db.prepare('INSERT OR IGNORE INTO calendar_reminders_sent (event_id, occurrence, minutes) VALUES (?, ?, ?)');
  db.prepare('DELETE FROM calendar_reminders_sent WHERE sent_at < ?').run(new Date(now - 45 * DAY).toISOString());
  let sent = 0;
  for (const familyId of families) {
    const range = { fromMs: now - 2 * DAY, toMs: now + 29 * DAY, tz: 'UTC' };
    range.fromDay = localDay(range.fromMs, 'UTC') - 1;
    range.toDay = localDay(range.toMs, 'UTC') + 1;
    const occs = listOccurrences(db, familyId, range, { birthdays: false, withReminders: true });
    const events = new Map();
    for (const occ of occs) {
      if (!occ.reminders?.length) continue;
      const tz = occ.tz || 'UTC';
      const base = occ.all_day ? dayTimeToUtc(dayFromKey(occ.start), ALL_DAY_REMINDER_HOUR, 0, tz) : Date.parse(occ.start);
      for (const m of occ.reminders) {
        const due = base - m * 60_000;
        if (due > now || due <= now - REMINDER_WINDOW) continue;
        // Never remind about something that already started (e.g. an event created after its reminder time).
        if (!occ.all_day && base < now - 60_000) continue;
        // Keyed on the actual (possibly moved) start, so a rescheduled occurrence reminds again.
        const key = occ.occurrence ? `${occ.occurrence}|${occ.start}` : occ.start;
        if (!mark.run(occ.event_id, key, m).changes) continue;
        if (!events.has(occ.event_id)) events.set(occ.event_id, getEvent(db, familyId, occ.event_id));
        const ev = events.get(occ.event_id);
        const userIds = occ.attendees?.length ? occ.attendees : recipientsOf(ev);
        const whenText = describeWhen(occ, tz, !occ.all_day);
        ctx.notify({
          familyId,
          userIds,
          module: 'calendar',
          title: `${occ.title} ${relativeWhen(occ, base, now, tz)}`,
          body: [whenText, occ.location].filter(Boolean).join(' · '),
          link: linkFor(ev, occ),
        });
        ctx.broadcast(familyId, 'calendar.reminder', { event_id: occ.event_id, occurrence: key, minutes: m });
        sent++;
      }
    }
  }
  return sent;
}

/**
 * In-place upgrade for databases created before ids used AUTOINCREMENT (ids of deleted events are
 * then never reused, so stale links can't open a different event). Idempotent; runs at boot.
 */
export function upgradeSchema(db) {
  const needs = ['calendar_events', 'calendar_exceptions'].filter((t) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    return row && !/AUTOINCREMENT/i.test(row.sql);
  });
  if (!needs.length) return false;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const t of needs) {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const next = sql
        .replace(/^CREATE TABLE(?: IF NOT EXISTS)?\s+"?\w+"?/i, `CREATE TABLE ${t}__new`)
        .replace(/\bid INTEGER PRIMARY KEY\b(?! AUTOINCREMENT)/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT');
      db.exec(next);
      db.exec(`INSERT INTO ${t}__new SELECT * FROM ${t}`);
      db.exec(`DROP TABLE ${t}`);
      db.exec(`ALTER TABLE ${t}__new RENAME TO ${t}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS calendar_events_family ON calendar_events(family_id, start)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const r = Router();
  upgradeSchema(db);

  // Lightweight reminder checker. Unref'd so it never keeps the process (or a test run) alive.
  if (process.env.HEARTH_CALENDAR_REMINDERS !== 'off') {
    const tick = () => {
      try {
        runReminders(ctx);
      } catch (err) {
        if (/not open|closed/i.test(String(err?.message))) clearInterval(timer);
        else console.error('[calendar] reminder check failed:', err.message);
      }
    };
    const timer = setInterval(tick, 30_000);
    timer.unref?.();
    setTimeout(tick, 3_000).unref?.();
  }

  r.get('/', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE family_id = ?').get(req.family.id).n;
    res.json({ ok: true, module: name, events: count });
  });

  // Occurrences in a range.
  r.get('/events', (req, res) => {
    if (req.query.tz !== undefined && !isValidTz(req.query.tz)) throw httpError(400, 'Unknown time zone');
    const tz = requestTz(ctx, req);
    const range = makeRange(req.query.from, req.query.to, tz);
    const birthdays = req.query.birthdays !== '0' && req.query.birthdays !== 'false';
    let occs = listOccurrences(db, req.family.id, range, { birthdays });
    if (req.query.member) {
      const ids = String(req.query.member).split(',').map(Number).filter(Number.isInteger);
      occs = occs.filter((o) => (o.attendees.length ? o.attendees : [o.created_by]).some((id) => ids.includes(id)));
    }
    res.json(occs.map((o) => withPerms(req, o)));
  });

  // Upcoming occurrences from now (agenda "next up" list).
  r.get('/upcoming', (req, res) => {
    const tz = requestTz(ctx, req);
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const now = Date.now();
    const range = makeRange(new Date(now).toISOString(), new Date(now + days * DAY).toISOString(), tz);
    res.json(listOccurrences(db, req.family.id, range).slice(0, limit).map((o) => withPerms(req, o)));
  });

  // One event (series) + a resolved occurrence (?occurrence=<key>, else the next upcoming one).
  r.get('/events/:id', (req, res) => {
    const ev = getEvent(db, req.family.id, toId(req.params.id));
    let occ = null;
    if (ev.rrule) {
      if (req.query.occurrence) {
        occ = resolveOccurrence(ev, String(req.query.occurrence)).occ;
      } else {
        const now = Date.now();
        const range = { fromMs: now, toMs: now + 400 * DAY, fromDay: localDay(now, ev.tz), toDay: localDay(now + 400 * DAY, ev.tz), tz: ev.tz };
        occ = expandEvent(ev, range)[0] ?? null;
        if (!occ) {
          const startDay = startDayOf(ev.all_day, ev.start, ev.tz);
          const first = seriesDays(ev.rrule, startDay, { maxDay: startDay + 400, count: 1 })[0];
          if (first) occ = occurrenceObject(ev, generated(ev, first.day), ev.exceptions.get(generated(ev, first.day).key));
        }
      }
    } else {
      occ = occurrenceObject(ev, { key: null, start: ev.start, end: ev.end }, null);
    }
    res.json({ ...masterObject(ev), can_edit: canEdit(req, ev), occurrence: occ ? withPerms(req, occ) : null });
  });

  r.post('/events', (req, res) => {
    const v = alignSeries(parseInput(db, req.family.id, req.body, { tz: req.body?.tz ?? ctx.time.tz(req) }));
    const id = ctx.tx(db, () => insertEvent(db, req.family.id, req.user.id, v));
    const ev = getEvent(db, req.family.id, id);
    const out = masterObject(ev);
    ctx.broadcast(req.family.id, 'calendar.event.created', { id, title: ev.title });
    const first = { all_day: ev.all_day, start: ev.start };
    const link = linkFor(ev, null);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'calendar', verb: 'created', entityId: id,
      summary: `added ${ev.rrule ? 'the recurring event' : 'the event'} ${ev.title} · ${describeWhen(first, ev.tz, !ev.all_day)}`,
      link,
    });
    ctx.notify({
      familyId: req.family.id, userIds: ev.attendees, module: 'calendar', excludeUserId: req.user.id,
      title: `${req.user.name.split(/\s+/)[0]} added you to ${ev.title}`,
      body: [describeWhen(first, ev.tz, !ev.all_day), ev.location].filter(Boolean).join(' · '),
      link,
    });
    res.status(201).json({ ...out, can_edit: true });
  });

  r.patch('/events/:id', (req, res) => {
    const familyId = req.family.id;
    const ev = getEvent(db, familyId, toId(req.params.id));
    if (!canEdit(req, ev)) throw httpError(403, 'Only the person who created this event or a parent can change it');
    const body = req.body ?? {};
    let scope = body.scope ?? 'all';
    if (!['all', 'this', 'following'].includes(scope)) throw httpError(400, 'Scope must be "this", "following" or "all"');
    if (!ev.rrule && scope !== 'all') scope = 'all';
    const key = body.occurrence ?? null;
    const actorFirst = req.user.name.split(/\s+/)[0];
    const fields = { ...body };
    delete fields.scope;
    delete fields.occurrence;

    // --- this occurrence only --------------------------------------------------------------
    if (scope === 'this') {
      if (!key) throw httpError(400, 'Which occurrence? (occurrence is required)');
      const { gen, occ } = resolveOccurrence(ev, key);
      const v = parseInput(db, familyId, fields, { ...occ, color: occ.custom_color, tz: ev.tz }, { allowRrule: false });
      const moved = timingOf({ ...occ, rrule: null }) !== timingOf({ ...v, tz: ev.tz, rrule: null });
      upsertException(db, ev.id, gen.key, v);
      const fresh = getEvent(db, familyId, ev.id);
      const updated = occurrenceObject(fresh, gen, fresh.exceptions.get(gen.key));
      ctx.broadcast(familyId, 'calendar.event.updated', { id: ev.id, occurrence: gen.key });
      if (moved) {
        ctx.notify({
          familyId, userIds: updated.attendees, module: 'calendar', excludeUserId: req.user.id,
          title: `${actorFirst} moved ${updated.title}`,
          body: `Now ${describeWhen(updated, ev.tz, !updated.all_day)}`,
          link: linkFor(fresh, updated),
        });
      }
      return res.json({ ...masterObject(fresh), can_edit: true, occurrence: withPerms(req, updated) });
    }

    // --- this and following -----------------------------------------------------------------
    if (scope === 'following') {
      if (!key) throw httpError(400, 'Which occurrence? (occurrence is required)');
      const { day, gen, occ } = resolveOccurrence(ev, key);
      const startDay = startDayOf(ev.all_day, ev.start, ev.tz);
      const index = occurrenceIndex(ev.rrule, startDay, day);
      if (index > 0) {
        // The new series starts from the GENERATED occurrence (not a one-off override of it).
        const baseRule = ev.rrule.count ? { ...ev.rrule, count: Math.max(1, ev.rrule.count - index) } : ev.rrule;
        const base = { ...masterObject(ev), start: gen.start, end: gen.end, all_day: ev.all_day, color: ev.color, rrule: baseRule };
        let v = parseInput(db, familyId, fields, base);
        const dayShift = startDayOf(v.all_day, v.start, v.tz) - day;
        if (sameRule(v.rrule, baseRule)) v.rrule = shiftWeekdays(v.rrule, dayShift);
        v = alignSeries(v);
        // Per-day edits AFTER the split move to the new series; the edited occurrence itself is replaced.
        const later = db.prepare('SELECT id, occurrence FROM calendar_exceptions WHERE event_id = ? AND occurrence > ?').all(ev.id, gen.key);
        const ruleKept = v.all_day === ev.all_day && sameRule(v.rrule, shiftWeekdays(baseRule, dayShift));
        // A per-day edit AT the split point is carried into the new series' first occurrence,
        // with the fields edited now applied on top of it.
        const splitX = ev.exceptions.get(gen.key);
        const carried = splitX && !splitX.cancelled
          ? parseInput(db, familyId, fields, { ...occ, color: occ.custom_color, tz: ev.tz }, { allowRrule: false })
          : null;
        let dropped = 0;
        const newId = ctx.tx(db, () => {
          truncateSeries(db, ev, day, gen.key, { keepLater: true });
          db.prepare('DELETE FROM calendar_exceptions WHERE event_id = ? AND occurrence = ?').run(ev.id, gen.key);
          const id = insertEvent(db, familyId, ev.created_by ?? req.user.id, v);
          if (carried) {
            const nev = getEvent(db, familyId, id);
            const first = generated(nev, startDayOf(nev.all_day, nev.start, nev.tz));
            const differs = ['title', 'notes', 'location', 'color'].some((k) => (carried[k] ?? null) !== (nev[k] ?? null))
              || carried.start !== first.start || carried.end !== first.end || carried.all_day !== nev.all_day
              || JSON.stringify(carried.attendees) !== JSON.stringify(nev.attendees) || JSON.stringify(carried.reminders) !== JSON.stringify(nev.reminders);
            if (differs) upsertException(db, id, first.key, carried);
          }
          if (ruleKept) {
            dropped = moveExceptions(db, ev, getEvent(db, familyId, id), later, dayShift);
            applyEditsToExceptions(db, id, later, fields, ev, v);
          }
          else {
            for (const x of later) db.prepare('DELETE FROM calendar_exceptions WHERE id = ?').run(x.id);
            dropped = later.length;
          }
          return id;
        });
        const fresh = getEvent(db, familyId, newId);
        ctx.broadcast(familyId, 'calendar.event.updated', { id: ev.id });
        ctx.broadcast(familyId, 'calendar.event.created', { id: newId, title: fresh.title });
        if (timingOf({ all_day: ev.all_day, start: gen.start, end: gen.end, tz: ev.tz, rrule: baseRule }) !== timingOf(v)) {
          ctx.logActivity({
            familyId, userId: req.user.id, module: 'calendar', verb: 'rescheduled', entityId: newId,
            summary: `rescheduled ${fresh.title} from ${describeWhen(occ, ev.tz, false)} on`, link: linkFor(fresh, null),
          });
        }
        return res.json({ ...masterObject(fresh), can_edit: true, split_from: ev.id, dropped_exceptions: dropped });
      }
      scope = 'all'; // editing "this and following" from the first occurrence = the whole series
    }

    // --- whole event / series ----------------------------------------------------------------
    let v;
    let dayShift = 0;
    let occBase = null;
    if (ev.rrule && key) occBase = resolveOccurrence(ev, key);
    if (occBase) {
      // Values are edited as seen on that occurrence; the timing change is applied to the series.
      const { day: occDay, occ } = occBase;
      const edited = parseInput(db, familyId, fields, { ...masterObject(ev), start: occ.start, end: occ.end, all_day: occ.all_day, color: ev.color });
      const newOccDay = startDayOf(edited.all_day, edited.start, edited.tz);
      dayShift = newOccDay - occDay;
      const masterDay = startDayOf(ev.all_day, ev.start, ev.tz) + dayShift;
      let start;
      let end;
      if (edited.all_day) {
        const span = dayFromKey(edited.end) - dayFromKey(edited.start);
        start = dayKey(masterDay);
        end = dayKey(masterDay + span);
      } else {
        const sMs = Date.parse(edited.start);
        const { h, mi } = localClock(sMs, edited.tz);
        const s = dayTimeToUtc(masterDay, h, mi, edited.tz);
        start = new Date(s).toISOString();
        end = new Date(s + (Date.parse(edited.end) - sMs)).toISOString();
      }
      // Re-validate the rule against the (possibly shifted) series start.
      let rrule = parseRrule(Object.prototype.hasOwnProperty.call(fields, 'rrule') ? fields.rrule : ev.rrule, masterDay);
      if (sameRule(rrule, ev.rrule)) rrule = shiftWeekdays(rrule, dayShift); // Tue/Thu moved a day later → Wed/Fri
      v = { ...edited, start, end, rrule };
    } else {
      v = parseInput(db, familyId, fields, { ...masterObject(ev), color: ev.color });
      dayShift = startDayOf(v.all_day, v.start, v.tz) - startDayOf(ev.all_day, ev.start, ev.tz);
      if (ev.rrule && sameRule(v.rrule, ev.rrule)) v.rrule = shiftWeekdays(v.rrule, dayShift);
    }
    v = alignSeries(v);

    const before = { all_day: ev.all_day, start: ev.start, end: ev.end, tz: ev.tz, rrule: ev.rrule };
    const timingChanged = timingOf(before) !== timingOf(v);
    const addedAttendees = v.attendees.filter((id) => !ev.attendees.includes(id));

    let dropped = 0;
    ctx.tx(db, () => {
      updateEventRow(db, ev.id, v);
      if (!ev.rrule || !timingChanged) return;
      const rows = db.prepare('SELECT id, occurrence FROM calendar_exceptions WHERE event_id = ?').all(ev.id);
      const ruleKept = !!v.rrule && ev.all_day === v.all_day && sameRule(v.rrule, shiftWeekdays(ev.rrule, dayShift));
      if (!ruleKept) {
        db.prepare('DELETE FROM calendar_exceptions WHERE event_id = ?').run(ev.id);
        dropped = rows.length;
        return;
      }
      // Same rule, shifted timing: move per-day edits along with the series (never onto non-occurrence days).
      dropped = moveExceptions(db, ev, getEvent(db, familyId, ev.id), rows, dayShift);
    });

    const fresh = getEvent(db, familyId, ev.id);
    const link = linkFor(fresh, null);
    ctx.broadcast(familyId, 'calendar.event.updated', { id: ev.id });
    const firstWhen = describeWhen({ all_day: fresh.all_day, start: fresh.start }, fresh.tz, !fresh.all_day);
    if (addedAttendees.length) {
      ctx.notify({
        familyId, userIds: addedAttendees, module: 'calendar', excludeUserId: req.user.id,
        title: `${actorFirst} added you to ${fresh.title}`,
        body: [firstWhen, fresh.location].filter(Boolean).join(' · '),
        link,
      });
    }
    if (timingChanged) {
      const existing = fresh.attendees.filter((id) => !addedAttendees.includes(id));
      ctx.notify({
        familyId, userIds: existing, module: 'calendar', excludeUserId: req.user.id,
        title: `${actorFirst} rescheduled ${fresh.title}`,
        body: fresh.rrule ? `The series now starts ${firstWhen}` : `Now ${firstWhen}`,
        link,
      });
      ctx.logActivity({
        familyId, userId: req.user.id, module: 'calendar', verb: 'rescheduled', entityId: ev.id,
        summary: `rescheduled ${fresh.title} to ${firstWhen}`, link,
      });
    }
    let occurrence = null;
    if (occBase && fresh.rrule) {
      const day = occBase.day + dayShift;
      if (validOccurrenceDay(fresh, generated(fresh, day).key) !== null) {
        const gen = generated(fresh, day);
        occurrence = withPerms(req, occurrenceObject(fresh, gen, fresh.exceptions.get(gen.key)));
      }
    }
    res.json({ ...masterObject(fresh), can_edit: true, occurrence, dropped_exceptions: dropped });
  });

  r.delete('/events/:id', (req, res) => {
    const familyId = req.family.id;
    const ev = getEvent(db, familyId, toId(req.params.id));
    if (!canEdit(req, ev)) throw httpError(403, 'Only the person who created this event or a parent can delete it');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let scope = body.scope ?? req.query.scope ?? 'all';
    const key = body.occurrence ?? req.query.occurrence ?? null;
    if (!['all', 'this', 'following'].includes(scope)) throw httpError(400, 'Scope must be "this", "following" or "all"');
    if (!ev.rrule) scope = 'all';
    const actorFirst = req.user.name.split(/\s+/)[0];

    if (scope !== 'all') {
      if (!key) throw httpError(400, 'Which occurrence? (occurrence is required)');
      const { day, gen, occ } = resolveOccurrence(ev, String(key));
      const startDay = startDayOf(ev.all_day, ev.start, ev.tz);
      const index = occurrenceIndex(ev.rrule, startDay, day);
      if (scope === 'following' && index === 0) {
        scope = 'all';
      } else {
        if (scope === 'this') upsertException(db, ev.id, gen.key, null);
        else ctx.tx(db, () => truncateSeries(db, ev, day, gen.key));
        ctx.broadcast(familyId, 'calendar.event.updated', { id: ev.id, occurrence: gen.key, deleted: true });
        const when = describeWhen(occ, ev.tz, false);
        ctx.notify({
          familyId, userIds: occ.attendees, module: 'calendar', excludeUserId: req.user.id,
          title: scope === 'this' ? `${occ.title} on ${when} was cancelled` : `${occ.title} was cancelled from ${when} on`,
          body: `Cancelled by ${actorFirst}`,
          link: `/calendar?date=${dayKey(day)}`,
        });
        ctx.logActivity({
          familyId, userId: req.user.id, module: 'calendar', verb: 'cancelled', entityId: ev.id,
          summary: scope === 'this' ? `cancelled ${occ.title} on ${when}` : `ended ${occ.title} from ${when} on`,
          link: `/calendar?date=${dayKey(day)}`,
        });
        return res.json({ ok: true, scope });
      }
    }

    ctx.tx(db, () => {
      db.prepare('DELETE FROM calendar_events WHERE id = ? AND family_id = ?').run(ev.id, familyId);
      // Old feed entries / notifications for this event now open the calendar instead of a dead link.
      db.prepare("UPDATE activity SET link = '/calendar' WHERE family_id = ? AND module = 'calendar' AND entity_id = ?").run(familyId, ev.id);
      db.prepare("UPDATE notifications SET link = '/calendar' WHERE family_id = ? AND module = 'calendar' AND (link LIKE ? OR link = ?)")
        .run(familyId, `/calendar?event=${ev.id}&%`, `/calendar?event=${ev.id}`);
    });
    ctx.broadcast(familyId, 'calendar.event.deleted', { id: ev.id });
    const when = describeWhen({ all_day: ev.all_day, start: ev.start }, ev.tz, !ev.all_day);
    ctx.notify({
      familyId, userIds: ev.attendees, module: 'calendar', excludeUserId: req.user.id,
      title: `${ev.title} was cancelled`,
      body: `${ev.rrule ? 'All occurrences were removed' : when} · by ${actorFirst}`,
      link: '/calendar',
    });
    ctx.logActivity({
      familyId, userId: req.user.id, module: 'calendar', verb: 'deleted', entityId: ev.id,
      summary: `removed the event ${ev.title}`, link: '/calendar',
    });
    res.json({ ok: true, scope: 'all' });
  });

  // iCalendar export of one event (download / add to a phone calendar).
  r.get('/events/:id/ics', (req, res) => {
    const ev = getEvent(db, req.family.id, toId(req.params.id));
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ev.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'event'}.ics"`);
    res.send(toIcs(ev));
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// iCalendar
// ---------------------------------------------------------------------------------------------

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (key) => key.replace(/-/g, '');
const pad2 = (n) => String(n).padStart(2, '0');
/** Local wall-clock "YYYYMMDDTHHMMSS" of an instant in `tz`. */
const icsLocal = (ms, tz) => {
  const p = zonedParts(ms, tz);
  return `${p.y}${pad2(p.m)}${pad2(p.d)}T${pad2(p.h)}${pad2(p.mi)}${pad2(p.s)}`;
};
const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const fmtOffset = (min) => `${min < 0 ? '-' : '+'}${pad2(Math.floor(Math.abs(min) / 60))}${pad2(Math.abs(min) % 60)}`;

/** Fold a content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function icsFold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** VTIMEZONE for `tz`, derived from its DST transitions in `year` (yearly rules). */
function vtimezone(tz, year) {
  const offMin = (ms) => Math.round(offsetMs(ms, tz) / 60_000);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const transitions = [];
  let prev = offMin(Date.UTC(year, 0, 1));
  for (let d = 1; d <= 366; d++) {
    const t = Date.UTC(year, 0, 1) + d * DAY;
    const o = offMin(t);
    if (o !== prev) {
      let lo = t - DAY;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offMin(mid) === prev) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, from: prev, to: o });
      prev = o;
    }
  }
  if (!transitions.length) {
    lines.push('BEGIN:STANDARD', `DTSTART:${year}0101T000000`, `TZOFFSETFROM:${fmtOffset(prev)}`, `TZOFFSETTO:${fmtOffset(prev)}`, 'END:STANDARD');
  } else {
    for (const tr of transitions) {
      const local = new Date(tr.at + tr.from * 60_000); // wall clock just before the change
      const y = local.getUTCFullYear();
      const m = local.getUTCMonth() + 1;
      const d = local.getUTCDate();
      const nth = d + 7 > daysInMonthOf(y, m) ? -1 : Math.ceil(d / 7);
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${y}${pad2(m)}${pad2(d)}T${pad2(local.getUTCHours())}${pad2(local.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${m};BYDAY=${nth}${RRULE_DAYS[local.getUTCDay()]}`,
        `TZOFFSETFROM:${fmtOffset(tr.from)}`,
        `TZOFFSETTO:${fmtOffset(tr.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}
const daysInMonthOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * iCalendar for one event/series. Timed events use DTSTART;TZID=<zone> (+ VTIMEZONE) so recurring
 * events keep their local time across DST in other apps; edited occurrences are exported as extra
 * VEVENTs with RECURRENCE-ID and cancelled ones as EXDATE.
 */
export function toIcs(ev) {
  const tz = ev.tz || 'UTC';
  const uid = `hearth-event-${ev.id}@hearth`;
  const stamp = `DTSTAMP:${icsStamp(Date.now())}`;
  const when = (allDay, start, end, prefix = '') => allDay
    ? [`${prefix}DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(dayKey(dayFromKey(end) + 1))}`]
    : [`${prefix}DTSTART;TZID=${tz}:${icsLocal(Date.parse(start), tz)}`, `DTEND;TZID=${tz}:${icsLocal(Date.parse(end), tz)}`];
  const recurrenceId = (key) => (ev.all_day ? `RECURRENCE-ID;VALUE=DATE:${icsDate(key)}` : `RECURRENCE-ID;TZID=${tz}:${icsLocal(Date.parse(key), tz)}`);
  const details = (title, location, notes) => [
    `SUMMARY:${icsEscape(title)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    ...(notes ? [`DESCRIPTION:${icsEscape(notes)}`] : []),
  ];
  const alarms = (list, title) => list.flatMap((m) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM']);

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hearth//Family Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const overrides = ev.rrule ? [...ev.exceptions.values()].filter((x) => !x.cancelled && x.start) : [];
  const needsTz = !ev.all_day || overrides.some((x) => !x.all_day);
  if (needsTz) lines.push(...vtimezone(tz, zonedParts(Date.parse(ev.all_day ? `${ev.start}T12:00:00Z` : ev.start), tz).y));

  lines.push('BEGIN:VEVENT', `UID:${uid}`, stamp, ...when(ev.all_day, ev.start, ev.end), ...details(ev.title, ev.location, ev.notes));
  if (ev.rrule) {
    const parts = [`FREQ=${ev.rrule.freq.toUpperCase()}`, `INTERVAL=${ev.rrule.interval || 1}`];
    const startDay = startDayOf(ev.all_day, ev.start, tz);
    if (ev.rrule.byweekday) parts.push(`BYDAY=${ev.rrule.byweekday.map((d) => RRULE_DAYS[d]).join(',')}`);
    if (ev.rrule.freq === 'monthly' && ev.rrule.monthly === 'weekday') {
      const nth = Math.ceil(ymd(startDay).d / 7);
      parts.push(`BYDAY=${nth >= 5 ? -1 : nth}${RRULE_DAYS[weekday(startDay)]}`);
    }
    if (ev.rrule.until) {
      // UNTIL is inclusive: the end of that day in the event's zone (UTC form, as RFC 5545 requires with TZID).
      parts.push(`UNTIL=${ev.all_day ? icsDate(ev.rrule.until) : icsStamp(dayTimeToUtc(dayFromKey(ev.rrule.until) + 1, 0, 0, tz) - 1000)}`);
    }
    if (ev.rrule.count) parts.push(`COUNT=${ev.rrule.count}`);
    lines.push(`RRULE:${parts.join(';')}`);
    for (const x of ev.exceptions.values()) {
      if (!x.cancelled) continue;
      lines.push(ev.all_day ? `EXDATE;VALUE=DATE:${icsDate(x.occurrence)}` : `EXDATE;TZID=${tz}:${icsLocal(Date.parse(x.occurrence), tz)}`);
    }
  }
  lines.push(...alarms(ev.reminders, ev.title), 'END:VEVENT');

  for (const x of overrides) {
    const allDay = x.all_day === null ? ev.all_day : !!x.all_day;
    const rem = parseJson(x.reminders, ev.reminders);
    lines.push(
      'BEGIN:VEVENT', `UID:${uid}`, stamp, recurrenceId(x.occurrence), ...when(allDay, x.start, x.end),
      ...details(x.title ?? ev.title, x.location, x.notes), ...alarms(rem, x.title ?? ev.title), 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------------------------
// Hooks: dashboard, search, seed
// ---------------------------------------------------------------------------------------------

const dashboardEvent = (o) => ({
  id: o.id,
  event_id: o.event_id,
  occurrence: o.occurrence,
  kind: o.kind,
  title: o.title,
  start: o.start,
  end: o.end,
  all_day: o.all_day,
  color: o.color,
  location: o.location,
  attendees: o.attendees,
  recurring: o.recurring,
  link: o.kind === 'birthday' ? `/calendar?date=${o.start}` : linkFor({ id: o.event_id, tz: o.tz }, o),
});

/** `{ today: Event[], upcoming: Event[] }` — today's events and the next 7 days'. */
export function dashboard(ctx, req) {
  const tz = requestTz(ctx, req);
  const now = Date.now();
  const today = localDay(now, tz);
  const range = { fromMs: dayTimeToUtc(today, 0, 0, tz), toMs: dayTimeToUtc(today + 8, 0, 0, tz), fromDay: today, toDay: today + 7, tz };
  const occs = listOccurrences(ctx.db, req.family.id, range);
  const todayEnd = dayTimeToUtc(today + 1, 0, 0, tz);
  const isToday = (o) => (o.all_day ? dayFromKey(o.start) <= today && dayFromKey(o.end) >= today : Date.parse(o.start) < todayEnd);
  return {
    today: occs.filter(isToday).map(dashboardEvent),
    upcoming: occs.filter((o) => !isToday(o)).slice(0, 20).map(dashboardEvent),
  };
}

export function search(ctx, familyId, q) {
  const rows = ctx.db
    .prepare(
      `SELECT id FROM calendar_events WHERE family_id = ?
         AND (search_match(title, ?) OR search_match(location, ?) OR search_match(notes, ?))
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(familyId, ...Array(3).fill(String(q)))
    .map((r) => r.id);
  const events = loadEvents(ctx.db, familyId, { ids: rows });
  const now = Date.now();
  const results = events.map((ev) => {
    let occ = null;
    if (ev.rrule) {
      const range = { fromMs: now, toMs: now + 400 * DAY, fromDay: localDay(now, ev.tz), toDay: localDay(now + 400 * DAY, ev.tz), tz: ev.tz };
      occ = expandEvent(ev, range)[0] ?? null;
    }
    const shown = occ ?? { all_day: ev.all_day, start: ev.start };
    const upcoming = occ ? 0 : (ev.all_day ? dayTimeToUtc(dayFromKey(ev.end) + 1, 0, 0, ev.tz) : Date.parse(ev.end)) >= now ? 0 : 1;
    return {
      sort: [upcoming, Math.abs(Date.parse(shown.all_day ? `${shown.start}T12:00:00Z` : shown.start) - now)],
      title: ev.title,
      subtitle: [describeWhen(shown, ev.tz, !shown.all_day), ev.rrule ? 'Repeats' : null, ev.location].filter(Boolean).join(' · '),
      link: linkFor(ev, occ),
    };
  });
  results.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]);
  return results.slice(0, 8).map(({ title, subtitle, link }) => ({ title, subtitle, link }));
}

/** Demo content for the Rivera family: a lively, realistic few weeks around today. */
export function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  // Family-local wall clock: the family's known zone, else a sensible default (never the server's UTC).
  const known = db.prepare('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.family_id = ? AND u.timezone IS NOT NULL').get(familyId);
  const envTz = process.env.HEARTH_DEMO_TZ;
  const tz = envTz && isValidTz(envTz) ? envTz : known && ctx.time ? ctx.time.familyTz(familyId) : DEMO_TZ;
  const { alex, sam, mia, leo } = users;
  const today = localDay(Date.now(), tz);
  const monday = today - ((weekday(today) + 6) % 7); // this week's Monday
  const at = (day, h, mi = 0) => new Date(dayTimeToUtc(day, h, mi, tz)).toISOString();
  const timed = (day, h, mi, durMin) => ({ all_day: false, start: at(day, h, mi), end: new Date(dayTimeToUtc(day, h, mi, tz) + durMin * 60_000).toISOString() });
  const allDay = (day, span = 0) => ({ all_day: true, start: dayKey(day), end: dayKey(day + span) });
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

  const add = (by, v, { activityDaysAgo } = {}) => {
    const id = insertEvent(db, familyId, by.id, {
      notes: null, location: null, color: null, attendees: [], rrule: null, reminders: [], tz, ...v,
    });
    db.prepare('UPDATE calendar_events SET created_at = ?, updated_at = ? WHERE id = ?').run(ago(activityDaysAgo ?? 7), ago(activityDaysAgo ?? 7), id);
    if (activityDaysAgo !== undefined) {
      const ev = getEvent(db, familyId, id);
      ctx.logActivity({
        familyId, userId: by.id, module: 'calendar', verb: 'created', entityId: id,
        summary: `added ${ev.rrule ? 'the recurring event' : 'the event'} ${ev.title} · ${describeWhen({ all_day: ev.all_day, start: ev.start }, tz, !ev.all_day)}`,
        link: linkFor(ev, null), createdAt: ago(activityDaysAgo),
      });
    }
    return id;
  };

  ctx.tx(db, () => {
    // Recurring school runs (split between the parents), from three weeks ago.
    add(alex, {
      title: 'School run', ...timed(monday - 21, 7, 45, 30), location: 'Maple Grove Elementary',
      attendees: [alex.id, mia.id, leo.id], rrule: { freq: 'weekly', interval: 1, byweekday: [1, 3, 5] }, reminders: [10],
      notes: 'Leave by 7:40. Leo has library books on Fridays.',
    }, { activityDaysAgo: 21 });
    add(sam, {
      title: 'School run', ...timed(monday - 20, 7, 45, 30), location: 'Maple Grove Elementary',
      attendees: [sam.id, mia.id, leo.id], rrule: { freq: 'weekly', interval: 1, byweekday: [2, 4] }, reminders: [10],
    });
    const soccer = add(sam, {
      title: 'Soccer practice', ...timed(monday - 13, 16, 30, 90), location: 'Riverside Park, Field 3',
      attendees: [leo.id, sam.id], rrule: { freq: 'weekly', interval: 1, byweekday: [2, 4] }, reminders: [30], color: '#F76B15',
      notes: 'Shin guards + water bottle. Snack rotation: our turn on the 2nd Thursday.',
    }, { activityDaysAgo: 13 });
    const piano = add(alex, {
      title: 'Piano lesson', ...timed(monday - 19, 17, 0, 45), location: "Ms. Park's Studio, 12 Elm St",
      attendees: [mia.id], rrule: { freq: 'weekly', interval: 1, byweekday: [3] }, reminders: [60], color: '#30A46C',
      notes: 'Practice book: Faber Level 2B. Recital piece: "Für Elise" (simplified).',
    }, { activityDaysAgo: 19 });
    add(alex, {
      title: 'Sunday family dinner', ...timed(monday - 22, 18, 0, 120), location: "Grandma & Grandpa's",
      attendees: [alex.id, sam.id, mia.id, leo.id], rrule: { freq: 'weekly', interval: 1, byweekday: [0] }, color: '#8E4EC6',
      notes: 'Bring dessert on even weeks.',
    });
    add(alex, {
      title: 'Recycling pickup', ...allDay(monday - 20), rrule: { freq: 'weekly', interval: 2, byweekday: [2] }, color: '#978365',
      notes: 'Bins out the night before.', reminders: [1440],
    });
    add(sam, {
      title: 'Book club', ...timed(monday - 26, 19, 30, 120), location: 'The Corner Bookshop',
      attendees: [sam.id], rrule: { freq: 'monthly', interval: 1, monthly: 'weekday' }, reminders: [120],
      notes: 'This month: "Tomorrow, and Tomorrow, and Tomorrow".',
    });
    add(alex, {
      title: 'Pay mortgage', ...allDay(dayNum(ymd(today).y, ymd(today).m, 1)), rrule: { freq: 'monthly', interval: 1, monthly: 'day' },
      attendees: [alex.id], reminders: [1440],
    });
    add(alex, {
      title: 'Wedding anniversary', ...allDay(dayNum(2012, ymd(today + 12).m, ymd(today + 12).d)), rrule: { freq: 'yearly', interval: 1 },
      attendees: [alex.id, sam.id], color: '#E5484D', notes: '14 years! Book the restaurant a few weeks ahead.',
    });

    // One-off events this week and next.
    add(sam, {
      title: 'Grocery pickup', ...timed(today, 17, 30, 30), location: 'FreshMart curbside, bay 4', attendees: [sam.id], reminders: [15],
      notes: 'Order #48213 — check the app for substitutions.',
    }, { activityDaysAgo: 1 });
    add(alex, {
      title: 'Dentist — Mia', ...timed(monday + 3, 15, 30, 60), location: 'Bright Smile Dental, 400 Oak Ave',
      attendees: [mia.id, alex.id], reminders: [60, 1440], notes: 'Bring the insurance card. 6-month cleaning + sealant check.',
    }, { activityDaysAgo: 6 });
    add(sam, {
      title: 'Date night', ...timed(monday + 5, 19, 30, 180), location: "Luigi's Trattoria", attendees: [alex.id, sam.id],
      color: '#D6409F', reminders: [120], notes: 'Grandma is babysitting from 7. Reservation under Rivera.',
    }, { activityDaysAgo: 4 });
    add(sam, {
      title: 'Swim meet', ...timed(monday + 5, 9, 0, 180), location: 'Aquatic Center', attendees: [leo.id, sam.id], color: '#0090FF',
      notes: "Leo swims 25m freestyle (heat 3). Pack goggles + towel.", reminders: [60],
    });
    add(alex, { title: "Leo's haircut", ...timed(today + 1, 16, 0, 30), location: 'Snip Snip Kids', attendees: [leo.id, alex.id] }, { activityDaysAgo: 2 });
    add(alex, {
      title: 'Parent–teacher conference', ...timed(monday + 8, 18, 0, 30), location: 'Room 12, Maple Grove Elementary',
      attendees: [alex.id, sam.id], reminders: [60], notes: "Mrs. Chen, Mia's teacher. Questions: reading level, math club.",
    }, { activityDaysAgo: 3 });
    add(mia, { title: 'Science museum field trip', ...allDay(monday + 11), attendees: [mia.id], color: '#12A594', notes: 'Packed lunch, permission slip signed ✔' }, { activityDaysAgo: 2 });
    add(mia, { title: "Sofia's sleepover", ...timed(monday + 12, 18, 0, 15 * 60), location: "The Garcias' house", attendees: [mia.id] });
    add(alex, { title: 'Car service', ...timed(monday + 9, 8, 30, 90), location: 'Downtown Auto Care', attendees: [alex.id], reminders: [1440] });
    add(sam, { title: 'Yoga class', ...timed(monday + 1, 12, 15, 60), location: 'Sunrise Studio', attendees: [sam.id] });
    add(alex, {
      title: 'Lake Tahoe trip', ...allDay(monday + 18, 3), location: 'Lakeside Cabin, South Lake Tahoe', attendees: [alex.id, sam.id, mia.id, leo.id],
      color: '#12A594', notes: 'Pack: hiking boots, board games, sunscreen. Check-in 3pm.', reminders: [10080],
    }, { activityDaysAgo: 5 });
    add(leo, { title: "Max's birthday party", ...timed(monday + 13, 14, 0, 150), location: 'Bounce World', attendees: [leo.id], color: '#FFB224', notes: 'Gift: LEGO set (wrapped, in hall closet)' });
    // A few past one-offs so last week doesn't look empty.
    add(sam, { title: "Mia's recital", ...timed(monday - 2, 15, 0, 90), location: 'Community Hall', attendees: [alex.id, sam.id, mia.id, leo.id], color: '#30A46C' });
    add(alex, { title: 'Pediatrician — Leo', ...timed(monday - 5, 10, 0, 45), location: 'Northside Pediatrics', attendees: [leo.id, alex.id] });

    // Exceptions: piano moved to Thursday next week; one soccer practice rained out.
    const pianoEv = getEvent(db, familyId, piano);
    const nextWed = generated(pianoEv, monday + 7 + 2);
    upsertException(db, piano, nextWed.key, {
      title: 'Piano lesson (moved)', notes: 'Ms. Park is away Wednesday — moved to Thursday this week.', location: pianoEv.location,
      all_day: false, start: at(monday + 7 + 3, 17, 30), end: at(monday + 7 + 3, 18, 15), color: '#30A46C', attendees: [mia.id], reminders: [60],
    });
    const soccerEv = getEvent(db, familyId, soccer);
    upsertException(db, soccer, generated(soccerEv, monday - 4).key, null);
  });

  // Deep links to the seeded events (same format as live "added you" notifications).
  const linkTo = (title) => {
    const row = db.prepare('SELECT id FROM calendar_events WHERE family_id = ? AND title = ? ORDER BY id LIMIT 1').get(familyId, title);
    return row ? linkFor(getEvent(db, familyId, row.id), null) : '/calendar';
  };
  ctx.notify({
    familyId, userIds: [mia.id], module: 'calendar', title: 'Alex added you to Dentist — Mia',
    body: describeWhen({ all_day: false, start: at(monday + 3, 15, 30) }, tz, true), link: linkTo('Dentist — Mia'),
  });
  ctx.notify({
    familyId, userIds: [alex.id, mia.id, leo.id], module: 'calendar', title: 'Alex added you to Lake Tahoe trip',
    body: describeWhen({ all_day: true, start: dayKey(monday + 18) }, tz, false), link: linkTo('Lake Tahoe trip'),
  });
}

// Re-exported for tests.
export const _internal = { zonedParts, seriesDays, makeRange };
