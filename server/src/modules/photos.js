// Photo albums — module "photos", mounted at /api/photos.
//
//   GET    /                          overview { total, unsorted, albums, contributors, recent[] }
//   GET    /all?cursor&limit&album&member&until   timeline page { items, next_cursor, total, months? } (newest first by local
//          capture date; `until=<photoId>` extends the page so that photo is included — used by deep links)
//   GET    /albums                    albums with cover, count, date range, contributors
//   POST   /albums {title, description?, event_date?}
//   GET    /albums/:id                album + photos[]
//   PATCH  /albums/:id {title?, description?, event_date?, cover_photo_id?}
//   DELETE /albums/:id {keep_photos?=true}  (creator or admin; non-admins only ever delete photos they uploaded)
//   POST   /upload  multipart: file (+ thumb), album_id?, caption?, taken_at?, batch?  (bytes verified with ctx.verifyImage;
//                    a `thumb` (≤ 1280 px) is REQUIRED when the photo is larger than 2560 px on a side — the web client always sends one)
//   POST   /batches/:batch/done       one Wall entry + notification for a multi-upload ("added 5 photos to …")
//   GET    /items/:id                 photo + likers + comments
//   PATCH  /items/:id {caption?, album_id?, taken_at?}
//   DELETE /items/:id                 (uploader or admin)
//   GET    /items/:id/download        attachment with a friendly file name
//   POST   /items/:id/like · DELETE /items/:id/like
//   POST   /items/:id/comments {body} · DELETE /items/:id/comments/:commentId
//   POST   /items/move {ids, album_id|null} · POST /items/delete {ids}
//
// Permissions: everyone (children too) can upload, create albums, like and comment. Captions / moving:
// the uploader or any adult (admin/member). Deleting a photo: uploader or admin. Album edits: creator
// or any adult; deleting an album: creator or admin. Deleting a comment: author or admin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { makeUpload } from '../uploads.js';
import { cleanStr, firstName, httpError, isDate, toId } from '../util.js';
import { dateIn } from '../time.js';
import { hydrateActivity } from '../activity.js';
import { encodePng, isIntactImage } from './photos/png.js';
import { PRESETS, renderScene, downscale } from './photos/scenes.js';

export const name = 'photos';

export const migrations = [
  `CREATE TABLE IF NOT EXISTS photo_albums (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     description TEXT,
     event_date TEXT,
     cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE TABLE IF NOT EXISTS photos (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     album_id INTEGER REFERENCES photo_albums(id) ON DELETE SET NULL,
     url TEXT NOT NULL,
     thumb_url TEXT,
     width INTEGER,
     height INTEGER,
     size INTEGER,
     mime TEXT,
     original_name TEXT,
     caption TEXT,
     taken_at TEXT NOT NULL,
     batch TEXT,
     uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS photos_family_taken ON photos(family_id, taken_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS photos_album ON photos(album_id)`,
  `CREATE INDEX IF NOT EXISTS photo_albums_family ON photo_albums(family_id)`,
  `CREATE TABLE IF NOT EXISTS photo_likes (
     photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (photo_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS photo_comments (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS photo_comments_photo ON photo_comments(photo_id, id)`,
  // Local calendar date of the capture (in the uploader's zone) — used for month grouping.
  `ALTER TABLE photos ADD COLUMN taken_date TEXT`,
  // Wall entry that announced this photo (so its "added N photos" count can be kept right).
  `ALTER TABLE photos ADD COLUMN activity_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS photos_timeline ON photos(family_id, taken_date DESC, taken_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS photos_family_created ON photos(family_id, created_at DESC, id DESC)`,
];

const BATCH_RE = /^[A-Za-z0-9_-]{6,48}$/;
/** Photos bigger than this (px, either side) must come with a `thumb` so grids never load originals. */
const THUMB_REQUIRED_ABOVE = 2560;
const MAX_THUMB_SIDE = 1280;
/** Largest first page a deep link (`until`) may request. */
const MAX_UNTIL_PAGE = 500;
const MAX_BULK = 200;
/** Multi-uploads that never call /batches/:id/done are announced automatically after this delay. */
const BATCH_AUTO_MS = 90_000;

const isAdult = (role) => role === 'admin' || role === 'member';

function parseTakenAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw httpError(400, 'Invalid photo date');
  const d = isDate(value) ? new Date(`${value}T12:00:00.000Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(400, 'Invalid photo date');
  if (d.getTime() > Date.now() + 2 * 864e5) throw httpError(400, 'Photo date cannot be in the future');
  if (d.getUTCFullYear() < 1900) throw httpError(400, 'Photo date is too far in the past');
  return d.toISOString();
}

/** Local calendar date of a capture: the given 'YYYY-MM-DD', else the instant in the uploader's zone. */
function localDate(raw, iso, tz) {
  if (isDate(raw)) return raw;
  try {
    return dateIn(tz, new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function parseEventDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isDate(value)) throw httpError(400, 'Event date must be a valid date (YYYY-MM-DD)');
  return value;
}

function idList(value) {
  if (!Array.isArray(value) || !value.length) throw httpError(400, 'Choose at least one photo');
  if (value.length > MAX_BULK) throw httpError(400, `You can change at most ${MAX_BULK} photos at once`);
  return [...new Set(value.map((v) => toId(v, 'photo id')))];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const slug = (s) => (s || 'photo').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'photo';

export function router(ctx) {
  const { db } = ctx;
  const r = Router();
  // The client's MIME type is never trusted: every stored file is checked with ctx.verifyImage.
  const upload = makeUpload(ctx.uploadDir);
  const helpers = makeHelpers(ctx);
  const { photoSelect, serializePhoto, getPhoto, getAlbum, serializeAlbum, albumSelect, finalizeBatch } = helpers;
  const batchTimers = new Map();

  /**
   * After photos (and maybe an album) are deleted: remove their files, the Wall entries and
   * notifications that point at them, and tell open clients ('activity.removed', 'notification.removed').
   */
  function cleanupDeleted(familyId, rows, { albumId = null } = {}) {
    for (const p of rows) {
      ctx.removeFile(p.url);
      if (p.thumb_url) ctx.removeFile(p.thumb_url);
    }
    // "added N photos" entries: recount what's left of each batch; rewrite the count or remove the entry.
    const acts = [];
    for (const actId of new Set(rows.map((p) => p.activity_id).filter(Boolean))) {
      const act = db.prepare("SELECT * FROM activity WHERE id = ? AND family_id = ? AND module = 'photos'").get(actId, familyId);
      if (!act) continue;
      const left = db.prepare('SELECT id FROM photos WHERE activity_id = ? AND family_id = ? ORDER BY id').all(actId, familyId).map((r) => r.id);
      if (!left.length) {
        acts.push(actId);
        continue;
      }
      const what = left.length === 1 ? 'a photo' : plural(left.length, 'photo');
      const summary = act.summary.replace(/^added (a photo|\d+ photos)/, `added ${what}`);
      const link = /^\/photos\/all\?photo=/.test(act.link ?? '') ? `/photos/all?photo=${left[0]}` : act.link;
      db.prepare('UPDATE activity SET summary = ?, link = ? WHERE id = ?').run(summary, link, actId);
      const [row] = hydrateActivity(db, [db.prepare('SELECT * FROM activity WHERE id = ?').get(actId)]);
      ctx.broadcast(familyId, 'activity.updated', row);
    }
    const links = rows.flatMap((p) => [`/photos/all?photo=${p.id}`, ...(p.album_id ? [`/photos/albums/${p.album_id}?photo=${p.id}`] : [])]);
    if (albumId) links.push(`/photos/albums/${albumId}`);
    const marks = links.map(() => '?').join(',');
    if (links.length) {
      // Legacy entries without a photo mapping that point straight at a deleted photo/album.
      for (const a of db.prepare(`SELECT id FROM activity WHERE family_id = ? AND module = 'photos' AND link IN (${marks})
        AND id NOT IN (SELECT activity_id FROM photos WHERE activity_id IS NOT NULL)`).all(familyId, ...links)) acts.push(a.id);
    }
    if (albumId) {
      for (const a of db.prepare("SELECT id FROM activity WHERE family_id = ? AND module = 'photos' AND link = ?").all(familyId, `/photos/albums/${albumId}`)) acts.push(a.id);
    }
    if (!links.length) return;
    const notes = db.prepare(`SELECT id, user_id FROM notifications WHERE family_id = ? AND module = 'photos' AND link IN (${marks})`).all(familyId, ...links);
    if (acts.length) {
      const ids = [...new Set(acts)];
      db.prepare(`DELETE FROM activity WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      // Activity ids can be reused by SQLite once deleted — drop the mapping so photos never point at a stranger's entry.
      db.prepare(`UPDATE photos SET activity_id = NULL WHERE activity_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      ctx.broadcast(familyId, 'activity.removed', { ids });
    }
    ctx.removeNotifications(familyId, notes);
  }

  // Local capture dates for rows that predate the column, in each family's zone (not UTC).
  try {
    const missing = db.prepare('SELECT id, family_id, taken_at FROM photos WHERE taken_date IS NULL').all();
    const set = db.prepare('UPDATE photos SET taken_date = ? WHERE id = ?');
    const zones = new Map();
    for (const p of missing) {
      if (!zones.has(p.family_id)) zones.set(p.family_id, ctx.time?.familyTz ? ctx.time.familyTz(p.family_id) : 'UTC');
      set.run(localDate(null, p.taken_at, zones.get(p.family_id)), p.id);
    }
  } catch (err) {
    console.error('[photos] taken_date backfill failed', err.message);
  }

  // Multi-uploads whose "done" call (or auto-announce timer) was lost to a restart are announced now.
  try {
    const pending = db.prepare('SELECT DISTINCT family_id, uploaded_by, batch FROM photos WHERE batch IS NOT NULL AND uploaded_by IS NOT NULL').all();
    for (const b of pending) finalizeBatch(b.family_id, b.uploaded_by, b.batch);
  } catch (err) {
    console.error('[photos] batch sweep failed', err.message);
  }

  const requirePhoto = (req) => {
    const row = getPhoto(toId(req.params.id), req.family.id, req.user.id);
    if (!row) throw httpError(404, 'Photo not found');
    return row;
  };
  const requireAlbum = (req, id = req.params.id) => {
    const row = getAlbum(toId(id, 'album id'), req.family.id);
    if (!row) throw httpError(404, 'Album not found');
    return row;
  };
  const albumIdFromBody = (req, value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 'none') return null;
    return requireAlbum(req, value).id;
  };
  const canEditPhoto = (req, p) => p.uploaded_by === req.user.id || isAdult(req.role);
  const canDeletePhoto = (req, p) => p.uploaded_by === req.user.id || req.role === 'admin';
  const canEditAlbum = (req, a) => a.created_by === req.user.id || isAdult(req.role);
  const canDeleteAlbum = (req, a) => a.created_by === req.user.id || req.role === 'admin';
  const touchAlbum = (id) => id && db.prepare(`UPDATE photo_albums SET updated_at = ${ISO_NOW} WHERE id = ?`).run(id);

  // ---- overview ---------------------------------------------------------------------------
  r.get('/', (req, res) => {
    const fid = req.family.id;
    const counts = db.prepare(
      `SELECT COUNT(*) AS total, SUM(album_id IS NULL) AS unsorted, COUNT(DISTINCT uploaded_by) AS contributors FROM photos WHERE family_id = ?`,
    ).get(fid);
    const albums = db.prepare('SELECT COUNT(*) AS n FROM photo_albums WHERE family_id = ?').get(fid).n;
    const recent = db.prepare(`${photoSelect} WHERE p.family_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 12`)
      .all(req.user.id, fid).map((p) => serializePhoto(p, req));
    const likes = db.prepare('SELECT COUNT(*) AS n FROM photo_likes l JOIN photos p ON p.id = l.photo_id WHERE p.family_id = ?').get(fid).n;
    res.json({
      total: counts.total ?? 0,
      unsorted: counts.unsorted ?? 0,
      contributors: counts.contributors ?? 0,
      albums,
      likes,
      recent,
    });
  });

  // ---- timeline ---------------------------------------------------------------------------
  r.get('/all', (req, res) => {
    const fid = req.family.id;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const where = ['p.family_id = ?'];
    const params = [fid];
    if (req.query.album === 'none') where.push('p.album_id IS NULL');
    else if (req.query.album) {
      where.push('p.album_id = ?');
      params.push(requireAlbum(req, req.query.album).id);
    }
    if (req.query.member) {
      where.push('p.uploaded_by = ?');
      params.push(toId(req.query.member, 'member'));
    }
    const filterWhere = where.join(' AND ');
    const filterParams = [...params];
    if (req.query.cursor) {
      const [d, at, id] = String(req.query.cursor).split('~');
      if (!isDate(d) || !at || !Number.isInteger(Number(id))) throw httpError(400, 'Invalid cursor');
      where.push('(p.taken_date < ? OR (p.taken_date = ? AND (p.taken_at < ? OR (p.taken_at = ? AND p.id < ?))))');
      params.push(d, d, at, at, Number(id));
    }
    // Deep link: make the page long enough to include this photo (capped), so the viewer has context.
    let pageSize = limit;
    if (req.query.until) {
      const target = db.prepare('SELECT taken_date, taken_at, id FROM photos WHERE id = ? AND family_id = ?').get(toId(req.query.until, 'photo'), fid);
      if (target) {
        const before = db.prepare(
          `SELECT COUNT(*) AS n FROM photos p WHERE ${where.join(' AND ')}
             AND (p.taken_date > ? OR (p.taken_date = ? AND (p.taken_at > ? OR (p.taken_at = ? AND p.id >= ?))))`,
        ).get(...params, target.taken_date, target.taken_date, target.taken_at, target.taken_at, target.id).n;
        // Hard cap: a photo further back than this is reached by normal paging on the client.
        pageSize = Math.min(MAX_UNTIL_PAGE, Math.max(limit, before + 12));
      }
    }
    const rows = db.prepare(`${photoSelect} WHERE ${where.join(' AND ')} ORDER BY p.taken_date DESC, p.taken_at DESC, p.id DESC LIMIT ?`)
      .all(req.user.id, ...params, pageSize + 1);
    const more = rows.length > pageSize;
    const items = rows.slice(0, pageSize).map((p) => serializePhoto(p, req));
    const last = items[items.length - 1];
    const out = { items, next_cursor: more && last ? `${last.taken_date}~${last.taken_at}~${last.id}` : null };
    if (!req.query.cursor) {
      out.total = db.prepare(`SELECT COUNT(*) AS n FROM photos p WHERE ${filterWhere}`).get(...filterParams).n;
      out.months = db.prepare(
        `SELECT substr(p.taken_date, 1, 7) AS month, COUNT(*) AS count FROM photos p WHERE ${filterWhere} GROUP BY month ORDER BY month DESC`,
      ).all(...filterParams);
    }
    res.json(out);
  });

  // ---- albums -----------------------------------------------------------------------------
  r.get('/albums', (req, res) => {
    const rows = db.prepare(`${albumSelect} WHERE a.family_id = ?
      ORDER BY COALESCE(a.event_date, substr(last_taken_at, 1, 10), substr(a.created_at, 1, 10)) DESC, a.id DESC`).all(req.family.id);
    res.json(rows.map((a) => serializeAlbum(a, req)));
  });

  r.post('/albums', (req, res) => {
    const body = req.body ?? {};
    const title = cleanStr(body.title, { field: 'Album name', required: true, max: 80 });
    const description = cleanStr(body.description, { field: 'Description', max: 500 });
    const eventDate = parseEventDate(body.event_date) ?? null;
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO photo_albums (family_id, title, description, event_date, created_by) VALUES (?, ?, ?, ?, ?)',
    ).run(req.family.id, title, description, eventDate, req.user.id);
    const album = serializeAlbum(getAlbum(Number(lastInsertRowid), req.family.id), req);
    ctx.broadcast(req.family.id, 'photos.album.created', { id: album.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'photos', verb: 'created', entityId: album.id,
      summary: `created the album ${title}`, link: `/photos/albums/${album.id}`,
    });
    res.status(201).json(album);
  });

  r.get('/albums/:id', (req, res) => {
    const album = requireAlbum(req);
    const photos = db.prepare(`${photoSelect} WHERE p.family_id = ? AND p.album_id = ? ORDER BY p.taken_at DESC, p.id DESC LIMIT 2000`)
      .all(req.user.id, req.family.id, album.id).map((p) => serializePhoto(p, req));
    res.json({ ...serializeAlbum(album, req), photos });
  });

  r.patch('/albums/:id', (req, res) => {
    const album = requireAlbum(req);
    if (!canEditAlbum(req, album)) throw httpError(403, 'Only adults or the person who created this album can change it');
    const body = req.body ?? {};
    const sets = [];
    const params = [];
    if (body.title !== undefined) {
      sets.push('title = ?');
      params.push(cleanStr(body.title, { field: 'Album name', required: true, max: 80 }));
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(cleanStr(body.description, { field: 'Description', max: 500 }));
    }
    const eventDate = parseEventDate(body.event_date);
    if (eventDate !== undefined) {
      sets.push('event_date = ?');
      params.push(eventDate);
    }
    if (body.cover_photo_id !== undefined) {
      let cover = null;
      if (body.cover_photo_id !== null) {
        const p = db.prepare('SELECT id FROM photos WHERE id = ? AND family_id = ? AND album_id = ?')
          .get(toId(body.cover_photo_id, 'cover photo'), req.family.id, album.id);
        if (!p) throw httpError(400, 'The cover must be a photo from this album');
        cover = p.id;
      }
      sets.push('cover_photo_id = ?');
      params.push(cover);
    }
    if (!sets.length) throw httpError(400, 'Nothing to update');
    db.prepare(`UPDATE photo_albums SET ${sets.join(', ')}, updated_at = ${ISO_NOW} WHERE id = ? AND family_id = ?`)
      .run(...params, album.id, req.family.id);
    const updated = serializeAlbum(getAlbum(album.id, req.family.id), req);
    ctx.broadcast(req.family.id, 'photos.album.updated', { id: album.id });
    res.json(updated);
  });

  r.delete('/albums/:id', (req, res) => {
    const album = requireAlbum(req);
    if (!canDeleteAlbum(req, album)) throw httpError(403, 'Only an admin or the person who created this album can delete it');
    // Photos are kept unless the caller explicitly asks to delete them — and even then a non-admin
    // only deletes the photos they uploaded themselves; everyone else's are moved out of the album.
    const keep = !(req.body?.keep_photos === false || req.query.keep_photos === '0');
    let removed = [];
    let kept = 0;
    ctx.tx(db, () => {
      if (!keep) {
        removed = req.role === 'admin'
          ? db.prepare('SELECT * FROM photos WHERE album_id = ? AND family_id = ?').all(album.id, req.family.id)
          : db.prepare('SELECT * FROM photos WHERE album_id = ? AND family_id = ? AND uploaded_by = ?').all(album.id, req.family.id, req.user.id);
        const del = db.prepare('DELETE FROM photos WHERE id = ?');
        for (const p of removed) del.run(p.id);
      }
      kept = Number(db.prepare('UPDATE photos SET album_id = NULL WHERE album_id = ? AND family_id = ?').run(album.id, req.family.id).changes);
      db.prepare('DELETE FROM photo_albums WHERE id = ? AND family_id = ?').run(album.id, req.family.id);
    });
    cleanupDeleted(req.family.id, removed, { albumId: album.id });
    ctx.broadcast(req.family.id, 'photos.album.deleted', { id: album.id, kept_photos: kept, deleted_photos: removed.length });
    res.json({ ok: true, deleted_photos: removed.length, kept_photos: kept });
  });

  // ---- upload -----------------------------------------------------------------------------
  r.post('/upload', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), (req, res) => {
    const file = req.files?.file?.[0];
    const thumb = req.files?.thumb?.[0] ?? null;
    if (!file) throw httpError(400, 'Choose a photo to upload');
    const body = req.body ?? {};
    const albumId = albumIdFromBody(req, body.album_id) ?? null;
    const caption = cleanStr(body.caption, { field: 'Caption', max: 500 });
    const takenAt = parseTakenAt(body.taken_at) ?? new Date().toISOString();
    const batch = body.batch ? String(body.batch) : null;
    if (batch && !BATCH_RE.test(batch)) throw httpError(400, 'Invalid upload batch');
    // Real bytes only: JPEG/PNG/GIF/WebP/AVIF with sane dimensions; renamed to the detected extension.
    const name = (file.originalname || 'photo').slice(0, 80);
    const dims = ctx.verifyImage(file, `“${name}” is not a supported image (JPEG, PNG, GIF, WebP or AVIF)`);
    if (!isIntactImage(fs.readFileSync(file.path), dims.mime)) throw httpError(400, `“${name}” looks damaged or incomplete — try exporting it again`);
    if (thumb) {
      const t = ctx.verifyImage(thumb, 'The preview image is not a valid image');
      if (t.width > MAX_THUMB_SIDE || t.height > MAX_THUMB_SIDE) throw httpError(400, `The preview image must be at most ${MAX_THUMB_SIDE} px on a side`);
      if (!isIntactImage(fs.readFileSync(thumb.path), t.mime)) throw httpError(400, 'The preview image looks damaged');
    } else if (dims.width > THUMB_REQUIRED_ABOVE || dims.height > THUMB_REQUIRED_ABOVE) {
      throw httpError(400, `Photos larger than ${THUMB_REQUIRED_ABOVE} px need a preview image (“thumb” field) — or resize before uploading`);
    }
    const takenDate = localDate(body.taken_at, takenAt, ctx.time.tz(req));
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO photos (family_id, album_id, url, thumb_url, width, height, size, mime, original_name, caption, taken_at, taken_date, batch, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.family.id, albumId, file.url, thumb?.url ?? null, dims.width, dims.height, file.size, dims.mime,
      (file.originalname || '').slice(0, 200) || null, caption, takenAt, takenDate, batch, req.user.id,
    );
    const id = Number(lastInsertRowid);
    touchAlbum(albumId);
    const photo = serializePhoto(getPhoto(id, req.family.id, req.user.id), req);
    ctx.broadcast(req.family.id, 'photos.photo.added', { id, album_id: albumId, uploaded_by: req.user.id });
    if (!batch) {
      finalizeBatch(req.family.id, req.user.id, null, [id]);
    } else {
      const key = `${req.family.id}:${req.user.id}:${batch}`;
      clearTimeout(batchTimers.get(key));
      const t = setTimeout(() => {
        batchTimers.delete(key);
        try {
          finalizeBatch(req.family.id, req.user.id, batch);
        } catch (err) {
          console.error('[photos] auto batch finalize failed', err.message);
        }
      }, BATCH_AUTO_MS);
      t.unref?.();
      batchTimers.set(key, t);
    }
    res.status(201).json(photo);
  });

  r.post('/batches/:batch/done', (req, res) => {
    const batch = String(req.params.batch);
    if (!BATCH_RE.test(batch)) throw httpError(400, 'Invalid upload batch');
    const key = `${req.family.id}:${req.user.id}:${batch}`;
    clearTimeout(batchTimers.get(key));
    batchTimers.delete(key);
    const count = finalizeBatch(req.family.id, req.user.id, batch);
    res.json({ ok: true, count });
  });

  // ---- bulk actions -----------------------------------------------------------------------
  const loadMany = (req, ids) => {
    const rows = db.prepare(`SELECT * FROM photos WHERE family_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.family.id, ...ids);
    if (rows.length !== ids.length) throw httpError(404, 'Some photos were not found');
    return rows;
  };

  r.post('/items/move', (req, res) => {
    const ids = idList(req.body?.ids);
    if (req.body?.album_id === undefined) throw httpError(400, 'Choose an album');
    const albumId = albumIdFromBody(req, req.body.album_id);
    const rows = loadMany(req, ids);
    if (rows.some((p) => !canEditPhoto(req, p))) throw httpError(403, "You can only move photos you uploaded");
    const from = [...new Set(rows.map((p) => p.album_id).filter(Boolean))];
    ctx.tx(db, () => {
      const upd = db.prepare('UPDATE photos SET album_id = ? WHERE id = ? AND family_id = ?');
      for (const p of rows) upd.run(albumId, p.id, req.family.id);
      // A cover that left its album is no longer valid.
      for (const a of from) {
        if (a !== albumId) {
          db.prepare('UPDATE photo_albums SET cover_photo_id = NULL WHERE id = ? AND cover_photo_id IS NOT NULL AND cover_photo_id NOT IN (SELECT id FROM photos WHERE album_id = ?)').run(a, a);
        }
      }
      touchAlbum(albumId);
    });
    ctx.broadcast(req.family.id, 'photos.photos.moved', { ids, album_id: albumId });
    res.json({ ok: true, moved: ids.length, album_id: albumId });
  });

  r.post('/items/delete', (req, res) => {
    const ids = idList(req.body?.ids);
    const rows = loadMany(req, ids);
    if (rows.some((p) => !canDeletePhoto(req, p))) throw httpError(403, 'You can only delete photos you uploaded');
    ctx.tx(db, () => {
      const del = db.prepare('DELETE FROM photos WHERE id = ? AND family_id = ?');
      for (const p of rows) del.run(p.id, req.family.id);
    });
    cleanupDeleted(req.family.id, rows);
    ctx.broadcast(req.family.id, 'photos.photos.deleted', { ids });
    res.json({ ok: true, deleted: ids.length });
  });

  // ---- single photo -----------------------------------------------------------------------
  r.get('/items/:id', (req, res) => {
    const p = requirePhoto(req);
    res.json(helpers.photoDetail(p, req));
  });

  r.patch('/items/:id', (req, res) => {
    const p = requirePhoto(req);
    if (!canEditPhoto(req, p)) throw httpError(403, 'Only adults or the person who uploaded this photo can change it');
    const body = req.body ?? {};
    const sets = [];
    const params = [];
    if (body.caption !== undefined) {
      sets.push('caption = ?');
      params.push(cleanStr(body.caption, { field: 'Caption', max: 500 }));
    }
    if (body.taken_at !== undefined) {
      const t = parseTakenAt(body.taken_at);
      if (!t) throw httpError(400, 'Invalid photo date');
      sets.push('taken_at = ?', 'taken_date = ?');
      params.push(t, localDate(body.taken_at, t, ctx.time.tz(req)));
    }
    let movedTo;
    if (body.album_id !== undefined) {
      movedTo = albumIdFromBody(req, body.album_id);
      sets.push('album_id = ?');
      params.push(movedTo);
    }
    if (!sets.length) throw httpError(400, 'Nothing to update');
    ctx.tx(db, () => {
      db.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ? AND family_id = ?`).run(...params, p.id, req.family.id);
      if (movedTo !== undefined && p.album_id && movedTo !== p.album_id) {
        db.prepare('UPDATE photo_albums SET cover_photo_id = NULL WHERE id = ? AND cover_photo_id = ?').run(p.album_id, p.id);
      }
      if (movedTo) touchAlbum(movedTo);
    });
    const updated = serializePhoto(getPhoto(p.id, req.family.id, req.user.id), req);
    ctx.broadcast(req.family.id, 'photos.photo.updated', { id: p.id, album_id: updated.album_id });
    res.json(updated);
  });

  r.delete('/items/:id', (req, res) => {
    const p = requirePhoto(req);
    if (!canDeletePhoto(req, p)) throw httpError(403, 'Only an admin or the person who uploaded this photo can delete it');
    db.prepare('DELETE FROM photos WHERE id = ? AND family_id = ?').run(p.id, req.family.id);
    cleanupDeleted(req.family.id, [p]);
    ctx.broadcast(req.family.id, 'photos.photo.deleted', { id: p.id, album_id: p.album_id });
    res.json({ ok: true });
  });

  r.get('/items/:id/download', (req, res) => {
    const p = requirePhoto(req);
    const rel = String(p.url).replace(/^\/uploads\//, '');
    const abs = path.resolve(ctx.uploadDir, rel);
    if (!abs.startsWith(path.resolve(ctx.uploadDir) + path.sep) || !fs.existsSync(abs)) throw httpError(404, 'File not found');
    const ext = path.extname(abs) || '.jpg';
    const base = p.caption ? slug(p.caption) : `${slug(p.album_title || 'Hearth photo')}-${p.id}`;
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(abs, `${base}${ext}`);
  });

  r.post('/items/:id/like', (req, res) => {
    const p = requirePhoto(req);
    const { changes } = db.prepare('INSERT OR IGNORE INTO photo_likes (photo_id, user_id) VALUES (?, ?)').run(p.id, req.user.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM photo_likes WHERE photo_id = ?').get(p.id).n;
    if (changes) {
      ctx.broadcast(req.family.id, 'photos.photo.liked', { id: p.id, user_id: req.user.id, like_count: count, liked: true });
      if (p.uploaded_by && p.uploaded_by !== req.user.id) {
        ctx.notify({
          familyId: req.family.id, userIds: [p.uploaded_by], module: 'photos', excludeUserId: req.user.id,
          title: `${firstName(req.user.name)} liked your photo`, body: p.caption || (p.album_title ? `In ${p.album_title}` : null),
          link: helpers.photoLink(p),
        });
      }
    }
    res.json({ liked: true, like_count: count });
  });

  r.delete('/items/:id/like', (req, res) => {
    const p = requirePhoto(req);
    const { changes } = db.prepare('DELETE FROM photo_likes WHERE photo_id = ? AND user_id = ?').run(p.id, req.user.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM photo_likes WHERE photo_id = ?').get(p.id).n;
    if (changes) ctx.broadcast(req.family.id, 'photos.photo.liked', { id: p.id, user_id: req.user.id, like_count: count, liked: false });
    res.json({ liked: false, like_count: count });
  });

  r.post('/items/:id/comments', (req, res) => {
    const p = requirePhoto(req);
    const body = cleanStr(req.body?.body, { field: 'Comment', required: true, max: 1000 });
    const { lastInsertRowid } = db.prepare('INSERT INTO photo_comments (family_id, photo_id, user_id, body) VALUES (?, ?, ?, ?)')
      .run(req.family.id, p.id, req.user.id, body);
    const comment = helpers.getComment(Number(lastInsertRowid), req);
    ctx.broadcast(req.family.id, 'photos.comment.added', { id: comment.id, photo_id: p.id, user_id: req.user.id });
    helpers.notifyComment(p, req, body);
    res.status(201).json(comment);
  });

  r.delete('/items/:id/comments/:commentId', (req, res) => {
    const p = requirePhoto(req);
    const c = db.prepare('SELECT * FROM photo_comments WHERE id = ? AND photo_id = ? AND family_id = ?')
      .get(toId(req.params.commentId, 'comment id'), p.id, req.family.id);
    if (!c) throw httpError(404, 'Comment not found');
    if (c.user_id !== req.user.id && req.role !== 'admin') throw httpError(403, 'You can only delete your own comments');
    db.prepare('DELETE FROM photo_comments WHERE id = ?').run(c.id);
    ctx.broadcast(req.family.id, 'photos.comment.deleted', { id: c.id, photo_id: p.id });
    res.json({ ok: true });
  });

  return r;
}


/** Shared SQL/serialization helpers (also used by seed/search/dashboard). */
function makeHelpers(ctx) {
  const { db } = ctx;
  const photoSelect = `SELECT p.*, a.title AS album_title,
      u.name AS u_name, u.color AS u_color, u.avatar_url AS u_avatar,
      (SELECT COUNT(*) FROM photo_likes l WHERE l.photo_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM photo_comments c WHERE c.photo_id = p.id) AS comment_count,
      EXISTS (SELECT 1 FROM photo_likes l WHERE l.photo_id = p.id AND l.user_id = ?) AS liked
    FROM photos p
    LEFT JOIN photo_albums a ON a.id = p.album_id
    LEFT JOIN users u ON u.id = p.uploaded_by`;

  const albumSelect = `SELECT a.*,
      (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS photo_count,
      (SELECT MIN(taken_at) FROM photos p WHERE p.album_id = a.id) AS first_taken_at,
      (SELECT MAX(taken_at) FROM photos p WHERE p.album_id = a.id) AS last_taken_at,
      (SELECT group_concat(uid) FROM (SELECT DISTINCT uploaded_by AS uid FROM photos p WHERE p.album_id = a.id AND uploaded_by IS NOT NULL)) AS contributor_ids,
      u.name AS u_name
    FROM photo_albums a LEFT JOIN users u ON u.id = a.created_by`;

  const previewStmt = db.prepare(
    'SELECT id, url, thumb_url, width, height FROM photos WHERE album_id = ? ORDER BY taken_at DESC, id DESC LIMIT 4',
  );
  const coverStmt = db.prepare('SELECT id, url, thumb_url, width, height FROM photos WHERE id = ?');

  function serializePhoto(p, req) {
    const role = req?.role;
    const me = req?.user?.id;
    return {
      id: p.id,
      album_id: p.album_id,
      album_title: p.album_title ?? null,
      url: p.url,
      thumb_url: p.thumb_url || p.url,
      width: p.width,
      height: p.height,
      size: p.size,
      mime: p.mime,
      caption: p.caption,
      taken_at: p.taken_at,
      taken_date: p.taken_date || String(p.taken_at).slice(0, 10),
      created_at: p.created_at,
      uploaded_by: p.uploaded_by,
      uploader: p.uploaded_by && p.u_name ? { id: p.uploaded_by, name: p.u_name, color: p.u_color, avatar_url: p.u_avatar } : null,
      like_count: Number(p.like_count ?? 0),
      comment_count: Number(p.comment_count ?? 0),
      liked: !!p.liked,
      can_edit: !!req && (p.uploaded_by === me || isAdult(role)),
      can_delete: !!req && (p.uploaded_by === me || role === 'admin'),
    };
  }

  function getPhoto(id, familyId, userId) {
    return db.prepare(`${photoSelect} WHERE p.id = ? AND p.family_id = ?`).get(userId ?? 0, id, familyId) ?? null;
  }

  function getAlbum(id, familyId) {
    return db.prepare(`${albumSelect} WHERE a.id = ? AND a.family_id = ?`).get(id, familyId) ?? null;
  }

  function serializeAlbum(a, req) {
    const preview = previewStmt.all(a.id);
    let cover = a.cover_photo_id ? coverStmt.get(a.cover_photo_id) : null;
    if (!cover) cover = preview[0] ?? null;
    const me = req?.user?.id;
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      event_date: a.event_date,
      cover_photo_id: a.cover_photo_id,
      cover: cover ? { id: cover.id, url: cover.url, thumb_url: cover.thumb_url || cover.url, width: cover.width, height: cover.height } : null,
      preview: preview.map((p) => ({ id: p.id, thumb_url: p.thumb_url || p.url })),
      photo_count: Number(a.photo_count ?? 0),
      first_taken_at: a.first_taken_at,
      last_taken_at: a.last_taken_at,
      contributor_ids: a.contributor_ids ? String(a.contributor_ids).split(',').map(Number) : [],
      created_by: a.created_by,
      created_by_name: a.u_name ?? null,
      created_at: a.created_at,
      updated_at: a.updated_at,
      can_edit: !!req && (a.created_by === me || isAdult(req.role)),
      can_delete: !!req && (a.created_by === me || req.role === 'admin'),
    };
  }

  const photoLink = (p) => (p.album_id ? `/photos/albums/${p.album_id}?photo=${p.id}` : `/photos/all?photo=${p.id}`);

  function getComment(id, req) {
    const c = db.prepare(
      `SELECT c.*, u.name AS u_name, u.color AS u_color, u.avatar_url AS u_avatar FROM photo_comments c
       LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    ).get(id);
    return serializeComment(c, req);
  }

  function serializeComment(c, req) {
    return {
      id: c.id,
      photo_id: c.photo_id,
      body: c.body,
      created_at: c.created_at,
      user_id: c.user_id,
      user: c.user_id && c.u_name ? { id: c.user_id, name: c.u_name, color: c.u_color, avatar_url: c.u_avatar } : null,
      can_delete: !!req && (c.user_id === req.user.id || req.role === 'admin'),
    };
  }

  function photoDetail(p, req) {
    const likers = db.prepare(
      `SELECT u.id, u.name, u.color, u.avatar_url, l.created_at FROM photo_likes l JOIN users u ON u.id = l.user_id
       WHERE l.photo_id = ? ORDER BY l.created_at`,
    ).all(p.id);
    const comments = db.prepare(
      `SELECT c.*, u.name AS u_name, u.color AS u_color, u.avatar_url AS u_avatar FROM photo_comments c
       LEFT JOIN users u ON u.id = c.user_id WHERE c.photo_id = ? ORDER BY c.id`,
    ).all(p.id).map((c) => serializeComment(c, req));
    return { ...serializePhoto(p, req), likers, comments };
  }

  function notifyComment(p, req, body) {
    const fid = req.family.id;
    const me = req.user.id;
    const who = firstName(req.user.name);
    const link = photoLink(p);
    const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
    const notified = new Set([me]);
    // @mentions (first name or full name of a family member)
    const members = db.prepare('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.family_id = ?').all(fid);
    const lower = body.toLowerCase();
    const mentioned = members.filter((m) => {
      const first = firstName(m.name).toLowerCase();
      return new RegExp(`(^|\\s)@(${escapeRe(m.name.toLowerCase())}|${escapeRe(first)})(?![\\w])`).test(lower);
    }).map((m) => m.id).filter((id) => !notified.has(id));
    if (mentioned.length) {
      ctx.notify({ familyId: fid, userIds: mentioned, module: 'photos', title: `${who} mentioned you on a photo`, body: preview, link, excludeUserId: me });
      mentioned.forEach((id) => notified.add(id));
    }
    if (p.uploaded_by && !notified.has(p.uploaded_by)) {
      ctx.notify({ familyId: fid, userIds: [p.uploaded_by], module: 'photos', title: `${who} commented on your photo`, body: preview, link, excludeUserId: me });
      notified.add(p.uploaded_by);
    }
    const others = db.prepare('SELECT DISTINCT user_id FROM photo_comments WHERE photo_id = ? AND user_id IS NOT NULL').all(p.id)
      .map((r) => r.user_id).filter((id) => !notified.has(id));
    if (others.length) {
      ctx.notify({ familyId: fid, userIds: others, module: 'photos', title: `${who} also commented on a photo`, body: preview, link, excludeUserId: me });
    }
  }

  /**
   * Announce uploaded photos once: one Wall entry per album ("added 5 photos to Beach Trip") and a
   * notification for the rest of the family. With `batch`, picks up that batch's photos; otherwise `ids`.
   * Returns the number of photos announced.
   */
  function finalizeBatch(familyId, userId, batch, ids = null, { notify = true, createdAt = null } = {}) {
    const rows = batch
      ? db.prepare('SELECT id, album_id FROM photos WHERE family_id = ? AND uploaded_by = ? AND batch = ?').all(familyId, userId, batch)
      : db.prepare(`SELECT id, album_id FROM photos WHERE family_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(familyId, ...ids);
    if (!rows.length) return 0;
    if (batch) db.prepare('UPDATE photos SET batch = NULL WHERE family_id = ? AND uploaded_by = ? AND batch = ?').run(familyId, userId, batch);
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const byAlbum = new Map();
    for (const r of rows) byAlbum.set(r.album_id ?? 0, [...(byAlbum.get(r.album_id ?? 0) ?? []), r.id]);
    for (const [albumId, list] of byAlbum) {
      const album = albumId ? db.prepare('SELECT id, title FROM photo_albums WHERE id = ?').get(albumId) : null;
      const what = list.length === 1 ? 'a photo' : plural(list.length, 'photo');
      const summary = album ? `added ${what} to ${album.title}` : `added ${what}`;
      const link = album ? `/photos/albums/${album.id}` : `/photos/all?photo=${list[0]}`;
      const act = ctx.logActivity({ familyId, userId, module: 'photos', verb: 'uploaded', entityId: album ? album.id : list[0], summary, link, createdAt });
      if (act?.id) db.prepare(`UPDATE photos SET activity_id = ? WHERE id IN (${list.map(() => '?').join(',')})`).run(act.id, ...list);
      if (notify) {
        const everyone = db.prepare('SELECT user_id FROM memberships WHERE family_id = ?').all(familyId).map((m) => m.user_id);
        ctx.notify({
          familyId, userIds: everyone, excludeUserId: userId, module: 'photos',
          title: album ? `New photos in ${album.title}` : 'New family photos',
          body: `${firstName(user?.name)} ${summary}`, link,
        });
      }
    }
    return rows.length;
  }

  return {
    photoSelect, albumSelect, serializePhoto, getPhoto, getAlbum, serializeAlbum, photoLink, getComment, photoDetail,
    notifyComment, finalizeBatch,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- search / dashboard ------------------------------------------------------------------------
export function search(ctx, familyId, q) {
  const { db } = ctx;
  const albums = db.prepare(
    `SELECT a.id, a.title, a.description, (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS n
     FROM photo_albums a WHERE a.family_id = ? AND (search_match(a.title, ?) OR search_match(a.description, ?))
     ORDER BY a.id DESC LIMIT 5`,
  ).all(familyId, q, q);
  const photos = db.prepare(
    `SELECT p.id, p.caption, p.album_id, a.title AS album_title FROM photos p LEFT JOIN photo_albums a ON a.id = p.album_id
     WHERE p.family_id = ? AND search_match(p.caption, ?) ORDER BY p.taken_at DESC LIMIT 5`,
  ).all(familyId, q);
  return [
    ...albums.map((a) => ({ title: a.title, subtitle: `Album · ${plural(a.n, 'photo')}`, link: `/photos/albums/${a.id}` })),
    ...photos.map((p) => ({
      title: p.caption,
      subtitle: p.album_title ? `Photo in ${p.album_title}` : 'Photo',
      link: p.album_id ? `/photos/albums/${p.album_id}?photo=${p.id}` : `/photos/all?photo=${p.id}`,
    })),
  ];
}

export function dashboard(ctx, req) {
  const { db } = ctx;
  const recent = db.prepare(
    `SELECT p.id, p.url, p.thumb_url, p.width, p.height, p.caption, p.album_id, a.title AS album_title, p.created_at
     FROM photos p LEFT JOIN photo_albums a ON a.id = p.album_id WHERE p.family_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 6`,
  ).all(req.family.id).map((p) => ({ ...p, thumb_url: p.thumb_url || p.url, link: p.album_id ? `/photos/albums/${p.album_id}?photo=${p.id}` : `/photos/all?photo=${p.id}` }));
  const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE family_id = ?').get(req.family.id);
  const { n: albums } = db.prepare('SELECT COUNT(*) AS n FROM photo_albums WHERE family_id = ?').get(req.family.id);
  return { recent, total, albums };
}

// ---- seed --------------------------------------------------------------------------------------
const CACHE_DIR = path.join(os.tmpdir(), 'hearth-photos-seed-cache', 'v2');

/** Render (or load from a tmp cache) a seed scene: returns { full, thumb, width, height }. */
function seedImage(preset, seed, orientation = 'landscape') {
  const [W, H] = orientation === 'portrait' ? [800, 1080] : orientation === 'square' ? [1000, 1000] : [1200, 800];
  const [TW, TH] = [Math.round(W / 2.5), Math.round(H / 2.5)];
  const key = `${preset}-${seed}-${orientation}`;
  const fullPath = path.join(CACHE_DIR, `${key}.png`);
  const thumbPath = path.join(CACHE_DIR, `${key}.thumb.png`);
  try {
    if (fs.existsSync(fullPath) && fs.existsSync(thumbPath)) {
      return { full: fs.readFileSync(fullPath), thumb: fs.readFileSync(thumbPath), width: W, height: H };
    }
  } catch {
    /* fall through and render */
  }
  const [kind, params] = PRESETS[preset];
  const rgb = renderScene(kind, params, W, H, seed);
  const full = encodePng(W, H, rgb);
  const thumb = encodePng(TW, TH, downscale(rgb, W, H, TW, TH));
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fullPath, full);
    fs.writeFileSync(thumbPath, thumb);
  } catch {
    /* cache is best effort */
  }
  return { full, thumb, width: W, height: H };
}

export async function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  const { alex, sam, mia, leo } = users;
  const DAY = 864e5;
  const familyTz = ctx.time?.familyTz ? ctx.time.familyTz(familyId) : 'UTC';
  const at = (daysAgo, hour = 12, minute = 0) => {
    const d = new Date(Date.now() - daysAgo * DAY);
    d.setUTCHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const dateOnly = (iso) => iso.slice(0, 10);

  const insertAlbum = db.prepare(
    'INSERT INTO photo_albums (family_id, title, description, event_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertPhoto = db.prepare(
    `INSERT INTO photos (family_id, album_id, url, thumb_url, width, height, size, mime, original_name, caption, taken_at, taken_date, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'image/png', ?, ?, ?, ?, ?, ?)`,
  );
  const insertLike = db.prepare('INSERT OR IGNORE INTO photo_likes (photo_id, user_id, created_at) VALUES (?, ?, ?)');
  const insertComment = db.prepare('INSERT INTO photo_comments (family_id, photo_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)');

  let seedNo = 11;
  const addPhoto = (albumId, { preset, orient, caption, taken, by, uploaded, likes = [], comments = [] }) => {
    const img = seedImage(preset, seedNo++, orient);
    const url = ctx.storeFile(familyId, img.full, '.png');
    const thumbUrl = ctx.storeFile(familyId, img.thumb, '.png');
    const { lastInsertRowid } = insertPhoto.run(
      familyId, albumId, url, thumbUrl, img.width, img.height, img.full.length, `IMG_${4000 + seedNo}.png`,
      caption ?? null, taken, dateIn(familyTz, new Date(taken)), by.id, uploaded ?? taken,
    );
    const id = Number(lastInsertRowid);
    likes.forEach((u, i) => insertLike.run(id, u.id, new Date(Date.parse(uploaded ?? taken) + (i + 1) * 3_600_000).toISOString()));
    comments.forEach(([u, body], i) => insertComment.run(familyId, id, u.id, body, new Date(Date.parse(uploaded ?? taken) + (i + 1) * 5_400_000).toISOString()));
    return id;
  };
  const album = (title, description, eventDate, by, createdAt) =>
    Number(insertAlbum.run(familyId, title, description, eventDate, by.id, createdAt, createdAt).lastInsertRowid);

  // 1) Beach trip — ~6 weeks ago
  const beachDay = 44;
  const beach = album('Beach Trip — Outer Banks', 'Four lazy days of sand, sun and far too much ice cream 🏖️', dateOnly(at(beachDay)), sam, at(beachDay - 3, 20));
  const beachPhotos = [
    { preset: 'noonBeach', caption: 'First look at the ocean!', taken: at(beachDay, 10, 12), by: sam, likes: [alex, mia, leo], comments: [[leo, 'The water was SO cold 🥶'], [alex, 'Worth every minute of the drive.']] },
    { preset: 'goldenBeach', caption: 'Golden hour walk', taken: at(beachDay, 18, 40), by: alex, likes: [sam, mia] },
    { preset: 'sunsetBeach', caption: 'Best sunset of the trip 🌅', taken: at(beachDay - 1, 19, 22), by: sam, likes: [alex, mia, leo], comments: [[mia, 'Can this be my wallpaper?'], [sam, '@Mia of course! Download it from here 😊']] },
    { preset: 'noonBeach', orient: 'portrait', caption: 'Leo vs. the waves', taken: at(beachDay - 1, 11, 5), by: alex, likes: [sam, leo], comments: [[leo, 'I won.']] },
    { preset: 'duskBeach', caption: null, taken: at(beachDay - 1, 20, 2), by: mia, likes: [sam] },
    { preset: 'goldenBeach', orient: 'square', caption: 'Sandcastle engineering team', taken: at(beachDay - 2, 15, 30), by: sam, likes: [alex, mia, leo] },
    { preset: 'sunsetBeach', orient: 'portrait', caption: 'Last evening on the pier', taken: at(beachDay - 3, 19, 10), by: alex, likes: [sam] },
    { preset: 'duskBeach', caption: 'Stars coming out', taken: at(beachDay - 3, 20, 45), by: mia, likes: [alex, leo] },
    { preset: 'noonBeach', caption: 'Picnic spot', taken: at(beachDay - 2, 12, 15), by: leo, likes: [mia] },
  ];
  const beachIds = beachPhotos.map((p) => addPhoto(beach, { ...p, uploaded: at(beachDay - 3, 20, 30) }));
  db.prepare('UPDATE photo_albums SET cover_photo_id = ? WHERE id = ?').run(beachIds[2], beach);

  // 2) Mia's 12th birthday (June 21st of this year, or last year if still ahead)
  const now = new Date();
  let bday = new Date(Date.UTC(now.getUTCFullYear(), 5, 21, 15));
  if (bday.getTime() > now.getTime()) bday = new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 21, 15));
  const bdayDays = Math.round((now.getTime() - bday.getTime()) / DAY);
  const miaAge = bday.getUTCFullYear() - 2014;
  const birthday = album(`Mia's ${miaAge}th Birthday`, 'Balloons, cake and a backyard full of friends 🎈', dateOnly(bday.toISOString()), alex, at(bdayDays - 1, 9));
  const bdayPhotos = [
    { preset: 'partyBright', caption: 'Decorations are up!', taken: at(bdayDays, 13, 30), by: alex, likes: [sam, mia] },
    { preset: 'party', caption: 'Make a wish ✨', taken: at(bdayDays, 17, 5), by: sam, likes: [alex, mia, leo], comments: [[mia, 'Best. Cake. Ever.'], [leo, 'I helped with the frosting']] },
    { preset: 'partyNight', orient: 'portrait', caption: 'Glow party in the garden', taken: at(bdayDays, 20, 30), by: mia, likes: [sam, leo] },
    { preset: 'partyBright', orient: 'square', caption: 'Balloon overload', taken: at(bdayDays, 14, 10), by: leo, likes: [mia] },
    { preset: 'party', orient: 'portrait', caption: null, taken: at(bdayDays, 17, 20), by: alex, likes: [sam] },
    { preset: 'partyNight', caption: 'Dance floor 🪩', taken: at(bdayDays, 21, 0), by: sam, likes: [alex, mia], comments: [[alex, "Leo's dance moves 😂"], [leo, 'I was AMAZING']] },
  ];
  const bdayIds = bdayPhotos.map((p) => addPhoto(birthday, { ...p, uploaded: at(bdayDays - 1, 9, 30) }));
  db.prepare('UPDATE photo_albums SET cover_photo_id = ? WHERE id = ?').run(bdayIds[1], birthday);

  // 3) Autumn hike — 9 days ago
  const hikeDay = 9;
  const hike = album('Autumn Hike at Blue Ridge', 'Leaves turning, trail mix disappearing 🍂', dateOnly(at(hikeDay)), alex, at(hikeDay, 21));
  const hikePhotos = [
    { preset: 'blueRidge', caption: 'The view from the top was worth it', taken: at(hikeDay, 11, 40), by: alex, likes: [sam, mia, leo], comments: [[sam, 'Frame this one!']] },
    { preset: 'autumnForest', orient: 'portrait', caption: 'Trail through the maples', taken: at(hikeDay, 9, 55), by: sam, likes: [alex] },
    { preset: 'autumnRidge', caption: 'Sunset on the drive home', taken: at(hikeDay, 18, 5), by: alex, likes: [sam, mia] },
    { preset: 'lakeMirror', caption: 'Mirror lake — not a ripple', taken: at(hikeDay, 13, 15), by: mia, likes: [alex, sam, leo], comments: [[alex, 'Mia, you have a real eye for this 📸']] },
    { preset: 'mistyForest', caption: 'Morning fog at the trailhead', taken: at(hikeDay, 8, 20), by: sam, likes: [mia] },
    { preset: 'pineForest', orient: 'square', caption: 'Snack break 🥨', taken: at(hikeDay, 12, 30), by: leo, likes: [alex, sam] },
    { preset: 'alpine', caption: 'Peaks already have snow!', taken: at(hikeDay, 14, 5), by: alex, likes: [leo] },
  ];
  const hikeIds = hikePhotos.map((p) => addPhoto(hike, { ...p, uploaded: at(hikeDay, 21, 15) }));
  db.prepare('UPDATE photo_albums SET cover_photo_id = ? WHERE id = ?').run(hikeIds[0], hike);

  // 4) Winter break (last December) — shows year grouping in the timeline
  const lastDec = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 28, 12));
  const decDays = Math.round((now.getTime() - lastDec.getTime()) / DAY);
  const winter = album('Winter Break', 'Snow days and cocoa at the cabin ❄️', dateOnly(lastDec.toISOString()), sam, at(decDays - 2, 18));
  [
    { preset: 'winter', caption: 'Fresh snow overnight', taken: at(decDays, 9, 10), by: sam, likes: [alex, leo] },
    { preset: 'winterDusk', orient: 'portrait', caption: 'Pink winter sky', taken: at(decDays, 16, 40), by: alex, likes: [sam, mia] },
    { preset: 'aurora', caption: 'We saw the northern lights!!', taken: at(decDays - 1, 23, 30), by: mia, likes: [alex, sam, leo], comments: [[leo, 'Best night ever'], [sam, 'Once in a lifetime 💚']] },
    { preset: 'winter', orient: 'square', caption: 'Snowman crew ⛄', taken: at(decDays - 1, 11, 0), by: leo, likes: [mia] },
  ].forEach((p) => addPhoto(winter, { ...p, uploaded: at(decDays - 2, 18, 20) }));

  // 5) Unsorted everyday moments (recent)
  const meadow = addPhoto(null, { preset: 'springMeadow', caption: 'Wildflowers at the park', taken: at(3, 16, 20), by: sam, likes: [alex, mia] });
  addPhoto(null, { preset: 'cityDusk', caption: 'Downtown after the concert', taken: at(5, 19, 50), by: alex, likes: [sam] });
  const golden = addPhoto(null, { preset: 'goldenMeadow', orient: 'portrait', caption: null, taken: at(1, 18, 15), by: mia, likes: [leo] });
  const cityNight = addPhoto(null, { preset: 'cityNight', caption: 'City lights from the rooftop', taken: at(2, 21, 10), by: sam, likes: [alex, mia, leo], comments: [[alex, 'Great shot!']] });

  // Wall activity (backdated so the feed tells the story).
  const log = (u, summary, link, entityId, createdAt, verb = 'uploaded', photoIds = null) => {
    const act = ctx.logActivity({ familyId, userId: u.id, module: 'photos', verb, entityId, summary, link, createdAt });
    if (verb === 'uploaded' && act?.id) {
      if (photoIds) db.prepare(`UPDATE photos SET activity_id = ? WHERE id IN (${photoIds.map(() => '?').join(',')})`).run(act.id, ...photoIds);
      else if (entityId) db.prepare('UPDATE photos SET activity_id = ? WHERE album_id = ?').run(act.id, entityId);
    }
  };
  log(sam, 'created the album Winter Break', `/photos/albums/${winter}`, winter, at(decDays - 2, 18), 'created');
  log(sam, 'added 4 photos to Winter Break', `/photos/albums/${winter}`, winter, at(decDays - 2, 18, 21));
  log(alex, `created the album Mia's ${miaAge}th Birthday`, `/photos/albums/${birthday}`, birthday, at(bdayDays - 1, 9), 'created');
  log(alex, `added 6 photos to Mia's ${miaAge}th Birthday`, `/photos/albums/${birthday}`, birthday, at(bdayDays - 1, 9, 31));
  log(sam, 'created the album Beach Trip — Outer Banks', `/photos/albums/${beach}`, beach, at(beachDay - 3, 20), 'created');
  log(sam, 'added 9 photos to Beach Trip — Outer Banks', `/photos/albums/${beach}`, beach, at(beachDay - 3, 20, 31));
  log(alex, 'created the album Autumn Hike at Blue Ridge', `/photos/albums/${hike}`, hike, at(hikeDay, 21), 'created');
  log(alex, 'added 7 photos to Autumn Hike at Blue Ridge', `/photos/albums/${hike}`, hike, at(hikeDay, 21, 16));
  log(sam, 'added 2 photos', `/photos/all?photo=${cityNight}`, cityNight, at(2, 21, 30), 'uploaded', [meadow, cityNight]);
  log(mia, 'added a photo', `/photos/all?photo=${golden}`, golden, at(1, 18, 20), 'uploaded', [golden]);
}
