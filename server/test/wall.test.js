import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';
import { DatabaseSync } from 'node:sqlite';
import { upgradeSchema } from '../src/modules/wall.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const fileOnDisk = (url) => path.join(srv.dir, 'uploads', url.slice('/uploads/'.length));

/** Multipart post with N photos. */
function uploadPost(agent, url, { body, mood, photos = 1, extra = {}, type = 'image/png', filename = 'p.png' } = {}) {
  const form = new FormData();
  if (body !== undefined) form.append('body', body);
  if (mood !== undefined) form.append('mood', mood);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  for (let i = 0; i < photos; i++) form.append('photos', new Blob([PNG_1X1], { type }), filename);
  return fetch(agent.base + url, {
    method: url.includes('/posts/') ? 'PATCH' : 'POST',
    headers: { cookie: agent.cookie, ...(agent.familyId ? { 'x-family-id': String(agent.familyId) } : {}) },
    body: form,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('create, read, edit and delete a text post', async () => {
  const { admin, member } = await familyFixture(srv, 'CRUD');
  const created = await member.agent.post('/api/wall/posts', { body: '  Hello family!  ', mood: 'happy' });
  assert.equal(created.status, 201);
  assert.equal(created.body.body, 'Hello family!');
  assert.equal(created.body.mood, 'happy');
  assert.equal(created.body.author.id, member.user.id);
  assert.deepEqual(created.body.photos, []);
  assert.equal(created.body.pinned, false);
  assert.equal(created.body.edited_at, null);

  const got = await admin.agent.get(`/api/wall/posts/${created.body.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.body, 'Hello family!');

  // Only the author may edit (even admins can't rewrite someone else's words).
  assert.equal((await admin.agent.patch(`/api/wall/posts/${created.body.id}`, { body: 'hacked' })).status, 403);
  const edited = await member.agent.patch(`/api/wall/posts/${created.body.id}`, { body: 'Hello everyone!', mood: null });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.body, 'Hello everyone!');
  assert.equal(edited.body.mood, null);
  assert.ok(edited.body.edited_at);

  const del = await member.agent.del(`/api/wall/posts/${created.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await member.agent.get(`/api/wall/posts/${created.body.id}`)).status, 404);
});

test('validation: empty post, too long, unknown mood, bad ids', async () => {
  const { admin } = await familyFixture(srv, 'Validation');
  assert.equal((await admin.agent.post('/api/wall/posts', { body: '   ' })).status, 400);
  assert.equal((await admin.agent.post('/api/wall/posts', {})).status, 400);
  assert.equal((await admin.agent.post('/api/wall/posts', { body: 42 })).status, 400);
  assert.equal((await admin.agent.post('/api/wall/posts', { body: 'x'.repeat(5001) })).status, 400);
  const badMood = await admin.agent.post('/api/wall/posts', { body: 'hi', mood: 'furious' });
  assert.equal(badMood.status, 400);
  assert.match(badMood.body.error, /mood/i);
  assert.equal((await admin.agent.get('/api/wall/posts/abc')).status, 400);
  assert.equal((await admin.agent.get('/api/wall/posts/999999')).status, 404);
  const p = (await admin.agent.post('/api/wall/posts', { body: 'ok' })).body;
  assert.equal((await admin.agent.patch(`/api/wall/posts/${p.id}`, { body: '' })).status, 400, 'cannot empty a text-only post');
  assert.equal((await admin.agent.put(`/api/wall/posts/${p.id}/reaction`, { emoji: '💩' })).status, 400);
  assert.equal((await admin.agent.put(`/api/wall/posts/${p.id}/pin`, { pinned: 'yes' })).status, 400);
  assert.equal((await admin.agent.post(`/api/wall/posts/${p.id}/comments`, { body: '' })).status, 400);
  assert.equal((await admin.agent.post(`/api/wall/posts/${p.id}/comments`, { body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await admin.agent.post(`/api/wall/posts/${p.id}/comments`, { body: 'hi', parent_id: 999999 })).status, 400);
  assert.equal((await admin.agent.get('/api/wall/feed?before=garbage')).status, 400);
});

test('photos: upload up to 10, reject non-images and 11+, edit add/remove, files cleaned up', async () => {
  const { admin } = await familyFixture(srv, 'Photos');
  const post = await uploadPost(admin.agent, '/api/wall/posts', { body: 'Beach day', photos: 3 });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal(post.body.photos.length, 3);
  for (const p of post.body.photos) {
    assert.match(p.url, /^\/uploads\/\d+\/[a-f0-9]+\.png$/);
    assert.ok(fs.existsSync(fileOnDisk(p.url)));
  }
  // photo-only post is fine
  const photoOnly = await uploadPost(admin.agent, '/api/wall/posts', { photos: 1 });
  assert.equal(photoOnly.status, 201);
  assert.equal(photoOnly.body.body, '');

  const tooMany = await uploadPost(admin.agent, '/api/wall/posts', { body: 'many', photos: 11 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /up to 10/);
  const notImage = await uploadPost(admin.agent, '/api/wall/posts', { body: 'doc', type: 'application/pdf', filename: 'x.pdf' });
  assert.equal(notImage.status, 400);

  // edit: remove one photo, add two
  const [first, ...rest] = post.body.photos;
  const edited = await uploadPost(admin.agent, `/api/wall/posts/${post.body.id}`, { photos: 2, extra: { remove_photo_ids: JSON.stringify([first.id]) } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.photos.length, 4);
  assert.deepEqual(edited.body.photos.slice(0, 2).map((p) => p.id), rest.map((p) => p.id));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(fileOnDisk(first.url)), false, 'removed photo file deleted');

  // exceeding 10 in total via edit is rejected
  const over = await uploadPost(admin.agent, `/api/wall/posts/${post.body.id}`, { photos: 7 });
  assert.equal(over.status, 400);
  // removing a photo from another post is rejected
  const foreign = await admin.agent.patch(`/api/wall/posts/${post.body.id}`, { remove_photo_ids: [photoOnly.body.photos[0].id] });
  assert.equal(foreign.status, 400);

  // delete post removes its files
  const urls = edited.body.photos.map((p) => p.url);
  assert.equal((await admin.agent.del(`/api/wall/posts/${post.body.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  for (const u of urls) assert.equal(fs.existsSync(fileOnDisk(u)), false);
});

test('family isolation: other families get 404 everywhere and never see posts in the feed', async () => {
  const a = await familyFixture(srv, 'Iso A');
  const b = await familyFixture(srv, 'Iso B');
  const post = (await a.admin.agent.post('/api/wall/posts', { body: 'Private to A' })).body;
  const comment = (await a.member.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'A only' })).body;
  const bx = b.admin.agent;
  assert.equal((await bx.get(`/api/wall/posts/${post.id}`)).status, 404);
  assert.equal((await bx.patch(`/api/wall/posts/${post.id}`, { body: 'x' })).status, 404);
  assert.equal((await bx.del(`/api/wall/posts/${post.id}`)).status, 404);
  assert.equal((await bx.put(`/api/wall/posts/${post.id}/pin`, { pinned: true })).status, 404);
  assert.equal((await bx.put(`/api/wall/posts/${post.id}/reaction`, { emoji: '❤️' })).status, 404);
  assert.equal((await bx.del(`/api/wall/posts/${post.id}/reaction`)).status, 404);
  assert.equal((await bx.post(`/api/wall/posts/${post.id}/comments`, { body: 'x' })).status, 404);
  assert.equal((await bx.patch(`/api/wall/comments/${comment.id}`, { body: 'x' })).status, 404);
  assert.equal((await bx.del(`/api/wall/comments/${comment.id}`)).status, 404);
  const feedB = (await bx.get('/api/wall/feed')).body;
  assert.ok(!feedB.items.some((i) => i.type === 'post' && i.post.id === post.id));
  assert.ok(!feedB.items.some((i) => i.type === 'activity' && i.activity.family_id !== b.family.id));
  // search is scoped too
  const s = (await bx.get('/api/search?q=Private')).body;
  assert.ok(!s.results.some((r) => r.module === 'wall'));
  const sa = (await a.member.agent.get('/api/search?q=Private')).body;
  assert.ok(sa.results.some((r) => r.module === 'wall' && r.link === `/home/post/${post.id}`));
  // a user without a family gets no access at all
  const loner = await registerUser(srv, { name: 'Loner' });
  assert.notEqual((await loner.agent.get(`/api/wall/posts/${post.id}`)).status, 200);
});

test('a user in two families is scoped per tab (X-Family-Id)', async () => {
  const a = await familyFixture(srv, 'Tab A');
  const b = await familyFixture(srv, 'Tab B');
  // a.admin joins B too
  await a.admin.agent.post('/api/families/join', { invite_code: b.family.invite_code });
  const tabA = a.admin.agent.tab();
  tabA.familyId = a.family.id;
  const tabB = a.admin.agent.tab();
  tabB.familyId = b.family.id;
  const inA = (await tabA.post('/api/wall/posts', { body: 'In A' })).body;
  assert.equal(inA.family_id, a.family.id);
  assert.equal((await tabB.get(`/api/wall/posts/${inA.id}`)).status, 404);
  const feedB = (await tabB.get('/api/wall/feed?filter=posts')).body;
  assert.ok(!feedB.items.some((i) => i.post.id === inA.id));
});

test('permissions: admin can delete any post, members only their own; children cannot pin', async () => {
  const { admin, member, family } = await familyFixture(srv, 'Perms');
  const kid = await admin.agent.post('/api/family/members', { name: 'Kiddo', role: 'child', email: `kid${Date.now()}@example.test`, password: 'secret123' });
  assert.equal(kid.status, 201, JSON.stringify(kid.body));
  const kidAgent = srv.agent();
  const kidEmail = kid.body.email ?? kid.body.member?.email ?? kid.body.user?.email;
  assert.equal((await kidAgent.post('/api/auth/login', { email: kidEmail, password: 'secret123' })).status, 200);
  kidAgent.familyId = family.id;

  const byAdmin = (await admin.agent.post('/api/wall/posts', { body: 'Admin post' })).body;
  const byMember = (await member.agent.post('/api/wall/posts', { body: 'Member post' })).body;
  const byKid = (await kidAgent.post('/api/wall/posts', { body: 'Kid post' })).body;

  assert.equal((await member.agent.del(`/api/wall/posts/${byAdmin.id}`)).status, 403);
  assert.equal((await kidAgent.del(`/api/wall/posts/${byMember.id}`)).status, 403);
  assert.equal((await kidAgent.put(`/api/wall/posts/${byKid.id}/pin`, { pinned: true })).status, 403);
  assert.equal((await kidAgent.del(`/api/wall/posts/${byKid.id}`)).status, 200);
  assert.equal((await admin.agent.del(`/api/wall/posts/${byMember.id}`)).status, 200, 'admin moderates');

  // members can pin; pinned posts come first and are not duplicated in the stream
  const pin = await member.agent.put(`/api/wall/posts/${byAdmin.id}/pin`, { pinned: true });
  assert.equal(pin.status, 200);
  assert.equal(pin.body.pinned, true);
  assert.equal(pin.body.pinned_by, member.user.id);
  const feed = (await admin.agent.get('/api/wall/feed')).body;
  assert.deepEqual(feed.pinned.map((p) => p.id), [byAdmin.id]);
  assert.ok(!feed.items.some((i) => i.type === 'post' && i.post.id === byAdmin.id));
  const unpin = await admin.agent.put(`/api/wall/posts/${byAdmin.id}/pin`, { pinned: false });
  assert.equal(unpin.body.pinned, false);
  const feed2 = (await admin.agent.get('/api/wall/feed')).body;
  assert.equal(feed2.pinned.length, 0);
  assert.ok(feed2.items.some((i) => i.type === 'post' && i.post.id === byAdmin.id));
});

test('reactions: one per member, change, remove, notify the author once', async () => {
  const { admin, member } = await familyFixture(srv, 'Reactions');
  const post = (await admin.agent.post('/api/wall/posts', { body: 'React to me' })).body;
  const before = (await admin.agent.get('/api/notifications')).body.items.length;
  const r1 = await member.agent.put(`/api/wall/posts/${post.id}/reaction`, { emoji: '❤️' });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.reactions.map((r) => [r.emoji, r.user_id]), [['❤️', member.user.id]]);
  const r2 = await member.agent.put(`/api/wall/posts/${post.id}/reaction`, { emoji: '😂' });
  assert.deepEqual(r2.body.reactions.map((r) => [r.emoji, r.user_id]), [['😂', member.user.id]]);
  await admin.agent.put(`/api/wall/posts/${post.id}/reaction`, { emoji: '🎉' });
  const notes = (await admin.agent.get('/api/notifications')).body.items;
  const reactNotes = notes.slice(0, notes.length - before).filter((n) => /reacted/.test(n.title));
  assert.equal(reactNotes.length, 1, 'changing a reaction or reacting to your own post does not re-notify');
  assert.equal(reactNotes[0].link, `/home/post/${post.id}`);
  const del = await member.agent.del(`/api/wall/posts/${post.id}/reaction`);
  assert.deepEqual(del.body.reactions.map((r) => r.user_id), [admin.user.id]);
});

test('threaded comments: replies, flattening, edit/delete rules, notifications', async () => {
  const { admin, member } = await familyFixture(srv, 'Comments');
  const post = (await admin.agent.post('/api/wall/posts', { body: 'Dinner ideas?' })).body;
  const c1 = await member.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'Tacos!' });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.author.id, member.user.id);
  assert.equal(c1.body.parent_id, null);
  const reply = await admin.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'Yes!', parent_id: c1.body.id });
  assert.equal(reply.body.parent_id, c1.body.id);
  const nested = await member.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'With guac', parent_id: reply.body.id });
  assert.equal(nested.body.parent_id, c1.body.id, 'replies to replies attach to the top-level comment');

  // notifications: admin (post author) got "commented", member got "replied"
  const adminNotes = (await admin.agent.get('/api/notifications')).body.items;
  assert.ok(adminNotes.some((n) => n.title === 'Member commented on your post' && n.link === `/home/post/${post.id}`));
  const memberNotes = (await member.agent.get('/api/notifications')).body.items;
  assert.ok(memberNotes.some((n) => n.title === 'Admin replied to your comment'));

  // edit: only the author
  assert.equal((await admin.agent.patch(`/api/wall/comments/${c1.body.id}`, { body: 'nope' })).status, 403);
  const ed = await member.agent.patch(`/api/wall/comments/${c1.body.id}`, { body: 'Fish tacos!' });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.body, 'Fish tacos!');
  assert.ok(ed.body.edited_at);

  // a member can't delete someone else's comment on someone else's post
  const other = (await member.agent.post('/api/wall/posts', { body: 'Member post' })).body;
  const adminComment = (await admin.agent.post(`/api/wall/posts/${other.id}/comments`, { body: 'nice' })).body;
  const member2 = await registerUser(srv, { name: 'Third' });
  await member2.agent.post('/api/families/join', { invite_code: (await admin.agent.get('/api/family')).body.invite_code });
  assert.equal((await member2.agent.del(`/api/wall/comments/${adminComment.id}`)).status, 403);
  // ...but the post author can moderate comments on their own post
  assert.equal((await member.agent.del(`/api/wall/comments/${adminComment.id}`)).status, 200);

  // deleting a top-level comment removes its replies
  assert.equal((await admin.agent.del(`/api/wall/comments/${c1.body.id}`)).status, 200, 'admin can delete any comment');
  const after = (await admin.agent.get(`/api/wall/posts/${post.id}`)).body;
  assert.equal(after.comment_count, 0);
});

test('mentions notify the mentioned member; plain posts do not notify everyone', async () => {
  const { admin, member } = await familyFixture(srv, 'Mentions');
  const post = (await admin.agent.post('/api/wall/posts', { body: 'Thanks @member for dinner!' })).body;
  const notes = (await member.agent.get('/api/notifications')).body.items;
  assert.ok(notes.some((n) => n.title === 'Admin mentioned you in a post' && n.link === `/home/post/${post.id}`));
  assert.ok(!notes.some((n) => n.title === 'Admin posted on the wall' && n.link === `/home/post/${post.id}`), 'no duplicate generic notification');
  const own = (await admin.agent.get('/api/notifications')).body.items;
  assert.ok(!own.some((n) => n.link === `/home/post/${post.id}`));
  const plain = (await member.agent.post('/api/wall/posts', { body: 'Just saying hi' })).body;
  const adminNotes = (await admin.agent.get('/api/notifications')).body.items;
  assert.ok(!adminNotes.some((n) => n.link === `/home/post/${plain.id}`), 'no notification spam for ordinary posts');
});

test('feed merges posts with other modules\' activity, paginates without gaps or duplicates, and filters', async () => {
  const { admin, member, family } = await familyFixture(srv, 'Feed');
  const fid = family.id;
  // interleave posts and activity entries from other modules at known times
  const base = Date.parse('2026-01-10T12:00:00.000Z');
  for (let i = 0; i < 12; i++) {
    const at = new Date(base + i * 60_000).toISOString();
    if (i % 3 === 0) {
      srv.ctx.logActivity({ familyId: fid, userId: member.user.id, module: 'lists', verb: 'added', summary: `added item ${i}`, link: '/lists/1', createdAt: at });
    } else {
      const p = (await admin.agent.post('/api/wall/posts', { body: `Post ${i}` })).body;
      srv.db.prepare('UPDATE wall_posts SET created_at = ? WHERE id = ?').run(at, p.id);
    }
  }
  // an identical timestamp across both sources must not break pagination
  const tie = new Date(base + 5 * 60_000).toISOString();
  srv.ctx.logActivity({ familyId: fid, userId: admin.user.id, module: 'calendar', verb: 'created', summary: 'created an event', link: '/calendar', createdAt: tie });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await admin.agent.get(`/api/wall/feed?limit=4${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(res.status, 200);
    seen.push(...res.body.items);
    cursor = res.body.next_cursor;
    pages++;
  } while (cursor && pages < 20);
  const keys = seen.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  // wall's own activity rows are hidden (the post itself is shown instead); family join entries are included
  assert.ok(!seen.some((i) => i.type === 'activity' && i.activity.module === 'wall'));
  const postsSeen = seen.filter((i) => i.type === 'post');
  assert.equal(postsSeen.length, 8);
  assert.equal(seen.filter((i) => i.type === 'activity' && ['lists', 'calendar'].includes(i.activity.module)).length, 5);
  // sorted newest first
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].created_at >= seen[i].created_at);
  // activity entries are hydrated with the actor
  const act = seen.find((i) => i.type === 'activity' && i.activity.module === 'lists');
  assert.equal(act.activity.user.id, member.user.id);

  const onlyActivity = (await admin.agent.get('/api/wall/feed?filter=activity&limit=50')).body;
  assert.ok(onlyActivity.items.every((i) => i.type === 'activity'));
  assert.equal(onlyActivity.pinned, undefined);
  const onlyPosts = (await admin.agent.get('/api/wall/feed?filter=posts&limit=50')).body;
  assert.ok(onlyPosts.items.every((i) => i.type === 'post'));
  assert.equal(onlyPosts.items.length, 8);
  await uploadPost(admin.agent, '/api/wall/posts', { body: 'with photo', photos: 1 });
  const onlyPhotos = (await admin.agent.get('/api/wall/feed?filter=photos')).body;
  assert.equal(onlyPhotos.items.length, 1);
  assert.equal(onlyPhotos.items[0].post.photos.length, 1);
});

test('creating a post logs wall activity; deleting it removes the entry', async () => {
  const { admin, family } = await familyFixture(srv, 'Activity');
  const post = (await admin.agent.post('/api/wall/posts', { body: 'Logged' })).body;
  const acts = (await admin.agent.get('/api/activity?module=wall')).body;
  assert.ok(acts.some((a) => a.entity_id === post.id && a.link === `/home/post/${post.id}` && a.summary === 'shared a post'));
  await admin.agent.del(`/api/wall/posts/${post.id}`);
  const acts2 = (await admin.agent.get('/api/activity?module=wall')).body;
  assert.ok(!acts2.some((a) => a.entity_id === post.id));
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE family_id = ? AND module = 'wall'").get(family.id).n, 0);
});

test('realtime: every mutation broadcasts a wall.* event to the family only', async () => {
  const a = await familyFixture(srv, 'Live A');
  const b = await familyFixture(srv, 'Live B');
  const types = ['wall.post.created', 'wall.reaction.updated', 'wall.comment.created', 'wall.comment.updated', 'wall.comment.deleted', 'wall.post.pinned', 'wall.post.updated', 'wall.post.deleted'];
  const listenA = await collectEvents(a.member.agent, { until: (e) => e.type === 'wall.post.deleted', timeoutMs: 4000 });
  const listenB = await collectEvents(b.admin.agent, { count: 1, timeoutMs: 1500 });
  const post = (await a.admin.agent.post('/api/wall/posts', { body: 'Live!' })).body;
  await a.admin.agent.put(`/api/wall/posts/${post.id}/reaction`, { emoji: '🎉' });
  const c = (await a.admin.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'first' })).body;
  await a.admin.agent.patch(`/api/wall/comments/${c.id}`, { body: 'first!' });
  await a.admin.agent.del(`/api/wall/comments/${c.id}`);
  await a.admin.agent.put(`/api/wall/posts/${post.id}/pin`, { pinned: true });
  await a.admin.agent.patch(`/api/wall/posts/${post.id}`, { body: 'Live (edited)' });
  await a.admin.agent.del(`/api/wall/posts/${post.id}`);
  const events = await listenA.events;
  const wallEvents = events.filter((e) => e.type.startsWith('wall.'));
  assert.deepEqual(wallEvents.map((e) => e.type), types);
  assert.equal(wallEvents[0].payload.body, 'Live!');
  assert.equal(wallEvents.at(-1).payload.id, post.id);
  const other = await listenB.events;
  assert.ok(!other.some((e) => e.type.startsWith('wall.')), 'other families hear nothing');
});

test('seed: rich Rivera wall with photos, reactions, threaded comments and a pinned post', async () => {
  const { familyId, users } = await seedDemo(srv.ctx, srv.app.locals.modules, { log: () => {} });
  const alex = srv.agent();
  await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
  alex.familyId = familyId;
  const feed = (await alex.get('/api/wall/feed?limit=50')).body;
  assert.equal(feed.pinned.length, 1);
  assert.equal(feed.pinned[0].author.id, users.alex.id);
  const posts = feed.items.filter((i) => i.type === 'post').map((i) => i.post);
  assert.ok(posts.length >= 7);
  const authors = new Set([...posts, ...feed.pinned].map((p) => p.author.id));
  assert.equal(authors.size, 4, 'every family member has posted');
  assert.ok(posts.some((p) => p.photos.length > 4), 'a post with many photos');
  assert.ok(posts.some((p) => p.comments.some((c) => c.parent_id)), 'threaded replies');
  assert.ok(posts.every((p) => p.reactions.length > 0));
  // photos are real files served to members only
  const url = posts.find((p) => p.photos.length).photos[0].url;
  const img = await fetch(alex.base + url, { headers: { cookie: alex.cookie } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /svg/);
  const outsider = await registerUser(srv, { name: 'Outsider' });
  const denied = await fetch(alex.base + url, { headers: { cookie: outsider.agent.cookie } });
  assert.equal(denied.status, 404);
  // re-seeding replaces rather than duplicates
  const again = await seedDemo(srv.ctx, srv.app.locals.modules, { log: () => {} });
  const n = srv.db.prepare('SELECT COUNT(*) AS n FROM wall_posts WHERE family_id = ?').get(again.familyId).n;
  assert.equal(n, posts.length + 1);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM wall_posts WHERE family_id = ?').get(familyId).n, familyId === again.familyId ? n : 0);
});

test('meta endpoint lists reactions and moods', async () => {
  const { admin } = await familyFixture(srv, 'Meta');
  const meta = (await admin.agent.get('/api/wall/meta')).body;
  assert.deepEqual(meta.reactions, ['❤️', '👍', '😂', '🎉', '😮']);
  assert.ok(meta.moods.happy);
  assert.equal(meta.max_photos, 10);
});

test('ids are never reused after a delete and the post\'s notifications are removed', async () => {
  const { admin, member } = await familyFixture(srv, 'Ids');
  const post = (await admin.agent.post('/api/wall/posts', { body: 'Hi @member' })).body;
  await member.agent.post(`/api/wall/posts/${post.id}/comments`, { body: 'hey' });
  const link = `/home/post/${post.id}`;
  assert.ok((await member.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
  assert.ok((await admin.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
  const listen = await collectEvents(member.agent, { until: (e) => e.type === 'notification.removed', timeoutMs: 3000 });
  await admin.agent.del(`/api/wall/posts/${post.id}`);
  const evts = await listen.events;
  const removedEvt = evts.find((e) => e.type === 'notification.removed');
  assert.ok(removedEvt && removedEvt.payload.ids.length >= 1, 'member is told which notifications vanished');
  assert.ok(!(await member.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
  assert.ok(!(await admin.agent.get('/api/notifications')).body.items.some((n) => n.link === link));
  const next = (await admin.agent.post('/api/wall/posts', { body: 'Another' })).body;
  assert.ok(next.id > post.id, 'AUTOINCREMENT: deleted ids are not handed out again');
});

test('search treats % and _ literally', async () => {
  const { admin } = await familyFixture(srv, 'Like');
  await admin.agent.post('/api/wall/posts', { body: 'Half price: 50% off pizza' });
  await admin.agent.post('/api/wall/posts', { body: 'Nothing to see' });
  const pct = (await admin.agent.get('/api/search?q=' + encodeURIComponent('0%'))).body.results.filter((r) => r.module === 'wall');
  assert.equal(pct.length, 1);
  const us = (await admin.agent.get('/api/search?q=' + encodeURIComponent('__'))).body.results.filter((r) => r.module === 'wall');
  assert.equal(us.length, 0);
});

test('photo dimensions are stored from photo_meta', async () => {
  const { admin } = await familyFixture(srv, 'Dims');
  const post = await uploadPost(admin.agent, '/api/wall/posts', { body: 'dims', photos: 2, extra: { photo_meta: JSON.stringify([{ width: 1600, height: 1200 }, { width: 'x' }]) } });
  assert.equal(post.status, 201);
  assert.deepEqual(post.body.photos.map((p) => [p.width, p.height]), [[1600, 1200], [null, null]]);
  const bad = await uploadPost(admin.agent, '/api/wall/posts', { body: 'dims', photos: 1, extra: { photo_meta: '{nope' } });
  assert.equal(bad.status, 400);
});

test('legacy wall tables without AUTOINCREMENT are upgraded in place', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE families (id INTEGER PRIMARY KEY); CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO families VALUES (1); INSERT INTO users VALUES (1);');
  db.exec(`CREATE TABLE wall_posts (id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE, user_id INTEGER, body TEXT NOT NULL DEFAULT '', mood TEXT, pinned_at TEXT, pinned_by INTEGER, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x', edited_at TEXT);
    CREATE TABLE wall_post_photos (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE, url TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE wall_comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE, parent_id INTEGER, user_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x', edited_at TEXT);
    INSERT INTO wall_posts (id, family_id, body) VALUES (7, 1, 'old');
    INSERT INTO wall_post_photos (post_id, url) VALUES (7, '/uploads/1/a.png');
    INSERT INTO wall_comments (post_id, body) VALUES (7, 'hi');`);
  assert.equal(upgradeSchema(db), true);
  assert.equal(upgradeSchema(db), false, 'idempotent');
  for (const t of ['wall_posts', 'wall_post_photos', 'wall_comments']) {
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t).sql, /AUTOINCREMENT/);
  }
  assert.equal(db.prepare('SELECT body FROM wall_posts WHERE id = 7').get().body, 'old');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wall_post_photos WHERE post_id = 7').get().n, 1);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('DELETE FROM wall_posts WHERE id = 7');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wall_comments').get().n, 0, 'cascade still works');
  db.close();
});
