import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;
function extFor(originalname = '', mimetype = '') {
  const ext = path.extname(originalname).toLowerCase();
  if (SAFE_EXT.test(ext)) return ext;
  const fromMime = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/heic': '.heic', 'application/pdf': '.pdf', 'text/plain': '.txt',
  }[mimetype];
  return fromMime || '';
}

function randomName(ext) {
  return crypto.randomBytes(12).toString('hex') + ext;
}

/**
 * Multer instance whose files land in UPLOAD_DIR/<scope>/ where scope is
 * `req.family.id` (default) or `users/<id>` for avatars. After multer runs,
 * each file has `.url` (e.g. "/uploads/3/ab12cd.jpg").
 */
export function makeUpload(uploadDir, { scope = (req) => String(req.family?.id ?? 'misc'), fileFilter } = {}) {
  const disk = multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(uploadDir, scope(req));
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      cb(null, randomName(extFor(file.originalname, file.mimetype)));
    },
  });
  const storage = {
    _handleFile(req, file, cb) {
      disk._handleFile(req, file, (err, info) => {
        if (err) return cb(err);
        cb(null, { ...info, url: `/uploads/${scope(req)}/${info.filename}` });
      });
    },
    _removeFile(req, file, cb) {
      disk._removeFile(req, file, cb);
    },
  };
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 }, fileFilter });
}

export const imageOnly = (req, file, cb) => {
  if (/^image\//.test(file.mimetype)) cb(null, true);
  else cb(Object.assign(new Error('Please choose an image file'), { status: 400 }));
};

/**
 * Write a buffer into the family's upload folder (used by seeds / server-generated files).
 * Returns the public URL.
 */
export function makeStoreFile(uploadDir) {
  return function storeFile(familyId, buffer, ext = '.bin') {
    const dir = path.join(uploadDir, String(familyId));
    fs.mkdirSync(dir, { recursive: true });
    const name = randomName(ext.startsWith('.') ? ext : `.${ext}`);
    fs.writeFileSync(path.join(dir, name), buffer);
    return `/uploads/${familyId}/${name}`;
  };
}

/** Delete a previously uploaded file by its public URL (ignores foreign/missing paths). */
export function makeRemoveFile(uploadDir) {
  return function removeFile(url) {
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
    const rel = url.slice('/uploads/'.length);
    const abs = path.resolve(uploadDir, rel);
    if (!abs.startsWith(path.resolve(uploadDir) + path.sep)) return;
    fs.rm(abs, { force: true }, () => {});
  };
}

/**
 * Router-less handler set for serving uploads with access checks:
 *   /uploads/<familyId>/<file>       -> members of that family only
 *   /uploads/users/<userId>/<file>   -> that user, or anyone sharing a family with them
 */
export function makeUploadServer(db, uploadDir, requireAuth) {
  const isMember = db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?');
  const sharesFamily = db.prepare(
    `SELECT 1 FROM memberships a JOIN memberships b ON a.family_id = b.family_id
      WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`,
  );
  const root = path.resolve(uploadDir);

  function send(res, dir, file) {
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.')) return res.status(404).json({ error: 'Not found' });
    const abs = path.join(root, dir, file);
    if (!abs.startsWith(root + path.sep)) return res.status(404).json({ error: 'Not found' });
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
    });
  }

  return [
    ['/uploads/users/:userId/:file', requireAuth, (req, res) => {
      const uid = Number(req.params.userId);
      if (uid !== req.user.id && !sharesFamily.get(req.user.id, uid)) return res.status(404).json({ error: 'Not found' });
      send(res, path.join('users', String(uid)), req.params.file);
    }],
    ['/uploads/:familyId/:file', requireAuth, (req, res) => {
      const fid = Number(req.params.familyId);
      if (!Number.isInteger(fid) || !isMember.get(fid, req.user.id)) return res.status(404).json({ error: 'Not found' });
      send(res, String(fid), req.params.file);
    }],
  ];
}
