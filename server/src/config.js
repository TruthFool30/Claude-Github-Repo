import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (two levels above server/src). Relative env paths resolve against it. */
export const ROOT = path.resolve(here, '..', '..');

const fromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: fromRoot(process.env.DB_PATH || './data/hearth.db'),
  uploadDir: fromRoot(process.env.UPLOAD_DIR || './data/uploads'),
  clientDist: fromRoot(process.env.CLIENT_DIST || 'client/dist'),
};
