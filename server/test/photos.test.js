import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';
import { imageSize, encodePng, isIntactImage } from '../src/modules/photos/png.js';
import { router as photosRouter } from '../src/modules/photos.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const png = (w, h) => encodePng(w, h, Buffer.alloc(w * h * 3, 120));
const up = (agent, fields = {}, file = png(4, 3), opts = {}) =>
  agent.upload('/api/photos/upload', { file, filename: opts.filename ?? 'pic.png', type: opts.type ?? 'image/png', fields });

async function addChild(fx, name = 'Kid') {
  const email = `kid${Date.now()}${Math.random().toString(16).slice(2)}@example.test`;
  const res = await fx.admin.agent.post('/api/family/members', { name, email, role: 'child', password: 'secret123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const agent = srv.agent();
  const login = await agent.post('/api/auth/login', { email, password: 'secret123' });
  assert.equal(login.status, 200);
  return { agent, user: login.body.user };
}

test('png helpers: encoder output is readable and sized', () => {
  assert.deepEqual(imageSize(png(7, 5)), { width: 7, height: 5 });
  assert.deepEqual(imageSize(PNG_1X1), { width: 1, height: 1 });
  assert.equal(imageSize(Buffer.from('not an image at all, clearly')), null);
});

test('albums CRUD + validation', async () => {
  const { admin } = await familyFixture(srv, 'Albums');
  const a = admin.agent;
  assert.equal((await a.post('/api/photos/albums', {})).status, 400);
  assert.equal((await a.post('/api/photos/albums', { title: '   ' })).status, 400);
  assert.equal((await a.post('/api/photos/albums', { title: 'x'.repeat(81) })).status, 400);
  assert.equal((await a.post('/api/photos/albums', { title: 'Ok', event_date: '2024-02-31' })).status, 400);
  assert.equal((await a.post('/api/photos/albums', { title: 5 })).status, 400);

  const created = await a.post('/api/photos/albums', { title: ' Beach Trip ', description: 'Sun', event_date: '2026-07-04' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Beach Trip');
  assert.equal(created.body.photo_count, 0);
  assert.equal(created.body.cover, null);
  assert.equal(created.body.can_delete, true);

  const list = await a.get('/api/photos/albums');
  assert.equal(list.body.length, 1);

  const patched = await a.patch(`/api/photos/albums/${created.body.id}`, { title: 'Beach Week', event_date: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.title, 'Beach Week');
  assert.equal(patched.body.event_date, null);
  assert.equal((await a.patch(`/api/photos/albums/${created.body.id}`, {})).status, 400);
  assert.equal((await a.get('/api/photos/albums/999999')).status, 404);
  assert.equal((await a.get('/api/photos/albums/abc')).status, 400);

  // activity entry for album creation
  const act = await a.get('/api/activity?module=photos');
  assert.ok(act.body.some((e) => e.summary === 'created the album Beach Trip' && e.link === `/photos/albums/${created.body.id}`));

  const del = await a.del(`/api/photos/albums/${created.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await a.get(`/api/photos/albums/${created.body.id}`)).status, 404);
});

test('upload, dimensions, captions, cover, move, timeline, delete', async () => {
  const { admin, member } = await familyFixture(srv, 'Uploads');
  const a = admin.agent;
  const album = (await a.post('/api/photos/albums', { title: 'Trip' })).body;

  assert.equal((await a.upload('/api/photos/upload', { fields: { album_id: album.id } })).status, 400); // no file
  const bad = await up(a, {}, Buffer.from('hello'), { filename: 'x.txt', type: 'text/plain' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /JPEG, PNG/);
  assert.equal((await up(a, { album_id: 999999 })).status, 404);
  assert.equal((await up(a, { taken_at: 'yesterday-ish' })).status, 400);
  assert.equal((await up(a, { taken_at: '2999-01-01T00:00:00Z' })).status, 400);
  assert.equal((await up(a, { caption: 'x'.repeat(501) })).status, 400);

  const p1 = await up(a, { album_id: album.id, caption: 'Hello', taken_at: '2026-07-01T10:00:00.000Z' }, png(40, 30));
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.width, 40);
  assert.equal(p1.body.height, 30);
  assert.equal(p1.body.album_id, album.id);
  assert.equal(p1.body.caption, 'Hello');
  assert.equal(p1.body.uploader.id, admin.user.id);
  assert.match(p1.body.url, /^\/uploads\/\d+\//);
  const file = await a.get(p1.body.url);
  assert.equal(file.status, 200);

  // thumbnail field
  const form = new FormData();
  form.append('album_id', String(album.id));
  form.append('taken_at', '2026-07-02');
  form.append('file', new Blob([png(20, 40)], { type: 'image/png' }), 'big.png');
  form.append('thumb', new Blob([png(5, 10)], { type: 'image/png' }), 'thumb.png');
  const res = await fetch(`${srv.base}/api/photos/upload`, { method: 'POST', body: form, headers: { cookie: a.cookie } });
  const p2 = await res.json();
  assert.equal(res.status, 201);
  assert.notEqual(p2.thumb_url, p2.url);
  assert.equal(p2.taken_at, '2026-07-02T12:00:00.000Z');

  const p3 = (await up(member.agent, {}, png(10, 10))).body; // unsorted, uploaded by member
  assert.equal(p3.album_id, null);

  // album now has cover = newest by taken date, count 2
  let det = (await a.get(`/api/photos/albums/${album.id}`)).body;
  assert.equal(det.photo_count, 2);
  assert.equal(det.photos.length, 2);
  assert.equal(det.photos[0].id, p2.id); // newest first
  assert.equal(det.cover.id, p2.id);

  // set cover (must be in album)
  assert.equal((await a.patch(`/api/photos/albums/${album.id}`, { cover_photo_id: p3.id })).status, 400);
  assert.equal((await a.patch(`/api/photos/albums/${album.id}`, { cover_photo_id: p1.body.id })).body.cover.id, p1.body.id);

  // caption edit + validation
  const cap = await a.patch(`/api/photos/items/${p1.body.id}`, { caption: '  New caption ' });
  assert.equal(cap.body.caption, 'New caption');
  assert.equal((await a.patch(`/api/photos/items/${p1.body.id}`, {})).status, 400);
  assert.equal((await a.patch(`/api/photos/items/${p1.body.id}`, { album_id: 424242 })).status, 404);

  // moving the cover out of the album resets the cover
  const moved = await a.patch(`/api/photos/items/${p1.body.id}`, { album_id: null });
  assert.equal(moved.body.album_id, null);
  det = (await a.get(`/api/photos/albums/${album.id}`)).body;
  assert.equal(det.cover_photo_id, null);
  assert.equal(det.cover.id, p2.id);

  // bulk move back
  const bulk = await a.post('/api/photos/items/move', { ids: [p1.body.id, p3.id], album_id: album.id });
  assert.equal(bulk.status, 200);
  assert.equal((await a.get(`/api/photos/albums/${album.id}`)).body.photo_count, 3);
  assert.equal((await a.post('/api/photos/items/move', { ids: [], album_id: album.id })).status, 400);
  assert.equal((await a.post('/api/photos/items/move', { ids: [p1.body.id] })).status, 400);

  // overview + timeline with pagination and month groups
  const ov = (await a.get('/api/photos')).body;
  assert.equal(ov.total, 3);
  assert.equal(ov.unsorted, 0);
  assert.equal(ov.albums, 1);
  const page1 = (await a.get('/api/photos/all?limit=2')).body;
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 3);
  assert.ok(page1.next_cursor);
  assert.ok(page1.months.length >= 2);
  const page2 = (await a.get(`/api/photos/all?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`)).body;
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null);
  const ids = [...page1.items, ...page2.items].map((p) => p.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await a.get('/api/photos/all?cursor=garbage')).status, 400);
  assert.equal((await a.get(`/api/photos/all?member=${member.user.id}`)).body.total, 1);

  // download has attachment disposition
  const dl = await fetch(`${srv.base}/api/photos/items/${p1.body.id}/download`, { headers: { cookie: a.cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="New-caption\.png"/);

  // delete removes the file
  const diskPath = path.join(srv.dir, 'uploads', p1.body.url.replace('/uploads/', ''));
  assert.ok(fs.existsSync(diskPath));
  assert.equal((await a.del(`/api/photos/items/${p1.body.id}`)).status, 200);
  assert.equal((await a.get(`/api/photos/items/${p1.body.id}`)).status, 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(diskPath));

  // delete album keeping photos → they become unsorted
  const keep = await a.del(`/api/photos/albums/${album.id}`, { body: { keep_photos: true } });
  assert.equal(keep.body.deleted_photos, 0);
  assert.equal((await a.get('/api/photos')).body.unsorted, 2);

  // delete album with photos
  const album2 = (await a.post('/api/photos/albums', { title: 'Gone' })).body;
  await up(a, { album_id: album2.id });
  const gone = await a.del(`/api/photos/albums/${album2.id}`, { body: { keep_photos: false } });
  assert.equal(gone.body.deleted_photos, 1);
  assert.equal((await a.get('/api/photos')).body.total, 2);

  // bulk delete
  const all = (await a.get('/api/photos/all')).body.items.map((p) => p.id);
  assert.equal((await a.post('/api/photos/items/delete', { ids: all })).status, 200);
  assert.equal((await a.get('/api/photos')).body.total, 0);
});

test('likes, comments, mentions and notifications', async () => {
  const fx = await familyFixture(srv, 'Social');
  const { admin, member } = fx;
  const photo = (await up(member.agent, { caption: 'Sunset' })).body;

  const like = await admin.agent.post(`/api/photos/items/${photo.id}/like`);
  assert.deepEqual(like.body, { liked: true, like_count: 1 });
  assert.equal((await admin.agent.post(`/api/photos/items/${photo.id}/like`)).body.like_count, 1); // idempotent
  let detail = (await member.agent.get(`/api/photos/items/${photo.id}`)).body;
  assert.equal(detail.like_count, 1);
  assert.equal(detail.liked, false);
  assert.equal(detail.likers[0].id, admin.user.id);
  assert.equal((await admin.agent.get(`/api/photos/items/${photo.id}`)).body.liked, true);

  let notes = (await member.agent.get('/api/notifications')).body.items;
  assert.ok(notes.some((n) => n.title === 'Admin liked your photo' && n.link === `/photos/all?photo=${photo.id}`));

  assert.equal((await admin.agent.del(`/api/photos/items/${photo.id}/like`)).body.like_count, 0);

  assert.equal((await admin.agent.post(`/api/photos/items/${photo.id}/comments`, { body: '  ' })).status, 400);
  assert.equal((await admin.agent.post(`/api/photos/items/${photo.id}/comments`, { body: 'x'.repeat(1001) })).status, 400);
  const c1 = await admin.agent.post(`/api/photos/items/${photo.id}/comments`, { body: 'Gorgeous!' });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.user.id, admin.user.id);
  notes = (await member.agent.get('/api/notifications')).body.items;
  assert.ok(notes.some((n) => n.title === 'Admin commented on your photo' && n.body === 'Gorgeous!'));

  // member replies with an @mention — admin gets "mentioned you" (once)
  await member.agent.post(`/api/photos/items/${photo.id}/comments`, { body: 'Thanks @admin!' });
  const adminNotes = (await admin.agent.get('/api/notifications')).body.items.filter((n) => n.module === 'photos');
  assert.equal(adminNotes.filter((n) => n.title === 'Member mentioned you on a photo').length, 1);

  detail = (await admin.agent.get(`/api/photos/items/${photo.id}`)).body;
  assert.equal(detail.comments.length, 2);
  assert.equal(detail.comment_count, 2);
  const memberComment = detail.comments[1];
  assert.equal(memberComment.can_delete, true); // admin may moderate

  // member cannot delete admin's comment; admin can delete member's
  assert.equal((await member.agent.del(`/api/photos/items/${photo.id}/comments/${c1.body.id}`)).status, 403);
  assert.equal((await admin.agent.del(`/api/photos/items/${photo.id}/comments/${memberComment.id}`)).status, 200);
  assert.equal((await admin.agent.del(`/api/photos/items/${photo.id}/comments/${memberComment.id}`)).status, 404);
});

test('roles: children manage their own photos only', async () => {
  const fx = await familyFixture(srv, 'Roles');
  const kid = await addChild(fx);
  const adultPhoto = (await up(fx.member.agent)).body;
  const album = (await fx.member.agent.post('/api/photos/albums', { title: 'Grown-ups' })).body;

  // child can upload, create albums, like and comment
  const kidPhoto = await up(kid.agent, { album_id: album.id });
  assert.equal(kidPhoto.status, 201);
  const kidAlbum = await kid.agent.post('/api/photos/albums', { title: 'My stuff' });
  assert.equal(kidAlbum.status, 201);
  assert.equal((await kid.agent.post(`/api/photos/items/${adultPhoto.id}/like`)).status, 200);

  // …but cannot edit/delete others' photos or albums
  const seen = (await kid.agent.get(`/api/photos/items/${adultPhoto.id}`)).body;
  assert.equal(seen.can_edit, false);
  assert.equal(seen.can_delete, false);
  assert.equal((await kid.agent.patch(`/api/photos/items/${adultPhoto.id}`, { caption: 'lol' })).status, 403);
  assert.equal((await kid.agent.del(`/api/photos/items/${adultPhoto.id}`)).status, 403);
  assert.equal((await kid.agent.post('/api/photos/items/delete', { ids: [adultPhoto.id] })).status, 403);
  assert.equal((await kid.agent.post('/api/photos/items/move', { ids: [adultPhoto.id], album_id: null })).status, 403);
  assert.equal((await kid.agent.patch(`/api/photos/albums/${album.id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await kid.agent.del(`/api/photos/albums/${album.id}`)).status, 403);
  // own stuff is fine
  assert.equal((await kid.agent.patch(`/api/photos/items/${kidPhoto.body.id}`, { caption: 'Me!' })).status, 200);
  assert.equal((await kid.agent.del(`/api/photos/albums/${kidAlbum.body.id}`)).status, 200);

  // a member can caption others' photos but not delete them; admin can delete anything
  assert.equal((await fx.member.agent.patch(`/api/photos/items/${kidPhoto.body.id}`, { caption: 'Cute' })).status, 200);
  assert.equal((await fx.member.agent.del(`/api/photos/items/${kidPhoto.body.id}`)).status, 403);
  assert.equal((await fx.admin.agent.del(`/api/photos/items/${kidPhoto.body.id}`)).status, 200);
  // a member cannot delete an album someone else created; admin can
  const adminAlbum = (await fx.admin.agent.post('/api/photos/albums', { title: 'Admin album' })).body;
  assert.equal((await fx.member.agent.del(`/api/photos/albums/${adminAlbum.id}`)).status, 403);
  assert.equal((await fx.admin.agent.del(`/api/photos/albums/${album.id}`)).status, 200);
});

test('cross-family isolation', async () => {
  const a = await familyFixture(srv, 'Iso A');
  const b = await familyFixture(srv, 'Iso B');
  const album = (await a.admin.agent.post('/api/photos/albums', { title: 'Private' })).body;
  const photo = (await up(a.admin.agent, { album_id: album.id, caption: 'secret sunset' })).body;
  const B = b.admin.agent;

  assert.equal((await B.get(`/api/photos/albums/${album.id}`)).status, 404);
  assert.equal((await B.patch(`/api/photos/albums/${album.id}`, { title: 'x' })).status, 404);
  assert.equal((await B.del(`/api/photos/albums/${album.id}`)).status, 404);
  assert.equal((await B.get(`/api/photos/items/${photo.id}`)).status, 404);
  assert.equal((await B.patch(`/api/photos/items/${photo.id}`, { caption: 'x' })).status, 404);
  assert.equal((await B.del(`/api/photos/items/${photo.id}`)).status, 404);
  assert.equal((await B.post(`/api/photos/items/${photo.id}/like`)).status, 404);
  assert.equal((await B.post(`/api/photos/items/${photo.id}/comments`, { body: 'hi' })).status, 404);
  assert.equal((await B.get(`/api/photos/items/${photo.id}/download`)).status, 404);
  assert.equal((await B.post('/api/photos/items/move', { ids: [photo.id], album_id: null })).status, 404);
  assert.equal((await B.post('/api/photos/items/delete', { ids: [photo.id] })).status, 404);
  assert.equal((await B.get(`/api/photos/all?album=${album.id}`)).status, 404);
  assert.equal((await up(B, { album_id: album.id })).status, 404);
  const bAlbum = (await B.post('/api/photos/albums', { title: 'B' })).body;
  assert.equal((await a.admin.agent.post('/api/photos/items/move', { ids: [photo.id], album_id: bAlbum.id })).status, 404);
  assert.equal((await B.get(photo.url)).status, 404);
  assert.equal((await B.get('/api/photos')).body.total, 0);
  assert.equal((await B.get('/api/photos/albums')).body.length, 1);
  assert.equal((await B.get('/api/search?q=secret')).body.results.filter((r) => r.module === 'photos').length, 0);
  const found = (await a.admin.agent.get('/api/search?q=secret')).body.results.filter((r) => r.module === 'photos');
  assert.equal(found[0].link, `/photos/albums/${album.id}?photo=${photo.id}`);
  // outsider without family
  const loner = await registerUser(srv, { name: 'Loner' });
  assert.ok([403, 409, 400].includes((await loner.agent.get('/api/photos')).status));
});

test('realtime events and batched activity', async () => {
  const { admin, member } = await familyFixture(srv, 'Live');
  const album = (await admin.agent.post('/api/photos/albums', { title: 'Picnic' })).body;
  const stream = await collectEvents(member.agent, { until: (e) => e.type === 'photos.comment.added', timeoutMs: 5000 });
  const batch = 'batch-abc123';
  const p1 = (await up(admin.agent, { album_id: album.id, batch })).body;
  await up(admin.agent, { album_id: album.id, batch });
  await up(admin.agent, { album_id: album.id, batch });
  // no activity until the batch is done
  let act = (await admin.agent.get('/api/activity?module=photos')).body;
  assert.ok(!act.some((e) => e.verb === 'uploaded'));
  const done = await admin.agent.post(`/api/photos/batches/${batch}/done`);
  assert.equal(done.body.count, 3);
  assert.equal((await admin.agent.post(`/api/photos/batches/${batch}/done`)).body.count, 0); // only once
  assert.equal((await admin.agent.post('/api/photos/batches/!!/done')).status, 400);
  act = (await admin.agent.get('/api/activity?module=photos')).body;
  assert.ok(act.some((e) => e.summary === 'added 3 photos to Picnic' && e.link === `/photos/albums/${album.id}`));
  const notes = (await member.agent.get('/api/notifications')).body.items;
  assert.ok(notes.some((n) => n.title === 'New photos in Picnic' && n.body === 'Admin added 3 photos to Picnic'));

  await admin.agent.patch(`/api/photos/items/${p1.id}`, { caption: 'yum' });
  await admin.agent.post(`/api/photos/items/${p1.id}/like`);
  await admin.agent.patch(`/api/photos/albums/${album.id}`, { title: 'Picnic 2' });
  await admin.agent.post(`/api/photos/items/${p1.id}/comments`, { body: 'nice' });
  const types = (await stream.events).map((e) => e.type);
  for (const t of ['photos.photo.added', 'photos.photo.updated', 'photos.photo.liked', 'photos.album.updated', 'photos.comment.added']) {
    assert.ok(types.includes(t), `missing ${t} in ${types.join(',')}`);
  }
  // single (non-batched) upload is announced immediately
  await up(member.agent, {});
  act = (await admin.agent.get('/api/activity?module=photos')).body;
  assert.ok(act.some((e) => e.summary === 'added a photo'));
});

test('seed creates rich demo albums; search + dashboard work', async () => {
  const { familyId, users } = await seedDemo(srv.ctx, srv.app.locals.modules, { log: () => {} });
  const agent = srv.agent();
  await agent.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
  agent.familyId = familyId;
  const albums = (await agent.get('/api/photos/albums')).body;
  assert.ok(albums.length >= 3);
  assert.ok(albums.every((a) => a.photo_count > 0 && a.cover));
  const ov = (await agent.get('/api/photos')).body;
  assert.ok(ov.total >= 25);
  assert.ok(ov.unsorted >= 1);
  const img = await agent.get(albums[0].cover.thumb_url);
  assert.equal(img.status, 200);
  const hike = albums.find((a) => a.title.includes('Hike'));
  const det = (await agent.get(`/api/photos/albums/${hike.id}`)).body;
  assert.ok(det.photos.some((p) => p.comment_count > 0 && p.like_count > 0));
  assert.ok(det.contributor_ids.includes(users.mia.id));
  const act = (await agent.get('/api/activity?module=photos')).body;
  assert.ok(act.some((e) => /added \d+ photos to/.test(e.summary)));
  const s = (await agent.get('/api/search?q=beach')).body.results.filter((r) => r.module === 'photos');
  assert.ok(s.length >= 1);
  const dash = (await agent.get('/api/dashboard')).body.photos;
  assert.equal(dash.recent.length, 6);
  assert.ok(dash.total >= 25);
});


const rawUpload = async (agent, parts, headers = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    if (v && typeof v === 'object' && 'buf' in v) form.append(k, new Blob([v.buf], { type: v.type }), v.name);
    else form.append(k, String(v));
  }
  const res = await fetch(`${srv.base}/api/photos/upload`, { method: 'POST', body: form, headers: { cookie: agent.cookie, ...headers } });
  return { status: res.status, body: await res.json() };
};

test('uploads: bytes are verified, never the client type, name or dimensions', async () => {
  const { admin } = await familyFixture(srv, 'Security');
  const a = admin.agent;
  const html = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
  const good = png(30, 20);
  const corrupt = good.subarray(0, 40); // valid signature + IHDR, then truncated
  const huge = Buffer.from(good);
  huge.writeUInt32BE(40000, 16);
  const zero = Buffer.from(good);
  zero.writeUInt32BE(0, 16);

  for (const [buf, type, name] of [[html, 'image/png', 'evil.png'], [svg, 'image/jpeg', 'evil.jpg'], [corrupt, 'image/png', 'broken.png'], [huge, 'image/png', 'huge.png'], [zero, 'image/png', 'zero.png'], [Buffer.from('hello'), 'text/plain', 'notes.txt']]) {
    const r = await rawUpload(a, { file: { buf, type, name } });
    assert.equal(r.status, 400, `${name} should be rejected`);
    assert.ok(r.body.error.includes(name) || /damaged|not a supported/.test(r.body.error), r.body.error);
  }
  // an HTML "thumbnail" sinks the whole upload
  assert.equal((await rawUpload(a, { file: { buf: good, type: 'image/png', name: 'ok.png' }, thumb: { buf: html, type: 'image/png', name: 't.png' } })).status, 400);
  // nothing was stored
  assert.equal((await a.get('/api/photos')).body.total, 0);
  const famDir = path.join(srv.dir, 'uploads', String((await a.get('/api/family')).body.id));
  // Rejected uploads are removed just after the response is sent (app.js cleanup), so give it a moment.
  const leftovers = () => (fs.existsSync(famDir) ? fs.readdirSync(famDir).length : 0);
  for (let i = 0; i < 50 && leftovers(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(leftovers(), 0);

  // a real PNG sent as "image/jpeg" named .jpg is stored as .png with its true size; client dims ignored
  const ok = await rawUpload(a, { file: { buf: good, type: 'image/jpeg', name: 'photo.jpg' }, width: 9999, height: 1 });
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /\.png$/);
  assert.equal(ok.body.mime, 'image/png');
  assert.equal(ok.body.width, 30);
  assert.equal(ok.body.height, 20);
  assert.ok(isIntactImage(good, 'image/png'));
  assert.ok(!isIntactImage(corrupt, 'image/png'));
});

test('deleting an album never wipes photos other people added', async () => {
  const fx = await familyFixture(srv, 'AlbumDelete');
  const kid = await addChild(fx);
  const album = (await kid.agent.post('/api/photos/albums', { title: 'Kid album' })).body;
  const adminPhoto = (await up(fx.admin.agent, { album_id: album.id })).body;
  const kidPhoto = (await up(kid.agent, { album_id: album.id })).body;
  const res = await kid.agent.del(`/api/photos/albums/${album.id}`, { body: { keep_photos: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted_photos, 1);
  assert.equal(res.body.kept_photos, 1);
  assert.equal((await fx.admin.agent.get(`/api/photos/items/${adminPhoto.id}`)).body.album_id, null);
  assert.equal((await fx.admin.agent.get(`/api/photos/items/${kidPhoto.id}`)).status, 404);

  // missing keep_photos → photos are kept
  const album2 = (await fx.member.agent.post('/api/photos/albums', { title: 'Member album' })).body;
  const p2 = (await up(fx.member.agent, { album_id: album2.id })).body;
  const r2 = await fx.member.agent.del(`/api/photos/albums/${album2.id}`);
  assert.equal(r2.body.deleted_photos, 0);
  assert.equal((await fx.member.agent.get(`/api/photos/items/${p2.id}`)).status, 200);

  // admins may delete everything in the album
  const album3 = (await fx.member.agent.post('/api/photos/albums', { title: 'Mixed' })).body;
  await up(fx.member.agent, { album_id: album3.id });
  await up(kid.agent, { album_id: album3.id });
  const r3 = await fx.admin.agent.del(`/api/photos/albums/${album3.id}`, { body: { keep_photos: false } });
  assert.equal(r3.body.deleted_photos, 2);
  assert.equal(r3.body.kept_photos, 0);
});

test('deleting a photo removes its Wall entry and notifications', async () => {
  const { admin, member } = await familyFixture(srv, 'Cleanup');
  const photo = (await up(member.agent, { caption: 'temp' })).body; // single upload → "added a photo" linking to it
  await admin.agent.post(`/api/photos/items/${photo.id}/comments`, { body: 'nice' });
  const link = `/photos/all?photo=${photo.id}`;
  assert.ok((await admin.agent.get('/api/activity?module=photos')).body.some((e) => e.link === link));
  assert.ok((await member.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
  const stream = await collectEvents(admin.agent, { until: (e) => e.type === 'activity.removed', timeoutMs: 4000 });
  assert.equal((await member.agent.del(`/api/photos/items/${photo.id}`)).status, 200);
  const evts = await stream.events;
  assert.ok(evts.some((e) => e.type === 'activity.removed'), JSON.stringify(evts.map((e) => e.type)));
  assert.ok(!(await admin.agent.get('/api/activity?module=photos')).body.some((e) => e.link === link));
  assert.ok(!(await member.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
});

test('months are grouped by the local capture date', async () => {
  const { admin } = await familyFixture(srv, 'Months');
  const r = await rawUpload(admin.agent, { file: { buf: png(8, 8), type: 'image/png', name: 'late.png' }, taken_at: '2026-07-01T03:00:00.000Z' }, { 'x-timezone': 'America/Los_Angeles' });
  assert.equal(r.status, 201);
  assert.equal(r.body.taken_date, '2026-06-30');
  const page = (await admin.agent.get('/api/photos/all')).body;
  assert.deepEqual(page.months, [{ month: '2026-06', count: 1 }]);
});

test('unannounced upload batches are finalized when the module boots', async () => {
  const { admin } = await familyFixture(srv, 'Sweep');
  await up(admin.agent, { batch: 'lost-batch-1' });
  await up(admin.agent, { batch: 'lost-batch-1' });
  assert.ok(!(await admin.agent.get('/api/activity?module=photos')).body.some((e) => e.verb === 'uploaded'));
  photosRouter(srv.ctx); // simulates a restart
  assert.ok((await admin.agent.get('/api/activity?module=photos')).body.some((e) => e.summary === 'added 2 photos'));
});

/** A PNG whose header claims w×h and whose IDAT is a real zlib stream of zeros for that size (a decompression bomb). */
async function bombPng(w, h) {
  const zlib = await import('node:zlib');
  const { Readable } = await import('node:stream');
  const total = (w * 3 + 1) * h;
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let left = total;
  const src = Readable.from((function* gen() {
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      left -= n;
      yield chunk.subarray(0, n);
    }
  })());
  const parts = [];
  for await (const c of src.pipe(zlib.createDeflate({ level: 9 }))) parts.push(c);
  const idat = Buffer.concat(parts);
  const chunkOf = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunkOf('IHDR', ihdr), chunkOf('IDAT', idat), chunkOf('IEND', Buffer.alloc(0))]);
}

test('decompression bombs are rejected fast and without inflating', async () => {
  const { admin } = await familyFixture(srv, 'Bombs');
  const huge = await bombPng(30000, 30000); // over the pixel limit
  const big = await bombPng(8900, 8900); // 79 MP: passes the header check, ~237 MB if inflated
  for (const [buf, name] of [[huge, 'huge.png'], [big, 'big.png']]) {
    const rss = process.memoryUsage().rss;
    const t = performance.now();
    const r = await rawUpload(admin.agent, { file: { buf, type: 'image/png', name } });
    const ms = performance.now() - t;
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`);
    assert.ok(ms < 1000, `${name} took ${ms}ms`);
    assert.ok(process.memoryUsage().rss - rss < 150e6, `${name} grew memory`);
  }
  // the integrity check never inflates: bombs and a ~20 MB PNG are checked in well under 50 ms
  let t = performance.now();
  isIntactImage(huge, 'image/png');
  isIntactImage(big, 'image/png');
  assert.ok(performance.now() - t < 50, `bomb check took ${performance.now() - t}ms`);
  const noise = Buffer.alloc(2600 * 2600 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
  const noisy = encodePng(2600, 2600, noise);
  t = performance.now();
  assert.equal(isIntactImage(noisy, 'image/png'), true);
  assert.ok(performance.now() - t < 50, `check took ${performance.now() - t}ms for ${noisy.length} bytes`);
});

test('large photos need a thumbnail; thumbnails are size-capped', async () => {
  const { admin } = await familyFixture(srv, 'Thumbs');
  const big = png(3000, 40);
  const noThumb = await rawUpload(admin.agent, { file: { buf: big, type: 'image/png', name: 'wide.png' } });
  assert.equal(noThumb.status, 400);
  assert.match(noThumb.body.error, /preview image/);
  const hugeThumb = await rawUpload(admin.agent, { file: { buf: big, type: 'image/png', name: 'wide.png' }, thumb: { buf: png(1500, 20), type: 'image/png', name: 't.png' } });
  assert.equal(hugeThumb.status, 400);
  const ok = await rawUpload(admin.agent, { file: { buf: big, type: 'image/png', name: 'wide.png' }, thumb: { buf: png(600, 8), type: 'image/png', name: 't.png' } });
  assert.equal(ok.status, 201);
  assert.notEqual(ok.body.thumb_url, ok.body.url);
  assert.equal((await rawUpload(admin.agent, { file: { buf: png(800, 600), type: 'image/png', name: 's.png' } })).status, 201);
});

test('the Wall count of a multi-upload follows deletions', async () => {
  const { admin } = await familyFixture(srv, 'Recount');
  const album = (await admin.agent.post('/api/photos/albums', { title: 'Zoo' })).body;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await up(admin.agent, { album_id: album.id, batch: 'zoo-batch-1' })).body.id);
  await admin.agent.post('/api/photos/batches/zoo-batch-1/done');
  const entry = () => admin.agent.get('/api/activity?module=photos').then((r) => r.body.find((e) => e.verb === 'uploaded'));
  assert.equal((await entry()).summary, 'added 3 photos to Zoo');
  const stream = await collectEvents(admin.agent, { until: (e) => e.type === 'activity.updated', timeoutMs: 4000 });
  await admin.agent.del(`/api/photos/items/${ids[0]}`);
  const upd = (await stream.events).find((e) => e.type === 'activity.updated');
  assert.equal(upd.payload.summary, 'added 2 photos to Zoo');
  await admin.agent.post('/api/photos/items/delete', { ids: [ids[1]] });
  assert.equal((await entry()).summary, 'added a photo to Zoo');
  await admin.agent.del(`/api/photos/items/${ids[2]}`);
  assert.equal(await entry(), undefined);
});

test('timeline pages follow local dates; deep links load enough context', async () => {
  const { admin } = await familyFixture(srv, 'Paging');
  const tz = { 'x-timezone': 'Pacific/Auckland' };
  const a = (await rawUpload(admin.agent, { file: { buf: png(5, 5), type: 'image/png', name: 'a.png' }, taken_at: '2026-05-31T13:00:00.000Z' }, tz)).body; // Jun 1 local
  const b = (await rawUpload(admin.agent, { file: { buf: png(5, 5), type: 'image/png', name: 'b.png' }, taken_at: '2026-05-31T14:00:00.000Z' }, tz)).body;
  const c = (await rawUpload(admin.agent, { file: { buf: png(5, 5), type: 'image/png', name: 'c.png' }, taken_at: '2026-05-31T15:00:00.000Z' }, { 'x-timezone': 'America/New_York' })).body; // May 31 local, but latest instant
  assert.equal(a.taken_date, '2026-06-01');
  assert.equal(c.taken_date, '2026-05-31');
  const p1 = (await admin.agent.get('/api/photos/all?limit=1')).body;
  const p2 = (await admin.agent.get(`/api/photos/all?limit=1&cursor=${encodeURIComponent(p1.next_cursor)}`)).body;
  const p3 = (await admin.agent.get(`/api/photos/all?limit=1&cursor=${encodeURIComponent(p2.next_cursor)}`)).body;
  assert.deepEqual([p1, p2, p3].map((p) => p.items[0].id), [b.id, a.id, c.id]);
  assert.equal(p3.next_cursor, null);
  const deep = (await admin.agent.get(`/api/photos/all?limit=1&until=${c.id}`)).body;
  assert.ok(deep.items.some((p) => p.id === c.id));
  assert.equal(deep.total, 3);
});

test('rows without a local date are backfilled in the family zone', async () => {
  const { admin } = await familyFixture(srv, 'Backfill');
  await admin.agent.get('/api/auth/me', { headers: { 'x-timezone': 'Pacific/Auckland' } });
  const p = (await up(admin.agent, { taken_at: '2026-03-10T20:00:00.000Z' })).body;
  srv.db.prepare('UPDATE photos SET taken_date = NULL WHERE id = ?').run(p.id);
  photosRouter(srv.ctx); // boot
  assert.equal(srv.db.prepare('SELECT taken_date FROM photos WHERE id = ?').get(p.id).taken_date, '2026-03-11');
});
