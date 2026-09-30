// Time-zone + recurrence helpers for the calendar module (no dependencies, uses Intl).
//
// Dates are handled as "day numbers" (days since 1970-01-01, calendar arithmetic in UTC) so that
// all-day events and recurrence rules are independent of the server's own time zone. Timed events
// keep their wall-clock time in the event's IANA time zone (`tz`) across DST changes.

const DAY = 86_400_000;
const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** true when `tz` is a valid IANA time zone name. */
export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

export function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in `tz` -> UTC epoch ms (handles DST gaps/overlaps sensibly). */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(guess, tz);
  let t = guess - off1;
  const off2 = offsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

// ---- day numbers ----------------------------------------------------------------------------
export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
export const dayFromKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return dayNum(y, m, d);
};
export function ymd(day) {
  const dt = new Date(day * DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export const dayKey = (day) => new Date(day * DAY).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday */
export const weekday = (day) => (((day + 4) % 7) + 7) % 7;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Local calendar day of an instant in `tz`. */
export function localDay(ms, tz) {
  const p = zonedParts(ms, tz);
  return dayNum(p.y, p.m, p.d);
}
/** Local wall-clock {day, h, mi} of an instant. */
export function localClock(ms, tz) {
  const p = zonedParts(ms, tz);
  return { day: dayNum(p.y, p.m, p.d), h: p.h, mi: p.mi };
}
/** UTC ms of `day` at h:mi in `tz`. */
export function dayTimeToUtc(day, h, mi, tz) {
  const { y, m, d } = ymd(day);
  return zonedToUtc(y, m, d, h, mi, tz);
}

// ---- recurrence -------------------------------------------------------------------------------
/**
 * Days (in increasing order) on which a series occurs, starting at `startDay`.
 * rule: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval, byweekday?: number[], monthly?: 'day'|'weekday' }
 * Stops after `maxDay` or `limit` yielded days. Returns [{ day, index }] where index counts every
 * occurrence since the series start (used for COUNT).
 */
export function seriesDays(rule, startDay, { maxDay, untilDay = Infinity, count = Infinity, minDay = -Infinity, cap = 20_000 }) {
  const out = [];
  if (!rule) {
    if (startDay >= minDay && startDay <= maxDay) out.push({ day: startDay, index: 0 });
    return out;
  }
  const interval = Math.max(1, rule.interval || 1);
  const stop = Math.min(maxDay, untilDay);
  let index = 0;
  let guard = 0;
  const push = (day) => {
    if (day >= minDay) out.push({ day, index });
    index++;
  };
  const start = ymd(startDay);

  if (rule.freq === 'daily') {
    // Jump straight to the first candidate near minDay when there's no COUNT to keep track of.
    let k = 0;
    if (count === Infinity && minDay > startDay) k = Math.floor((minDay - startDay) / interval);
    index = k;
    for (let day = startDay + k * interval; day <= stop && index < count && guard++ < cap; day += interval) push(day);
  } else if (rule.freq === 'weekly') {
    const days = (rule.byweekday?.length ? [...new Set(rule.byweekday)] : [weekday(startDay)]).sort((a, b) => a - b);
    const week0 = startDay - weekday(startDay); // Sunday of the first week
    for (let w = 0; guard++ < cap; w += interval) {
      const ws = week0 + w * 7;
      if (ws > stop) break;
      for (const wd of days) {
        const day = ws + wd;
        if (day < startDay) continue;
        if (day > stop || index >= count) break;
        push(day);
      }
      if (index >= count) break;
    }
  } else if (rule.freq === 'monthly') {
    const byWeekday = rule.monthly === 'weekday';
    const wd = weekday(startDay);
    const nth = Math.ceil(start.d / 7); // 1..5; 5 means "last"
    for (let k = 0; guard++ < cap; k += interval) {
      const mIdx = start.m - 1 + k;
      const y = start.y + Math.floor(mIdx / 12);
      const m = (mIdx % 12) + 1;
      if (dayNum(y, m, 1) > stop || index >= count) break;
      let day;
      if (byWeekday) {
        const dim = daysInMonth(y, m);
        if (nth >= 5) {
          const last = dayNum(y, m, dim);
          day = last - ((weekday(last) - wd + 7) % 7);
        } else {
          const first = dayNum(y, m, 1);
          day = first + ((wd - weekday(first) + 7) % 7) + (nth - 1) * 7;
        }
      } else {
        if (start.d > daysInMonth(y, m)) continue; // e.g. the 31st: skip short months
        day = dayNum(y, m, start.d);
      }
      if (day > stop) break;
      push(day);
    }
  } else if (rule.freq === 'yearly') {
    for (let k = 0; guard++ < cap; k += interval) {
      const y = start.y + k;
      if (dayNum(y, 1, 1) > stop || index >= count) break;
      if (start.d > daysInMonth(y, start.m)) continue; // Feb 29 in non-leap years
      const day = dayNum(y, start.m, start.d);
      if (day > stop) break;
      push(day);
    }
  }
  return out;
}

/** Index (0-based) of the occurrence falling on `day`, or -1 when the series has no such day. */
export function occurrenceIndex(rule, startDay, day) {
  if (!rule) return day === startDay ? 0 : -1;
  const list = seriesDays(rule, startDay, { maxDay: day });
  const hit = list.find((o) => o.day === day);
  return hit ? hit.index : -1;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Thu, Oct 2" / "Thu, Oct 2, 4:30 PM" in the event's time zone. */
export function describeWhen(occ, tz, withTime = true) {
  if (occ.all_day) {
    const { y, m, d } = ymd(dayFromKey(occ.start));
    const wd = WEEKDAYS[weekday(dayFromKey(occ.start))].slice(0, 3);
    return `${wd}, ${MONTHS[m - 1].slice(0, 3)} ${d}${y !== new Date().getUTCFullYear() ? `, ${y}` : ''}`;
  }
  const ms = Date.parse(occ.start);
  const opts = { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms));
}
