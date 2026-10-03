// Wall / Home feed — module "wall", mounted at /api/wall.
//
// Posts (text + up to 10 photos + optional mood), emoji reactions (one per member per post),
// threaded comments (one reply level), pinned posts, and a merged family feed that mixes posts
// with the other modules' activity entries (core `activity` table, same rows as GET /api/activity).
//
// Endpoints (all family-scoped; ids from another family → 404):
//   GET    /feed?before=<cursor>&limit=&filter=all|posts|photos|activity
//            -> { items: [{ type:'post'|'activity', key, created_at, post?|activity? }], pinned?: Post[], next_cursor }
//   GET    /posts/:id                       -> Post
//   POST   /posts            (JSON or multipart: body, mood, photos[] ≤10)      -> 201 Post
//   PATCH  /posts/:id        (JSON or multipart: body?, mood?, remove_photo_ids?, photos[])  author only
//   DELETE /posts/:id                       author or admin
//   PUT    /posts/:id/pin    { pinned }     admins and members (not children)
//   PUT    /posts/:id/reaction { emoji }    set / change my reaction
//   DELETE /posts/:id/reaction              remove my reaction
//   POST   /posts/:id/comments { body, parent_id? }   -> 201 Comment
//   PATCH  /comments/:id     { body }       author only
//   DELETE /comments/:id                    comment author, post author or admin
//   GET    /meta                            -> { reactions, moods, max_photos }
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { hydrateActivity, activityVisibleSql } from '../activity.js';
import { cleanStr, httpError, toId } from '../util.js';
import { MAX_COMMENT_CHARS, MAX_PHOTOS, MAX_POST_CHARS, MOODS, REACTIONS } from './wall/constants.js';
import { seedWall } from './wall/seed.js';

export const name = 'wall';

// Tables use AUTOINCREMENT so ids are never reused after a delete (old links/notifications must
// never point at somebody else's new post). DBs created before that are upgraded by upgradeSchema().
const POSTS_SQL = (t = 'wall_posts') => `CREATE TABLE IF NOT EXISTS ${t} (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     body TEXT NOT NULL DEFAULT '',
     mood TEXT,
     pinned_at TEXT,
     pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     edited_at TEXT)`;
const PHOTOS_SQL = (t = 'wall_post_photos') => `CREATE TABLE IF NOT EXISTS ${t} (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
     url TEXT NOT NULL,
     position INTEGER NOT NULL DEFAULT 0,
     width INTEGER,
     height INTEGER,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`;
const COMMENTS_SQL = (t = 'wall_comments') => `CREATE TABLE IF NOT EXISTS ${t} (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
     parent_id INTEGER REFERENCES wall_comments(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     edited_at TEXT)`;
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS wall_posts_family_created ON wall_posts(family_id, created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS wall_post_photos_post ON wall_post_photos(post_id, position)',
  'CREATE INDEX IF NOT EXISTS wall_comments_post ON wall_comments(post_id, created_at)',
];

export const migrations = [
  POSTS_SQL(),
  PHOTOS_SQL(),
  // pre-AUTOINCREMENT dev databases lack these (idempotent: "duplicate column" is ignored)
  'ALTER TABLE wall_post_photos ADD COLUMN width INTEGER',
  'ALTER TABLE wall_post_photos ADD COLUMN height INTEGER',
  `CREATE TABLE IF NOT EXISTS wall_reactions (
     post_id INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     emoji TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (post_id, user_id))`,
  COMMENTS_SQL(),
  ...INDEXES,
];

/**
 * One-time upgrade for databases created by an early build whose wall tables lacked
 * AUTOINCREMENT: rebuild them (rows and ids kept). Idempotent and cheap once upgraded.
 */
export function upgradeSchema(db) {
  const tables = [['wall_posts', POSTS_SQL], ['wall_post_photos', PHOTOS_SQL], ['wall_comments', COMMENTS_SQL]];
  const legacy = tables.filter(([t]) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    return row && !/AUTOINCREMENT/i.test(row.sql);
  });
  if (!legacy.length) return false;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      for (const [t, make] of legacy) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        db.exec(`DROP TABLE IF EXISTS ${t}_new`);
        db.exec(make(`${t}_new`));
        const shared = db.prepare(`PRAGMA table_info(${t}_new)`).all().map((c) => c.name).filter((c) => cols.includes(c));
        db.exec(`INSERT INTO ${t}_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM ${t}`);
        db.exec(`DROP TABLE ${t}`);
        db.exec(`ALTER TABLE ${t}_new RENAME TO ${t}`);
      }
      for (const sql of INDEXES) db.exec(sql);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return true;
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/;
const nowIso = () => new Date().toISOString();
const snippet = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] ?? '';

/** Load the full post objects (author, photos, reactions, comments) for a set of rows. */
export function hydratePosts(ctx, rows) {
  const { db } = ctx;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const inIds = `(${ids.map(() => '?').join(',')})`;
  const photos = db.prepare(`SELECT id, post_id, url, width, height FROM wall_post_photos WHERE post_id IN ${inIds} ORDER BY position, id`).all(...ids);
  const reactions = db.prepare(`SELECT post_id, user_id, emoji, created_at FROM wall_reactions WHERE post_id IN ${inIds} ORDER BY created_at, user_id`).all(...ids);
  const comments = db.prepare(`SELECT * FROM wall_comments WHERE post_id IN ${inIds} ORDER BY created_at, id`).all(...ids);
  const userIds = [...new Set([...rows.map((r) => r.user_id), ...comments.map((c) => c.user_id)].filter(Boolean))];
  const users = new Map();
  if (userIds.length) {
    for (const u of db.prepare(`SELECT * FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).all(...userIds)) {
      users.set(u.id, ctx.publicUser(u));
    }
  }
  const group = (list) => {
    const m = new Map();
    for (const x of list) m.set(x.post_id, [...(m.get(x.post_id) ?? []), x]);
    return m;
  };
  const byPhotos = group(photos);
  const byReactions = group(reactions);
  const byComments = group(comments);
  return rows.map((r) => {
    const cs = (byComments.get(r.id) ?? []).map((c) => ({
      id: c.id,
      post_id: c.post_id,
      parent_id: c.parent_id,
      user_id: c.user_id,
      body: c.body,
      created_at: c.created_at,
      edited_at: c.edited_at,
      author: c.user_id ? users.get(c.user_id) ?? null : null,
    }));
    return {
      id: r.id,
      family_id: r.family_id,
      user_id: r.user_id,
      body: r.body,
      mood: r.mood,
      pinned: !!r.pinned_at,
      pinned_at: r.pinned_at,
      pinned_by: r.pinned_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      edited_at: r.edited_at,
      author: r.user_id ? users.get(r.user_id) ?? null : null,
      photos: (byPhotos.get(r.id) ?? []).map((p) => ({ id: p.id, url: p.url, width: p.width ?? null, height: p.height ?? null })),
      reactions: (byReactions.get(r.id) ?? []).map((x) => ({ emoji: x.emoji, user_id: x.user_id, created_at: x.created_at })),
      comments: cs,
      comment_count: cs.length,
    };
  });
}

/** Member ids mentioned as @FirstName (or @nickname) in a text, excluding nobody. */
export function mentionedMembers(db, familyId, text) {
  const tags = [...String(text ?? '').matchAll(/@([\p{L}][\p{L}'’-]*)/gu)].map((m) => m[1].toLowerCase());
  if (!tags.length) return [];
  const members = db
    .prepare('SELECT u.id, u.name, m.nickname FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.family_id = ?')
    .all(familyId);
  const ids = new Set();
  for (const t of tags) {
    for (const m of members) {
      if (firstName(m.name).toLowerCase() === t || (m.nickname && m.nickname.toLowerCase() === t)) ids.add(m.id);
    }
  }
  return [...ids];
}

function parseIdList(value) {
  if (value === undefined || value === null || value === '') return [];
  let list = value;
  if (typeof value === 'string') {
    try {
      list = value.trim().startsWith('[') ? JSON.parse(value) : value.split(',');
    } catch {
      throw httpError(400, 'remove_photo_ids must be a list of ids');
    }
  }
  if (!Array.isArray(list)) throw httpError(400, 'remove_photo_ids must be a list of ids');
  return list.map((v) => toId(v, 'photo id'));
}

function parseMood(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !Object.hasOwn(MOODS, value)) throw httpError(400, 'Unknown mood');
  return value;
}

/** Optional `photo_meta` field: JSON [{width,height}] in the same order as the uploaded files. */
function parseMeta(value, count) {
  if (!value) return [];
  let list;
  try {
    list = JSON.parse(value);
  } catch {
    throw httpError(400, 'photo_meta must be JSON');
  }
  if (!Array.isArray(list)) throw httpError(400, 'photo_meta must be a list');
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : null);
  return Array.from({ length: count }, (_, i) => ({ width: dim(list[i]?.width), height: dim(list[i]?.height) }));
}

export function router(ctx) {
  const { db } = ctx;
  upgradeSchema(db);
  const r = Router();

  // multer with friendly errors (too many files, wrong type) — rejected uploads are auto-deleted.
  const photosUpload = (req, res, next) => {
    ctx.upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
      if (!err) {
        const bad = (req.files ?? []).find((f) => !IMAGE_TYPES.test(f.mimetype));
        if (bad) return next(httpError(400, 'Only photos can be attached (JPEG, PNG, WebP, GIF or HEIC)'));
        return next();
      }
      if (err.name === 'MulterError' && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT')) {
        return next(httpError(400, `You can attach up to ${MAX_PHOTOS} photos`));
      }
      next(err);
    });
  };

  const getPostRow = (familyId, id) => {
    const row = db.prepare('SELECT * FROM wall_posts WHERE id = ? AND family_id = ?').get(toId(id, 'post id'), familyId);
    if (!row) throw httpError(404, 'Post not found');
    return row;
  };
  const loadPost = (id) => hydratePosts(ctx, [db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(id)])[0];
  const getCommentRow = (familyId, id) => {
    const row = db
      .prepare('SELECT c.*, p.user_id AS post_author, p.family_id FROM wall_comments c JOIN wall_posts p ON p.id = c.post_id WHERE c.id = ? AND p.family_id = ?')
      .get(toId(id, 'comment id'), familyId);
    if (!row) throw httpError(404, 'Comment not found');
    return row;
  };
  const touch = (postId) => db.prepare('UPDATE wall_posts SET updated_at = ? WHERE id = ?').run(nowIso(), postId);

  r.get('/', (req, res) => res.json({ ok: true, module: name }));

  r.get('/meta', (req, res) => res.json({ reactions: REACTIONS, moods: MOODS, max_photos: MAX_PHOTOS }));

  // ---------- feed ----------
  r.get('/feed', (req, res) => {
    const fid = req.family.id;
    const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 50);
    const filter = ['all', 'posts', 'photos', 'activity'].includes(req.query.filter) ? req.query.filter : 'all';
    let cursor = null;
    if (req.query.before) {
      const m = /^(.+)~([01])~(\d+)$/.exec(String(req.query.before));
      if (!m) throw httpError(400, 'Invalid cursor');
      cursor = { at: m[1], src: Number(m[2]), id: Number(m[3]) };
    }
    // Sort key for both sources: (created_at, src, id) DESC with src 1 = post, 0 = activity.
    const before = (src) => (cursor ? ` AND (created_at, ${src}, id) < (?, ?, ?)` : '');
    const cursorParams = cursor ? [cursor.at, cursor.src, cursor.id] : [];

    let posts = [];
    if (filter !== 'activity') {
      let where = 'family_id = ?';
      if (filter === 'photos') where += ' AND EXISTS (SELECT 1 FROM wall_post_photos ph WHERE ph.post_id = wall_posts.id)';
      else where += ' AND pinned_at IS NULL';
      posts = db
        .prepare(`SELECT * FROM wall_posts WHERE ${where}${before(1)} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(fid, ...cursorParams, limit + 1);
    }
    let acts = [];
    if (filter === 'all' || filter === 'activity') {
      acts = db
        .prepare(`SELECT * FROM activity WHERE family_id = ? AND module <> 'wall' AND ${activityVisibleSql('activity')}${before(0)} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(fid, req.user.id, ...cursorParams, limit + 1);
    }
    const merged = [
      ...posts.map((p) => ({ src: 1, row: p })),
      ...acts.map((a) => ({ src: 0, row: a })),
    ].sort((a, b) => (a.row.created_at === b.row.created_at ? (a.src === b.src ? b.row.id - a.row.id : b.src - a.src) : a.row.created_at < b.row.created_at ? 1 : -1));
    const page = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const hydratedPosts = new Map(hydratePosts(ctx, page.filter((x) => x.src === 1).map((x) => x.row)).map((p) => [p.id, p]));
    const hydratedActs = new Map(hydrateActivity(db, page.filter((x) => x.src === 0).map((x) => x.row)).map((a) => [a.id, a]));
    const items = page.map((x) =>
      x.src === 1
        ? { type: 'post', key: `p${x.row.id}`, created_at: x.row.created_at, post: hydratedPosts.get(x.row.id) }
        : { type: 'activity', key: `a${x.row.id}`, created_at: x.row.created_at, activity: hydratedActs.get(x.row.id) },
    );
    const last = page[page.length - 1];
    const out = { items, next_cursor: hasMore && last ? `${last.row.created_at}~${last.src}~${last.row.id}` : null };
    if (!cursor && (filter === 'all' || filter === 'posts')) {
      out.pinned = hydratePosts(ctx, db.prepare('SELECT * FROM wall_posts WHERE family_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC, id DESC').all(fid));
    }
    res.json(out);
  });

  // ---------- posts ----------
  r.get('/posts/:id', (req, res) => {
    const row = getPostRow(req.family.id, req.params.id);
    res.json(hydratePosts(ctx, [row])[0]);
  });

  r.post('/posts', photosUpload, (req, res) => {
    const fid = req.family.id;
    const body = cleanStr(req.body?.body, { field: 'Post', max: MAX_POST_CHARS }) ?? '';
    const mood = parseMood(req.body?.mood) ?? null;
    const files = req.files ?? [];
    if (!body && !files.length) throw httpError(400, 'Write something or add a photo');
    const meta = parseMeta(req.body?.photo_meta, files.length);
    const post = ctx.tx(db, () => {
      const at = nowIso();
      const { lastInsertRowid } = db
        .prepare('INSERT INTO wall_posts (family_id, user_id, body, mood, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fid, req.user.id, body, mood, at, at);
      const insertPhoto = db.prepare('INSERT INTO wall_post_photos (post_id, url, position, width, height) VALUES (?, ?, ?, ?, ?)');
      files.forEach((f, i) => insertPhoto.run(lastInsertRowid, f.url, i, meta[i]?.width ?? null, meta[i]?.height ?? null));
      return loadPost(Number(lastInsertRowid));
    });
    ctx.broadcast(fid, 'wall.post.created', post);
    const n = files.length;
    ctx.logActivity({
      familyId: fid, userId: req.user.id, module: 'wall', verb: 'posted', entityId: post.id,
      summary: n ? `shared ${n === 1 ? 'a photo' : `${n} photos`}` : 'shared a post',
      link: `/home/post/${post.id}`,
    });
    const who = firstName(req.user.name);
    const mentioned = mentionedMembers(db, fid, body).filter((id) => id !== req.user.id);
    if (mentioned.length) {
      ctx.notify({ familyId: fid, userIds: mentioned, module: 'wall', title: `${who} mentioned you in a post`, body: snippet(body), link: `/home/post/${post.id}`, excludeUserId: req.user.id });
    }
    res.status(201).json(post);
  });

  r.patch('/posts/:id', photosUpload, (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    if (row.user_id !== req.user.id) throw httpError(403, 'You can only edit your own posts');
    const body = req.body?.body === undefined ? row.body : cleanStr(req.body.body, { field: 'Post', max: MAX_POST_CHARS }) ?? '';
    const moodIn = parseMood(req.body?.mood);
    const mood = moodIn === undefined ? row.mood : moodIn;
    const removeIds = parseIdList(req.body?.remove_photo_ids);
    const files = req.files ?? [];
    const current = db.prepare('SELECT id, url FROM wall_post_photos WHERE post_id = ? ORDER BY position, id').all(row.id);
    for (const id of removeIds) if (!current.some((p) => p.id === id)) throw httpError(400, 'That photo is not part of this post');
    const kept = current.filter((p) => !removeIds.includes(p.id));
    if (kept.length + files.length > MAX_PHOTOS) throw httpError(400, `A post can have up to ${MAX_PHOTOS} photos`);
    if (!body && !kept.length && !files.length) throw httpError(400, 'A post needs some text or at least one photo');
    const removed = current.filter((p) => removeIds.includes(p.id));
    const meta = parseMeta(req.body?.photo_meta, files.length);
    const textChanged = body !== row.body || mood !== row.mood || removed.length || files.length;
    const post = ctx.tx(db, () => {
      const at = nowIso();
      db.prepare('UPDATE wall_posts SET body = ?, mood = ?, updated_at = ?, edited_at = CASE WHEN ? THEN ? ELSE edited_at END WHERE id = ?')
        .run(body, mood, at, textChanged ? 1 : 0, at, row.id);
      const del = db.prepare('DELETE FROM wall_post_photos WHERE id = ?');
      for (const p of removed) del.run(p.id);
      const insertPhoto = db.prepare('INSERT INTO wall_post_photos (post_id, url, position, width, height) VALUES (?, ?, ?, ?, ?)');
      const reorder = db.prepare('UPDATE wall_post_photos SET position = ? WHERE id = ?');
      kept.forEach((p, i) => reorder.run(i, p.id));
      files.forEach((f, i) => insertPhoto.run(row.id, f.url, kept.length + i, meta[i]?.width ?? null, meta[i]?.height ?? null));
      return loadPost(row.id);
    });
    for (const p of removed) ctx.removeFile(p.url);
    ctx.broadcast(fid, 'wall.post.updated', post);
    const newlyMentioned = mentionedMembers(db, fid, body).filter((id) => !mentionedMembers(db, fid, row.body).includes(id));
    if (newlyMentioned.length) {
      ctx.notify({ familyId: fid, userIds: newlyMentioned, module: 'wall', title: `${firstName(req.user.name)} mentioned you in a post`, body: snippet(body), link: `/home/post/${row.id}`, excludeUserId: req.user.id });
    }
    res.json(post);
  });

  r.delete('/posts/:id', (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    if (row.user_id !== req.user.id && req.role !== 'admin') throw httpError(403, 'Only the author or an admin can delete this post');
    const photos = db.prepare('SELECT url FROM wall_post_photos WHERE post_id = ?').all(row.id);
    const staleNotes = db
      .prepare("SELECT id, user_id FROM notifications WHERE family_id = ? AND module = 'wall' AND link = ?")
      .all(fid, `/home/post/${row.id}`);
    ctx.tx(db, () => {
      db.prepare('DELETE FROM wall_posts WHERE id = ?').run(row.id);
      db.prepare("DELETE FROM activity WHERE family_id = ? AND module = 'wall' AND entity_id = ?").run(fid, row.id);
      // Stale notifications would otherwise open a "post not found" page.
      db.prepare("DELETE FROM notifications WHERE family_id = ? AND module = 'wall' AND link = ?").run(fid, `/home/post/${row.id}`);
    });
    for (const p of photos) ctx.removeFile(p.url);
    ctx.broadcast(fid, 'wall.post.deleted', { id: row.id });
    // Let affected bells drop the removed notifications right away.
    const byUser = new Map();
    for (const n of staleNotes) byUser.set(n.user_id, [...(byUser.get(n.user_id) ?? []), n.id]);
    for (const [userId, ids] of byUser) ctx.sendToUsers([userId], 'notification.removed', { ids }, fid);
    res.json({ ok: true });
  });

  r.put('/posts/:id/pin', (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    if (req.role === 'child') throw httpError(403, 'Ask a parent to pin posts');
    if (typeof req.body?.pinned !== 'boolean') throw httpError(400, 'pinned must be true or false');
    const pinned = req.body.pinned;
    db.prepare('UPDATE wall_posts SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(pinned ? nowIso() : null, pinned ? req.user.id : null, row.id);
    const post = loadPost(row.id);
    ctx.broadcast(fid, 'wall.post.pinned', post);
    if (pinned && row.user_id && row.user_id !== req.user.id) {
      ctx.notify({ familyId: fid, userIds: [row.user_id], module: 'wall', title: `${firstName(req.user.name)} pinned your post`, body: snippet(row.body) || null, link: `/home/post/${row.id}`, excludeUserId: req.user.id });
    }
    res.json(post);
  });

  // ---------- reactions ----------
  r.put('/posts/:id/reaction', (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    const emoji = req.body?.emoji;
    if (!REACTIONS.includes(emoji)) throw httpError(400, `Reaction must be one of ${REACTIONS.join(' ')}`);
    const prev = db.prepare('SELECT emoji FROM wall_reactions WHERE post_id = ? AND user_id = ?').get(row.id, req.user.id);
    db.prepare(
      `INSERT INTO wall_reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(post_id, user_id) DO UPDATE SET emoji = excluded.emoji`,
    ).run(row.id, req.user.id, emoji, nowIso());
    const post = loadPost(row.id);
    ctx.broadcast(fid, 'wall.reaction.updated', { post_id: row.id, reactions: post.reactions });
    if (!prev && row.user_id && row.user_id !== req.user.id) {
      ctx.notify({ familyId: fid, userIds: [row.user_id], module: 'wall', title: `${firstName(req.user.name)} reacted ${emoji} to your post`, body: snippet(row.body) || null, link: `/home/post/${row.id}`, excludeUserId: req.user.id });
    }
    res.json(post);
  });

  r.delete('/posts/:id/reaction', (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    db.prepare('DELETE FROM wall_reactions WHERE post_id = ? AND user_id = ?').run(row.id, req.user.id);
    const post = loadPost(row.id);
    ctx.broadcast(fid, 'wall.reaction.updated', { post_id: row.id, reactions: post.reactions });
    res.json(post);
  });

  // ---------- comments ----------
  r.post('/posts/:id/comments', (req, res) => {
    const fid = req.family.id;
    const row = getPostRow(fid, req.params.id);
    const body = cleanStr(req.body?.body, { field: 'Comment', required: true, max: MAX_COMMENT_CHARS });
    let parent = null;
    if (req.body?.parent_id !== undefined && req.body?.parent_id !== null) {
      parent = db.prepare('SELECT * FROM wall_comments WHERE id = ? AND post_id = ?').get(toId(req.body.parent_id, 'parent_id'), row.id);
      if (!parent) throw httpError(400, 'The comment you replied to no longer exists');
      if (parent.parent_id) parent = db.prepare('SELECT * FROM wall_comments WHERE id = ?').get(parent.parent_id); // one reply level
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO wall_comments (post_id, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, parent?.id ?? null, req.user.id, body, nowIso());
    touch(row.id);
    const comment = loadPost(row.id).comments.find((c) => c.id === Number(lastInsertRowid));
    ctx.broadcast(fid, 'wall.comment.created', { post_id: row.id, comment });
    const who = firstName(req.user.name);
    const link = `/home/post/${row.id}`;
    const mentioned = mentionedMembers(db, fid, body);
    const notified = new Set([req.user.id]);
    if (mentioned.length) {
      ctx.notify({ familyId: fid, userIds: mentioned.filter((id) => !notified.has(id)), module: 'wall', title: `${who} mentioned you in a comment`, body: snippet(body), link, excludeUserId: req.user.id });
      mentioned.forEach((id) => notified.add(id));
    }
    if (parent?.user_id && !notified.has(parent.user_id)) {
      ctx.notify({ familyId: fid, userIds: [parent.user_id], module: 'wall', title: `${who} replied to your comment`, body: snippet(body), link, excludeUserId: req.user.id });
      notified.add(parent.user_id);
    }
    if (row.user_id && !notified.has(row.user_id)) {
      ctx.notify({ familyId: fid, userIds: [row.user_id], module: 'wall', title: `${who} commented on your post`, body: snippet(body), link, excludeUserId: req.user.id });
    }
    res.status(201).json(comment);
  });

  r.patch('/comments/:id', (req, res) => {
    const fid = req.family.id;
    const c = getCommentRow(fid, req.params.id);
    if (c.user_id !== req.user.id) throw httpError(403, 'You can only edit your own comments');
    const body = cleanStr(req.body?.body, { field: 'Comment', required: true, max: MAX_COMMENT_CHARS });
    if (body !== c.body) db.prepare('UPDATE wall_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), c.id);
    touch(c.post_id);
    const comment = loadPost(c.post_id).comments.find((x) => x.id === c.id);
    ctx.broadcast(fid, 'wall.comment.updated', { post_id: c.post_id, comment });
    res.json(comment);
  });

  r.delete('/comments/:id', (req, res) => {
    const fid = req.family.id;
    const c = getCommentRow(fid, req.params.id);
    if (c.user_id !== req.user.id && c.post_author !== req.user.id && req.role !== 'admin') {
      throw httpError(403, 'You can only delete your own comments');
    }
    db.prepare('DELETE FROM wall_comments WHERE id = ?').run(c.id); // replies cascade
    touch(c.post_id);
    ctx.broadcast(fid, 'wall.comment.deleted', { post_id: c.post_id, id: c.id });
    res.json({ ok: true });
  });

  return r;
}

export function seed(ctx, opts) {
  upgradeSchema(ctx.db);
  return seedWall(ctx, opts);
}

/** Global search: post text and comments. */
export function search(ctx, familyId, q) {
  const like = String(q);
  const posts = ctx.db
    .prepare(
      `SELECT p.id, p.body, p.created_at, u.name AS author FROM wall_posts p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.family_id = ? AND search_match(p.body, ?) ORDER BY p.created_at DESC LIMIT 6`,
    )
    .all(familyId, like);
  const comments = ctx.db
    .prepare(
      `SELECT c.id, c.post_id, c.body, u.name AS author FROM wall_comments c JOIN wall_posts p ON p.id = c.post_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE p.family_id = ? AND search_match(c.body, ?) ORDER BY c.created_at DESC LIMIT 4`,
    )
    .all(familyId, like);
  const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return [
    ...posts.map((p) => ({ title: snippet(p.body, 70), subtitle: `Post by ${firstName(p.author) || 'a former member'} · ${day(p.created_at)}`, link: `/home/post/${p.id}` })),
    ...comments.map((c) => ({ title: snippet(c.body, 70), subtitle: `Comment by ${firstName(c.author) || 'a former member'}`, link: `/home/post/${c.post_id}` })),
  ].slice(0, 8);
}
