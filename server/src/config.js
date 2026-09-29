import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (two levels above server/src). Relative env paths resolve against it. */
export const ROOT = path.resolve(here, '..', '..');

const fromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

/**
 * TRUST_PROXY -> Express 'trust proxy': 'true'/'false', a hop count ('1'), or names/subnets
 * ('loopback', 'loopback, 10.0.0.0/8'). Default 'loopback' (a proxy on the same machine).
 */
export function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'loopback';
  const v = String(raw).trim();
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off|0)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  port: Number(process.env.PORT || 3000),
  dbPath: fromRoot(process.env.DB_PATH || './data/hearth.db'),
  uploadDir: fromRoot(process.env.UPLOAD_DIR || './data/uploads'),
  clientDist: fromRoot(process.env.CLIENT_DIST || 'client/dist'),
};
