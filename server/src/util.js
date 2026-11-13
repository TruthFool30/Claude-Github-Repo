/** Small helpers shared by core + module routers. */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Throw inside any (async) handler: `throw httpError(404, 'List not found')`. */
export const httpError = (status, message) => new HttpError(status, message);

/** Trimmed string or null. Throws 400 when required and empty, or longer than max. */
export function cleanStr(value, { field = 'Value', required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw httpError(400, `${field} must be text`);
  const s = value.trim();
  if (!s) {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  if (s.length > max) throw httpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

/** Strict 'YYYY-MM-DD' that exists on the calendar (2020-02-31 is rejected). */
export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
export const isColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Parse a positive integer id from params/body; throws 400 when invalid. */
export function toId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${field}`);
  return n;
}

export const nowIso = () => new Date().toISOString();

/** First word of a name ("Alex Rivera" → "Alex"), or `fallback` when there is none. */
export const firstName = (name, fallback = 'Someone') => String(name ?? '').trim().split(/\s+/)[0] || fallback;

/** JSON.parse that returns `fallback` for null/undefined or invalid JSON. */
export function parseJson(s, fallback) {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/**
 * Tiny in-memory fixed-window rate limiter.
 *   const limiter = createRateLimiter();
 *   limiter.hit('login:ip:1.2.3.4', { max: 20, windowMs: 600000 }) -> { ok, retryAfter }
 */
export function createRateLimiter() {
  const buckets = new Map();
  let lastSweep = Date.now();
  function sweep(now) {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }
  return {
    hit(key, { max, windowMs }) {
      const now = Date.now();
      sweep(now);
      let b = buckets.get(key);
      if (!b || b.reset <= now) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count++;
      return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
    },
    /** true when `key` has already used up its budget (does not count a hit). */
    blocked(key, { max }) {
      const b = buckets.get(key);
      return !!b && b.reset > Date.now() && b.count >= max;
    },
    retryAfter(key) {
      const b = buckets.get(key);
      return b ? Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) : 0;
    },
    clear(key) {
      buckets.delete(key);
    },
    reset() {
      buckets.clear();
    },
  };
}

export const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';
