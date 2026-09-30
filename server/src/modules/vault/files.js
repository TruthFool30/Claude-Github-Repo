// File storage helpers for the document vault.
//
// Uploads arrive through the shared multer instance (`ctx.upload`, which writes to
// UPLOAD_DIR/<familyId>/<random>) and are then moved into UPLOAD_DIR/<familyId>/vault/.
// That sub-folder is NOT reachable through the public `/uploads/<familyId>/<file>` route (which
// only serves direct children), so every vault file — and in particular "private to me"
// documents — can only be read through `GET /api/vault/documents/:id/file`, which enforces
// family scoping and privacy. Deleting a family still removes the folder (it lives inside the
// family's upload directory).
import fs from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[a-f0-9]{24}(\.[a-z0-9]{1,8})?$/;

export function vaultDir(uploadDir, familyId) {
  return path.join(uploadDir, String(familyId), 'vault');
}

/** Absolute path of a stored vault file, or null when the key looks wrong. */
export function vaultPath(uploadDir, familyId, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return path.join(vaultDir(uploadDir, familyId), key);
}

/** Move a file that multer/storeFile wrote into the family's private vault folder. Returns the storage key. */
export function moveIntoVault(uploadDir, familyId, absSource) {
  const key = path.basename(absSource);
  if (!KEY_RE.test(key)) throw new Error(`Unexpected upload name ${key}`);
  const dir = vaultDir(uploadDir, familyId);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(absSource, path.join(dir, key));
  return key;
}

export function removeVaultFile(uploadDir, familyId, key) {
  const abs = vaultPath(uploadDir, familyId, key);
  if (abs) fs.rm(abs, { force: true }, () => {});
}

/** Busboy decodes multipart filenames as latin1; browsers send raw UTF-8. Undo the mojibake. */
export function fixFilename(name) {
  if (typeof name !== 'string') return '';
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? name : fixed;
}

export function extOf(name) {
  const ext = path.extname(name || '').toLowerCase().slice(1);
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json']);
const DOC_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'pages']);
const SHEET_EXT = new Set(['xls', 'xlsx', 'ods', 'numbers']);
const SLIDE_EXT = new Set(['ppt', 'pptx', 'odp', 'key']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'aac']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);

/** Coarse kind used by the UI for icons and previews. */
export function kindOf(ext, mime = '') {
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (DOC_EXT.has(ext)) return 'doc';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (SLIDE_EXT.has(ext)) return 'slides';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  // The claimed MIME type is only a hint for extension-less files.
  if (!ext && mime.startsWith('image/')) return 'image';
  if (!ext && mime.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * The Content-Type we are willing to serve, derived from the extension (never trusting the
 * uploader's claimed MIME type), and whether it may be shown inline. Anything unknown is served
 * as an opaque download, so an uploaded .html can never execute on our origin.
 */
const SERVE_TYPES = {
  png: ['image/png', true], jpg: ['image/jpeg', true], jpeg: ['image/jpeg', true], gif: ['image/gif', true],
  webp: ['image/webp', true], avif: ['image/avif', true], bmp: ['image/bmp', true], svg: ['image/svg+xml', true],
  pdf: ['application/pdf', true],
  txt: ['text/plain; charset=utf-8', true], md: ['text/plain; charset=utf-8', true], csv: ['text/plain; charset=utf-8', true],
  log: ['text/plain; charset=utf-8', true], json: ['text/plain; charset=utf-8', true],
  mp3: ['audio/mpeg', true], m4a: ['audio/mp4', true], wav: ['audio/wav', true], ogg: ['audio/ogg', true],
  mp4: ['video/mp4', true], webm: ['video/webm', true], mov: ['video/quicktime', true], m4v: ['video/mp4', true],
};
export function serveTypeFor(ext) {
  const hit = SERVE_TYPES[ext];
  return hit ? { type: hit[0], inline: hit[1] } : { type: 'application/octet-stream', inline: false };
}

/** RFC 6266 Content-Disposition with an ASCII fallback + UTF-8 filename*. */
export function contentDisposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Name used when downloading: the display name, with the original extension added back if it was renamed away. */
export function downloadName(name, ext) {
  if (!ext) return name;
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}
