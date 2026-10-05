// Time zones: "today" must be the family's day, not the server's (servers usually run in UTC).
// The client sends its IANA zone as `X-Timezone` on every API request; we validate it, expose it as
// `req.tz` / `req.today` and remember it per user (users.timezone) so background jobs (reminders,
// recurring bills…) can compute each family's local day too.

const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const validCache = new Map();

/** True for a real IANA zone name such as "America/Denver". */
export function isValidTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  if (validCache.has(tz)) return validCache.get(tz);
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    ok = false;
  }
  if (validCache.size < 1000) validCache.set(tz, ok);
  return ok;
}

/** Intl formatters are slow to build: one per (kind, zone), bounded like validCache. */
const fmtCache = new Map();
function formatter(kind, zone) {
  const key = `${kind}|${zone}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = kind === 'date'
      ? new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      : new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    if (fmtCache.size < 1000) fmtCache.set(key, f);
  }
  return f;
}

/** 'YYYY-MM-DD' of `date` (default now) in zone `tz`. */
export function dateIn(tz, date = new Date()) {
  const zone = isValidTz(tz) ? tz : SERVER_TZ;
  const parts = formatter('date', zone).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes east of UTC for `tz` at `date` (e.g. -360 for America/Denver in summer). */
export function offsetMinutes(tz, date = new Date()) {
  const zone = isValidTz(tz) ? tz : SERVER_TZ;
  const parts = formatter('offset', zone).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function makeTime(db) {
  const userTz = db.prepare('SELECT timezone FROM users WHERE id = ?');
  const familyZones = db.prepare(
    `SELECT u.timezone AS tz, COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.family_id = ? AND u.timezone IS NOT NULL GROUP BY u.timezone
      ORDER BY n DESC, MAX(CASE m.role WHEN 'admin' THEN 1 ELSE 0 END) DESC LIMIT 1`,
  );
  const tzOf = (userId) => {
    const tz = userTz.get(userId)?.timezone;
    return isValidTz(tz) ? tz : SERVER_TZ;
  };
  const familyTz = (familyId) => {
    const tz = familyZones.get(familyId)?.tz;
    return isValidTz(tz) ? tz : SERVER_TZ;
  };
  return {
    serverTz: SERVER_TZ,
    isValidTz,
    dateIn,
    offsetMinutes,
    /** The requesting user's zone (header, else remembered, else server). */
    tz: (req) => req.tz || (req.user ? tzOf(req.user.id) : SERVER_TZ),
    /** 'YYYY-MM-DD' for the requesting user right now. */
    today: (req) => req.today || dateIn(req.tz || (req.user ? tzOf(req.user.id) : SERVER_TZ)),
    tzOf,
    todayForUser: (userId) => dateIn(tzOf(userId)),
    /** The family's zone: the most common zone among its members (admins break ties). */
    familyTz,
    todayForFamily: (familyId) => dateIn(familyTz(familyId)),
  };
}
