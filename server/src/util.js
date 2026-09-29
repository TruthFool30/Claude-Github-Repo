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
  const s = String(value).trim();
  if (!s) {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  if (s.length > max) throw httpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const isColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Parse a positive integer id from params/body; throws 400 when invalid. */
export function toId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${field}`);
  return n;
}

export const nowIso = () => new Date().toISOString();
