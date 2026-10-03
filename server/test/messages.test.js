import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

/** Family with admin + member + a third member (Kid, role child) all with logins. */
async function trio(name = 'Fam') {
  const fx = await familyFixture(srv, name);
  const kid = await registerUser(srv, { name: 'Kid Person' });
  await kid.agent.post('/api/families/join', { invite_code: fx.family.invite_code });
  await fx.admin.agent.patch(`/api/family/members/${kid.user.id}`, { role: 'child' });
  return { ...fx, kid };
}

const familyConv = async (agent) => (await agent.get('/api/messages/conversations')).body.find((c) => c.kind === 'family');

describe('conversations', () => {
  test('the Family conversation is auto-created with every member', async () => {
    const { admin, member, kid } = await trio('Auto');
    const list = await admin.agent.get('/api/messages/conversations');
    assert.equal(list.status, 200);
    const fam = list.body.find((c) => c.kind === 'family');
    assert.ok(fam, 'family conversation exists');
    assert.equal(fam.title, 'Family');
    assert.deepEqual(fam.participants.map((p) => p.id).sort(), [admin.user.id, member.user.id, kid.user.id].sort());
    // Same conversation for everyone (one per family).
    const again = await familyConv(member.agent);
    assert.equal(again.id, fam.id);
    // Root route lists too.
    assert.equal((await kid.agent.get('/api/messages')).body.length, 1);
  });

  test('people who join later are added to the Family chat with nothing unread', async () => {
    const { admin, family } = await familyFixture(srv, 'Later');
    const fam = await familyConv(admin.agent);
    await admin.agent.post(`/api/messages/conversations/${fam.id}/messages`, { body: 'hello before you joined' });
    const late = await registerUser(srv, { name: 'Late Comer' });
    await late.agent.post('/api/families/join', { invite_code: family.invite_code });
    const seen = await familyConv(late.agent);
    assert.equal(seen.id, fam.id);
    assert.equal(seen.unread, 0);
    const history = await late.agent.get(`/api/messages/conversations/${fam.id}/messages`);
    assert.equal(history.body.messages.length, 1);
  });

  test('direct conversations are find-or-create and validated', async () => {
    const { admin, member } = await trio('Direct');
    const a = await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id });
    assert.equal(a.status, 201);
    assert.equal(a.body.kind, 'direct');
    assert.equal(a.body.title, 'Member');
    const b = await member.agent.post('/api/messages/conversations', { kind: 'direct', user_id: admin.user.id });
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id);
    assert.equal(b.body.title, 'Admin');

    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: admin.user.id })).status, 400);
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: 'x' })).status, 400);
    const outsider = await registerUser(srv, { name: 'Outsider', family_name: 'Elsewhere' });
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: outsider.user.id })).status, 404);
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'nope' })).status, 400);
  });

  test('managed members (no login) cannot be messaged directly', async () => {
    const { admin } = await familyFixture(srv, 'Managed');
    const baby = await admin.agent.post('/api/family/members', { name: 'Baby', role: 'child' });
    assert.equal(baby.status, 201);
    const babyId = baby.body.id ?? baby.body.member?.id ?? baby.body.user?.id;
    const res = await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: babyId });
    assert.equal(res.status, 400);
  });

  test('groups: create, rename, add, remove, leave, delete with role rules', async () => {
    const { admin, member, kid } = await trio('Groups');
    const bad = await admin.agent.post('/api/messages/conversations', { kind: 'group', name: '', member_ids: [member.user.id] });
    assert.equal(bad.status, 400);
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'Solo', member_ids: [] })).status, 400);
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'X', member_ids: [member.user.id], emoji: 'abc' })).status, 400);
    assert.equal((await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'X', member_ids: [member.user.id], color: 'red' })).status, 400);

    const g = await member.agent.post('/api/messages/conversations', { kind: 'group', name: 'Weekend', emoji: '🏕️', member_ids: [kid.user.id] });
    assert.equal(g.status, 201);
    assert.equal(g.body.title, 'Weekend');
    assert.equal(g.body.emoji, '🏕️');
    assert.equal(g.body.participants.length, 2);
    // A system message records the creation.
    const hist = await member.agent.get(`/api/messages/conversations/${g.body.id}/messages`);
    assert.equal(hist.body.messages[0].kind, 'system');
    // Admin is not in the group -> 404 everywhere.
    assert.equal((await admin.agent.get(`/api/messages/conversations/${g.body.id}`)).status, 404);
    assert.equal((await admin.agent.get(`/api/messages/conversations/${g.body.id}/messages`)).status, 404);
    // Kid got a notification about being added.
    const notes = await kid.agent.get('/api/notifications');
    assert.ok(notes.body.items.some((n) => n.module === 'messages' && /added you/.test(n.title)));
    // Activity entry — visible to the group's participants only (the admin isn't in it).
    const act = await kid.agent.get('/api/activity?module=messages');
    assert.ok(act.body.some((a) => a.summary.includes('Weekend') && a.link === `/messages/${g.body.id}`));
    const adminAct = await admin.agent.get('/api/activity?module=messages');
    assert.ok(!adminAct.body.some((a) => a.summary.includes('Weekend')));

    // Rename by any participant.
    const ren = await kid.agent.patch(`/api/messages/conversations/${g.body.id}`, { name: 'Camping' });
    assert.equal(ren.status, 200);
    assert.equal(ren.body.name, 'Camping');
    assert.equal((await kid.agent.patch(`/api/messages/conversations/${g.body.id}`, {})).status, 400);

    // Add admin.
    const add = await kid.agent.post(`/api/messages/conversations/${g.body.id}/members`, { user_ids: [admin.user.id] });
    assert.equal(add.status, 200);
    assert.equal(add.body.participants.length, 3);
    assert.equal((await kid.agent.post(`/api/messages/conversations/${g.body.id}/members`, { user_ids: [admin.user.id] })).status, 400);

    // Kid (child, not creator) can't remove others; creator can; admin can.
    assert.equal((await kid.agent.del(`/api/messages/conversations/${g.body.id}/members/${admin.user.id}`)).status, 403);
    assert.equal((await admin.agent.del(`/api/messages/conversations/${g.body.id}/members/${kid.user.id}`)).status, 200);
    assert.equal((await kid.agent.get(`/api/messages/conversations/${g.body.id}`)).status, 404);
    // Kid can't delete the group.
    await member.agent.post(`/api/messages/conversations/${g.body.id}/members`, { user_ids: [kid.user.id] });
    assert.equal((await kid.agent.del(`/api/messages/conversations/${g.body.id}`)).status, 403);
    // Leave.
    const leave = await kid.agent.del(`/api/messages/conversations/${g.body.id}/members/${kid.user.id}`);
    assert.equal(leave.status, 200);
    assert.equal(leave.body.deleted, false);
    // Family & direct can't be left / renamed / deleted.
    const fam = await familyConv(admin.agent);
    assert.equal((await admin.agent.del(`/api/messages/conversations/${fam.id}/members/${admin.user.id}`)).status, 400);
    assert.equal((await admin.agent.patch(`/api/messages/conversations/${fam.id}`, { name: 'x' })).status, 400);
    assert.equal((await admin.agent.del(`/api/messages/conversations/${fam.id}`)).status, 400);
    // Creator deletes.
    assert.equal((await member.agent.del(`/api/messages/conversations/${g.body.id}`)).status, 200);
    assert.equal((await member.agent.get(`/api/messages/conversations/${g.body.id}`)).status, 404);
  });

  test('people re-added to a group do not see what was said while they were out', async () => {
    const { admin, member } = await trio('Gaps');
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'G', member_ids: [member.user.id] })).body;
    const url = `/api/messages/conversations/${g.id}/messages`;
    await admin.agent.post(url, { body: 'before they left' });
    await admin.agent.del(`/api/messages/conversations/${g.id}/members/${member.user.id}`);
    const secret = (await admin.agent.post(url, { body: 'while they were out' })).body;
    const photo = (await admin.agent.upload(url, { file: PNG_1X1, filename: 'x.png', field: 'files' })).body;
    await admin.agent.post(`/api/messages/conversations/${g.id}/members`, { user_ids: [member.user.id] });
    const reply = (await admin.agent.post(url, { body: 'welcome back', reply_to_id: secret.id })).body;
    assert.equal(reply.reply_to.body, 'while they were out'); // the author still sees it
    const seen = (await member.agent.get(url)).body.messages;
    const bodies = seen.map((m) => m.body);
    assert.ok(bodies.includes('before they left'));
    assert.ok(bodies.includes('welcome back'));
    assert.ok(!bodies.includes('while they were out'));
    assert.ok(!seen.some((m) => m.id === photo.id));
    // Reply previews of hidden messages are masked, and hidden ids act like they don't exist.
    assert.equal(seen.find((m) => m.body === 'welcome back').reply_to.body, '');
    assert.equal((await member.agent.post(`/api/messages/messages/${secret.id}/reactions`, { emoji: '👍' })).status, 404);
    assert.equal((await fetch(srv.base + photo.attachments[0].url, { headers: { cookie: member.agent.cookie } })).status, 404);
    const s2 = await member.agent.get('/api/search?q=while%20they');
    assert.ok(!s2.body.results.some((r) => r.module === 'messages'));
    assert.equal((await member.agent.get('/api/messages/unread')).body.conversations[g.id], 1);
  });

  test('edits, reactions and deletes of away-period messages are not pushed to re-added members', async () => {
    const { admin, member } = await trio('GapsLive');
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'G', member_ids: [member.user.id] })).body;
    const url = `/api/messages/conversations/${g.id}/messages`;
    await admin.agent.del(`/api/messages/conversations/${g.id}/members/${member.user.id}`);
    const secret = (await admin.agent.post(url, { body: 'top secret while away' })).body;
    await admin.agent.post(`/api/messages/conversations/${g.id}/members`, { user_ids: [member.user.id] });
    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'messages.message.created' && e.payload.message.body === 'sentinel', timeoutMs: 4000 });
    await admin.agent.patch(`/api/messages/messages/${secret.id}`, { body: 'edited top secret' });
    await admin.agent.post(`/api/messages/messages/${secret.id}/reactions`, { emoji: '👍' });
    await admin.agent.del(`/api/messages/messages/${secret.id}`);
    await admin.agent.post(url, { body: 'sentinel' });
    const events = await stream.events;
    assert.ok(events.some((e) => e.payload?.message?.body === 'sentinel'), 'stream still works');
    const leaked = events.filter((e) => e.type.startsWith('messages.message') && e.payload?.message?.id === secret.id);
    assert.equal(leaked.length, 0, 'no events about the hidden message');
    assert.ok(!JSON.stringify(events).includes('top secret'));
  });

  test('leaving the family and rejoining hides what was said while away', async () => {
    const { admin, member, family } = await trio('Rejoin');
    const fam = await familyConv(admin.agent);
    const famUrl = `/api/messages/conversations/${fam.id}/messages`;
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'Old group', member_ids: [member.user.id] })).body;
    const dm = (await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id })).body;
    await admin.agent.post(famUrl, { body: 'hello everyone' });
    await member.agent.get(famUrl);
    await member.agent.post(`/api/messages/conversations/${fam.id}/read`, {});
    await admin.agent.post(famUrl, { body: 'sent before they left, unread' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await member.agent.del(`/api/family/members/${member.user.id}`)).status, 200);
    await admin.agent.post(famUrl, { body: 'family gossip while gone' });
    await admin.agent.post(`/api/messages/conversations/${g.id}/messages`, { body: 'group gossip while gone' });
    await admin.agent.post(`/api/messages/conversations/${dm.id}/messages`, { body: 'dm while gone' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await member.agent.post('/api/families/join', { invite_code: family.invite_code })).status < 300, true);
    member.agent.familyId = family.id;
    await admin.agent.post(famUrl, { body: 'welcome back!' });
    const famBodies = (await member.agent.get(famUrl)).body.messages.map((m) => m.body);
    assert.ok(famBodies.includes('hello everyone'));
    assert.ok(famBodies.includes('welcome back!'));
    assert.ok(!famBodies.includes('family gossip while gone'));
    // The gap starts exactly when they left (lifecycle hook): unread messages from before stay visible.
    assert.ok(famBodies.includes('sent before they left, unread'));
    const list = (await member.agent.get('/api/messages/conversations')).body;
    assert.ok(!list.some((c) => c.id === g.id), 'no longer in the old group');
    assert.equal((await member.agent.get(`/api/messages/conversations/${g.id}/messages`)).status, 404);
    const dmBodies = (await member.agent.get(`/api/messages/conversations/${dm.id}/messages`)).body.messages.map((m) => m.body);
    assert.ok(!dmBodies.includes('dm while gone'));
    // Re-adding to the group later still keeps the away period hidden.
    await admin.agent.post(`/api/messages/conversations/${g.id}/members`, { user_ids: [member.user.id] });
    const gBodies = (await member.agent.get(`/api/messages/conversations/${g.id}/messages`)).body.messages.map((m) => m.body);
    assert.ok(!gBodies.includes('group gossip while gone'));
    const s = await member.agent.get('/api/search?q=gossip');
    assert.ok(!s.body.results.some((r) => r.module === 'messages'));
    // Reply previews of hidden messages carry hidden:true.
    const hiddenId = (await admin.agent.get(famUrl)).body.messages.find((m) => m.body === 'family gossip while gone').id;
    await admin.agent.post(famUrl, { body: 're: that', reply_to_id: hiddenId });
    const re = (await member.agent.get(famUrl)).body.messages.find((m) => m.body === 're: that');
    assert.equal(re.reply_to.hidden, true);
    assert.equal(re.reply_to.body, '');
  });

  test('fallback: rejoins that happened without lifecycle hooks are still detected', async () => {
    const { admin, member, family } = await trio('Fallback');
    const fam = await familyConv(admin.agent);
    const famUrl = `/api/messages/conversations/${fam.id}/messages`;
    await admin.agent.post(famUrl, { body: 'seen before' });
    await member.agent.post(`/api/messages/conversations/${fam.id}/read`, {});
    // Simulate old data: membership removed and re-created directly (no hooks ran).
    const row = srv.db.prepare('SELECT * FROM memberships WHERE family_id = ? AND user_id = ?').get(family.id, member.user.id);
    srv.db.prepare('DELETE FROM memberships WHERE family_id = ? AND user_id = ?').run(family.id, member.user.id);
    await admin.agent.post(famUrl, { body: 'said while away (old data)' });
    await new Promise((r) => setTimeout(r, 5));
    srv.db.prepare('INSERT INTO memberships (family_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(family.id, member.user.id, row.role, new Date().toISOString());
    const bodies = (await member.agent.get(famUrl)).body.messages.map((m) => m.body);
    assert.ok(bodies.includes('seen before'));
    assert.ok(!bodies.includes('said while away (old data)'));
  });

  test('leaving the family deletes groups it leaves empty, keeps the others', async () => {
    const { admin, member, kid } = await trio('LeaveEmpties');
    // A group whose other member already left: only `member` remains.
    const solo = (await member.agent.post('/api/messages/conversations', { kind: 'group', name: 'Solo', member_ids: [kid.user.id] })).body;
    await kid.agent.del(`/api/messages/conversations/${solo.id}/members/${kid.user.id}`);
    const photo = (await member.agent.upload(`/api/messages/conversations/${solo.id}/messages`, { file: PNG_1X1, filename: 'p.png', field: 'files' })).body;
    const shared = (await member.agent.post('/api/messages/conversations', { kind: 'group', name: 'Shared', member_ids: [admin.user.id] })).body;
    assert.equal((await member.agent.del(`/api/family/members/${member.user.id}`)).status, 200);
    const count = (id) => srv.db.prepare('SELECT COUNT(*) AS n FROM msg_conversations WHERE id = ?').get(id).n;
    assert.equal(count(solo.id), 0, 'emptied group deleted');
    assert.equal(count(shared.id), 1, 'group with people left is kept');
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM msg_attachments WHERE id = ?').get(photo.attachments[0].id).n, 0);
    const kept = (await admin.agent.get(`/api/messages/conversations/${shared.id}`)).body;
    assert.deepEqual(kept.participants.map((p) => p.id), [admin.user.id]);
  });

  test('last participant leaving deletes the group', async () => {
    const { admin, member } = await trio('LastOut');
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'Duo', member_ids: [member.user.id] })).body;
    await member.agent.del(`/api/messages/conversations/${g.id}/members/${member.user.id}`);
    const res = await admin.agent.del(`/api/messages/conversations/${g.id}/members/${admin.user.id}`);
    assert.equal(res.body.deleted, true);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM msg_conversations WHERE id = ?').get(g.id).n, 0);
  });

  test('mute excludes a conversation from the nav total', async () => {
    const { admin, member } = await trio('Mute');
    const fam = await familyConv(admin.agent);
    await member.agent.post(`/api/messages/conversations/${fam.id}/messages`, { body: 'one' });
    await member.agent.post(`/api/messages/conversations/${fam.id}/messages`, { body: 'two' });
    assert.equal((await admin.agent.get('/api/messages/unread')).body.total, 2);
    assert.equal((await admin.agent.put(`/api/messages/conversations/${fam.id}/mute`, { muted: 'yes' })).status, 400);
    const m = await admin.agent.put(`/api/messages/conversations/${fam.id}/mute`, { muted: true });
    assert.equal(m.body.muted, true);
    const u = (await admin.agent.get('/api/messages/unread')).body;
    assert.equal(u.total, 0);
    assert.equal(u.muted_total, 2);
    assert.equal(u.conversations[fam.id], 2);
  });
});

describe('messages', () => {
  test('send, paginate, unread + read receipts', async () => {
    const { admin, member } = await trio('Chat');
    const fam = await familyConv(admin.agent);
    const url = `/api/messages/conversations/${fam.id}/messages`;
    assert.equal((await admin.agent.post(url, { body: '   ' })).status, 400);
    assert.equal((await admin.agent.post(url, { body: 'x'.repeat(4001) })).status, 400);
    assert.equal((await admin.agent.post(url, { body: 42 })).status, 400);
    for (let i = 1; i <= 45; i++) {
      const r = await admin.agent.post(url, { body: `message ${i}`, client_id: `c${i}` });
      assert.equal(r.status, 201);
      if (i === 1) assert.equal(r.body.client_id, 'c1');
    }
    const page1 = await member.agent.get(url);
    assert.equal(page1.body.messages.length, 40);
    assert.equal(page1.body.has_more, true);
    assert.equal(page1.body.messages.at(-1).body, 'message 45');
    assert.equal(page1.body.messages[0].body, 'message 6');
    const page2 = await member.agent.get(`${url}?before=${page1.body.messages[0].id}`);
    assert.equal(page2.body.messages.length, 5);
    assert.equal(page2.body.has_more, false);
    assert.equal(page2.body.messages[0].body, 'message 1');
    const newer = await member.agent.get(`${url}?after=${page2.body.messages.at(-1).id}&limit=3`);
    assert.deepEqual(newer.body.messages.map((m) => m.body), ['message 6', 'message 7', 'message 8']);

    // Unread counts: member has 45, author has 0.
    assert.equal((await member.agent.get('/api/messages/unread')).body.total, 45);
    assert.equal((await admin.agent.get('/api/messages/unread')).body.total, 0);
    // Partial read, then full read; never goes backwards.
    const mid = page1.body.messages[10].id;
    const r1 = await member.agent.post(`/api/messages/conversations/${fam.id}/read`, { last_read_id: mid });
    assert.equal(r1.body.last_read_id, mid);
    assert.ok(r1.body.unread.total < 45 && r1.body.unread.total > 0);
    const r2 = await member.agent.post(`/api/messages/conversations/${fam.id}/read`, {});
    assert.equal(r2.body.unread.total, 0);
    const r3 = await member.agent.post(`/api/messages/conversations/${fam.id}/read`, { last_read_id: mid });
    assert.equal(r3.body.last_read_id, r2.body.last_read_id);
    // Read receipts are exposed on participants.
    const conv = (await admin.agent.get(`/api/messages/conversations/${fam.id}`)).body;
    const memberRow = conv.participants.find((p) => p.id === member.user.id);
    assert.equal(memberRow.last_read_id, page1.body.messages.at(-1).id);
    // Last message preview in the list.
    const listed = await familyConv(member.agent);
    assert.equal(listed.last_message.body, 'message 45');
    assert.equal(listed.unread, 0);
  });

  test('image attachments: upload, validation, cleanup on delete', async () => {
    const { admin, member } = await trio('Photos');
    const fam = await familyConv(admin.agent);
    const url = `/api/messages/conversations/${fam.id}/messages`;
    const up = await admin.agent.upload(url, { file: PNG_1X1, filename: 'a.png', field: 'files', fields: { body: 'Look!', dims: JSON.stringify([[640, 480]]) } });
    assert.equal(up.status, 201);
    assert.equal(up.body.attachments.length, 1);
    assert.equal(up.body.attachments[0].width, 640);
    assert.match(up.body.attachments[0].url, /^\/api\/messages\/attachments\/\d+\?family_id=\d+$/);
    // The raw family-wide /uploads path is never exposed to clients.
    assert.ok(!JSON.stringify(up.body).includes('/uploads/'));
    // Photo only (no text) is fine.
    const photoOnly = await admin.agent.upload(url, { file: PNG_1X1, filename: 'b.png', field: 'files' });
    assert.equal(photoOnly.status, 201);
    assert.equal(photoOnly.body.body, '');
    // Non-images rejected.
    const txt = await admin.agent.upload(url, { file: Buffer.from('hi'), filename: 'a.txt', type: 'text/plain', field: 'files' });
    assert.equal(txt.status, 400);
    // Too many.
    const form = new FormData();
    for (let i = 0; i < 7; i++) form.append('files', new Blob([PNG_1X1], { type: 'image/png' }), `p${i}.png`);
    const many = await fetch(srv.base + url, { method: 'POST', body: form, headers: { cookie: admin.agent.cookie } });
    assert.equal(many.status, 400);
    // Activity for photos in the Family chat.
    const act = await admin.agent.get('/api/activity?module=messages');
    assert.ok(act.body.some((a) => a.verb === 'shared'));
    // File is served to participants, with an image content type.
    const file = await fetch(srv.base + up.body.attachments[0].url, { headers: { cookie: member.agent.cookie } });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), /^image\/png/);
    // Photos in a DM are not served to other family members.
    const dm = (await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id })).body;
    const secret = await admin.agent.upload(`/api/messages/conversations/${dm.id}/messages`, { file: PNG_1X1, filename: 's.png', field: 'files' });
    const kidAgent = (await registerUser(srv, { name: 'Nosy' })).agent;
    await kidAgent.post('/api/families/join', { invite_code: (await admin.agent.get('/api/family')).body.invite_code });
    assert.equal((await fetch(srv.base + secret.body.attachments[0].url, { headers: { cookie: kidAgent.cookie } })).status, 404);
    assert.equal((await fetch(srv.base + secret.body.attachments[0].url, { headers: { cookie: member.agent.cookie } })).status, 200);
    // Deleting removes the attachment row.
    const del = await admin.agent.del(`/api/messages/messages/${up.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.equal(del.body.attachments.length, 0);
    assert.equal(del.body.body, '');
    await new Promise((r) => setTimeout(r, 50));
    const gone = await fetch(srv.base + up.body.attachments[0].url, { headers: { cookie: member.agent.cookie } });
    assert.equal(gone.status, 404);
  });

  test('reply-to, reactions, edit and delete permissions', async () => {
    const { admin, member, kid } = await trio('Interact');
    const fam = await familyConv(admin.agent);
    const url = `/api/messages/conversations/${fam.id}/messages`;
    const first = (await member.agent.post(url, { body: 'Pizza tonight?' })).body;
    const reply = await kid.agent.post(url, { body: 'YES', reply_to_id: first.id });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.reply_to.id, first.id);
    assert.equal(reply.body.reply_to.body, 'Pizza tonight?');
    // Reply target must be in the same conversation.
    const dm = (await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id })).body;
    assert.equal((await admin.agent.post(`/api/messages/conversations/${dm.id}/messages`, { body: 'x', reply_to_id: first.id })).status, 400);
    // Reply notifies the original author.
    const notes = await member.agent.get('/api/notifications');
    assert.ok(notes.body.items.some((n) => /replied to your message/.test(n.title)));

    // Reactions toggle.
    const r1 = await admin.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: '❤️' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.reacted, true);
    await kid.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: '❤️' });
    const r2 = await kid.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: '😂' });
    assert.deepEqual(r2.body.reactions.find((x) => x.emoji === '❤️').user_ids.sort(), [admin.user.id, kid.user.id].sort());
    const r3 = await admin.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: '❤️' });
    assert.equal(r3.body.reacted, false);
    assert.deepEqual(r3.body.reactions.find((x) => x.emoji === '❤️').user_ids, [kid.user.id]);
    assert.equal((await admin.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: 'lol' })).status, 400);
    assert.equal((await admin.agent.post(`/api/messages/messages/${first.id}/reactions`, {})).status, 400);

    // Edit: own only.
    assert.equal((await kid.agent.patch(`/api/messages/messages/${first.id}`, { body: 'hacked' })).status, 403);
    const ed = await member.agent.patch(`/api/messages/messages/${first.id}`, { body: 'Pizza tonight? 🍕' });
    assert.equal(ed.status, 200);
    assert.ok(ed.body.edited_at);
    assert.equal((await member.agent.patch(`/api/messages/messages/${first.id}`, { body: '' })).status, 400);

    // Delete: child can't delete others'; admin can moderate; own delete works.
    assert.equal((await kid.agent.del(`/api/messages/messages/${first.id}`)).status, 403);
    assert.equal((await member.agent.del(`/api/messages/messages/${reply.body.id}`)).status, 403);
    assert.equal((await kid.agent.del(`/api/messages/messages/${reply.body.id}`)).status, 200);
    const modded = await admin.agent.del(`/api/messages/messages/${first.id}`);
    assert.equal(modded.status, 200);
    assert.equal(modded.body.deleted, true);
    assert.equal(modded.body.reactions.length, 0);
    // Deleted messages can't be reacted to / edited, and don't count as unread.
    assert.equal((await kid.agent.post(`/api/messages/messages/${first.id}/reactions`, { emoji: '👍' })).status, 400);
    assert.equal((await member.agent.patch(`/api/messages/messages/${first.id}`, { body: 'x' })).status, 400);
    const history = (await kid.agent.get(url)).body.messages;
    assert.equal(history.find((m) => m.id === first.id).body, '');
    // System messages can't be deleted.
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'G', member_ids: [member.user.id] })).body;
    const sys = (await admin.agent.get(`/api/messages/conversations/${g.id}/messages`)).body.messages[0];
    assert.equal((await admin.agent.del(`/api/messages/messages/${sys.id}`)).status, 400);
    assert.equal((await admin.agent.del('/api/messages/messages/999999')).status, 404);
  });

  test('@mentions notify the mentioned participant only', async () => {
    const { admin, member, kid } = await trio('Mentions');
    const fam = await familyConv(admin.agent);
    await admin.agent.post(`/api/messages/conversations/${fam.id}/messages`, { body: 'Hey @Member can you help?' });
    const mNotes = (await member.agent.get('/api/notifications')).body.items;
    assert.ok(mNotes.some((n) => /mentioned you/.test(n.title) && n.link.startsWith(`/messages/${fam.id}`)));
    const kNotes = (await kid.agent.get('/api/notifications')).body.items;
    assert.ok(!kNotes.some((n) => /mentioned you/.test(n.title)));
  });
});

describe('isolation & realtime', () => {
  test('other families get 404 for every id, and search is scoped', async () => {
    const a = await trio('IsoA');
    const b = await trio('IsoB');
    const famA = await familyConv(a.admin.agent);
    const msg = (await a.admin.agent.post(`/api/messages/conversations/${famA.id}/messages`, { body: 'secret pancake recipe' })).body;
    const B = b.admin.agent;
    assert.equal((await B.get(`/api/messages/conversations/${famA.id}`)).status, 404);
    assert.equal((await B.get(`/api/messages/conversations/${famA.id}/messages`)).status, 404);
    assert.equal((await B.post(`/api/messages/conversations/${famA.id}/messages`, { body: 'hi' })).status, 404);
    assert.equal((await B.post(`/api/messages/conversations/${famA.id}/read`, {})).status, 404);
    assert.equal((await B.post(`/api/messages/conversations/${famA.id}/typing`, {})).status, 404);
    assert.equal((await B.put(`/api/messages/conversations/${famA.id}/mute`, { muted: true })).status, 404);
    assert.equal((await B.patch(`/api/messages/messages/${msg.id}`, { body: 'x' })).status, 404);
    assert.equal((await B.del(`/api/messages/messages/${msg.id}`)).status, 404);
    assert.equal((await B.post(`/api/messages/messages/${msg.id}/reactions`, { emoji: '👍' })).status, 404);
    assert.equal((await B.get('/api/messages/conversations')).body.some((c) => c.id === famA.id), false);
    // Search: A finds it, B doesn't.
    const sa = await a.member.agent.get('/api/search?q=pancake');
    assert.ok(sa.body.results.some((r) => r.module === 'messages' && r.link === `/messages/${famA.id}?m=${msg.id}`));
    const sb = await B.get('/api/search?q=pancake');
    assert.ok(!sb.body.results.some((r) => r.module === 'messages'));
  });

  test('search only covers conversations the viewer is in', async () => {
    const { admin, member, kid } = await trio('SearchScope');
    const dm = (await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id })).body;
    await admin.agent.post(`/api/messages/conversations/${dm.id}/messages`, { body: 'surprise party for kid' });
    const byMember = await member.agent.get('/api/search?q=surprise');
    assert.ok(byMember.body.results.some((r) => r.module === 'messages'));
    const byKid = await kid.agent.get('/api/search?q=surprise');
    assert.ok(!byKid.body.results.some((r) => r.module === 'messages'));
  });

  test('realtime events reach only participants', async () => {
    const { admin, member, kid } = await trio('Live');
    const dm = (await admin.agent.post('/api/messages/conversations', { kind: 'direct', user_id: member.user.id })).body;
    const memberStream = await collectEvents(member.agent, { until: (e) => e.type === 'messages.message.created', timeoutMs: 3000 });
    const kidStream = await collectEvents(kid.agent, { until: (e) => e.type.startsWith('messages.'), timeoutMs: 800 });
    await admin.agent.post(`/api/messages/conversations/${dm.id}/messages`, { body: 'just us', client_id: 'abc' });
    const got = await memberStream.events;
    const created = got.find((e) => e.type === 'messages.message.created');
    assert.ok(created, 'member received the message');
    assert.equal(created.payload.conversation_id, dm.id);
    assert.equal(created.payload.message.body, 'just us');
    assert.equal(created.payload.client_id, 'abc');
    const kidGot = await kidStream.events;
    assert.equal(kidGot.filter((e) => e.type.startsWith('messages.')).length, 0, 'non-participant received nothing');
  });

  test('typing, read, reaction and delete events are broadcast to participants', async () => {
    const { admin, member } = await trio('LiveMore');
    const fam = await familyConv(admin.agent);
    const msg = (await member.agent.post(`/api/messages/conversations/${fam.id}/messages`, { body: 'hi' })).body;
    const want = ['messages.typing', 'messages.read', 'messages.message.updated'];
    const stream = await collectEvents(member.agent, {
      until: (() => {
        const seen = new Set();
        return (e) => {
          seen.add(e.type);
          return want.every((t) => seen.has(t));
        };
      })(),
      timeoutMs: 3000,
    });
    await admin.agent.post(`/api/messages/conversations/${fam.id}/typing`, {});
    await admin.agent.post(`/api/messages/conversations/${fam.id}/read`, {});
    await admin.agent.post(`/api/messages/messages/${msg.id}/reactions`, { emoji: '👍' });
    const events = await stream.events;
    const typing = events.find((e) => e.type === 'messages.typing');
    assert.equal(typing.payload.user_id, admin.user.id);
    assert.equal(typing.payload.conversation_id, fam.id);
    const read = events.find((e) => e.type === 'messages.read');
    assert.equal(read.payload.user_id, admin.user.id);
    assert.equal(read.payload.last_read_id, msg.id);
    const upd = events.find((e) => e.type === 'messages.message.updated');
    assert.equal(upd.payload.message.reactions[0].emoji, '👍');
  });

  test('removed group members get a conversation.removed event', async () => {
    const { admin, member } = await trio('LiveRemove');
    const g = (await admin.agent.post('/api/messages/conversations', { kind: 'group', name: 'Temp', member_ids: [member.user.id] })).body;
    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'messages.conversation.removed', timeoutMs: 3000 });
    await admin.agent.del(`/api/messages/conversations/${g.id}/members/${member.user.id}`);
    const ev = (await stream.events).find((e) => e.type === 'messages.conversation.removed');
    assert.equal(ev.payload.conversation_id, g.id);
    assert.equal(ev.payload.reason, 'removed');
  });

  test('a user who left the family loses access and is hidden from participants', async () => {
    const { admin, member } = await trio('Leaver');
    const fam = await familyConv(admin.agent);
    await member.agent.del(`/api/family/members/${member.user.id}`);
    const conv = (await admin.agent.get(`/api/messages/conversations/${fam.id}`)).body;
    assert.ok(!conv.participants.some((p) => p.id === member.user.id));
  });
});

describe('seed, dashboard', () => {
  test('seed creates a lively demo chat', async () => {
    const { familyId, users } = await seedDemo(srv.ctx, undefined, { log: () => {} });
    const alex = srv.agent();
    const login = await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
    assert.equal(login.status, 200);
    alex.familyId = familyId;
    const list = (await alex.get('/api/messages/conversations')).body;
    assert.ok(list.length >= 5, 'family + DMs + groups');
    assert.equal(list.filter((c) => c.kind === 'family').length, 1);
    assert.ok(list.some((c) => c.kind === 'group' && c.name === 'Lake trip'));
    const fam = list.find((c) => c.kind === 'family');
    const hist = (await alex.get(`/api/messages/conversations/${fam.id}/messages`)).body.messages;
    assert.ok(hist.length >= 20);
    assert.ok(hist.some((m) => m.attachments.length > 0));
    assert.ok(hist.some((m) => m.reactions.length > 0));
    assert.ok(hist.some((m) => m.reply_to));
    const unread = (await alex.get('/api/messages/unread')).body;
    assert.ok(unread.total > 0, 'alex has something unread');
    // Mia is not in Parents HQ.
    const mia = srv.agent();
    await mia.post('/api/auth/login', { email: 'mia@hearth.test', password: 'hearth123' });
    mia.familyId = familyId;
    const miaList = (await mia.get('/api/messages/conversations')).body;
    assert.ok(!miaList.some((c) => c.name === 'Parents HQ'));
    // …and the seeded "started the group chat “Parents HQ”" activity never reaches her feeds.
    const miaActs = (await mia.get('/api/activity?limit=100')).body.map((a) => a.summary);
    assert.ok(!miaActs.some((s) => s.includes('Parents HQ')), 'Parents HQ not in Mia\'s activity');
    assert.ok(miaActs.some((s) => s.includes('Lake trip')), 'Lake trip (Mia is in it) is visible');
    const miaWall = (await mia.get('/api/wall/feed?filter=activity&limit=50')).body.items.map((i) => i.activity.summary);
    assert.ok(!miaWall.some((s) => s.includes('Parents HQ')));
    assert.ok((await alex.get('/api/activity?limit=100')).body.some((a) => a.summary.includes('Parents HQ')));
    // Search subtitle for a DM says "Direct message".
    const dmHit = (await alex.get('/api/search?q=dry%20cleaning')).body.results.find((r) => r.module === 'messages');
    assert.match(dmHit.subtitle, /^Sam · Direct message · /);
    // Seeded photos are served.
    const photo = hist.find((m) => m.attachments.length).attachments[0];
    const res = await fetch(srv.base + photo.url, { headers: { cookie: mia.cookie } });
    assert.equal(res.status, 200);
    // Dashboard.
    const dash = (await alex.get('/api/dashboard')).body.messages;
    assert.equal(dash.unread, unread.total);
    assert.ok(dash.recent.length > 0);
    assert.ok(users.alex.id);
  });
});
