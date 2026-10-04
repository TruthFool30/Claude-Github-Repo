import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, collectEvents } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

async function trio(name) {
  const fx = await familyFixture(srv, name);
  const kid = await registerUser(srv, { name: 'Mia Kid' });
  await kid.agent.post('/api/families/join', { invite_code: fx.family.invite_code });
  return { ...fx, kid };
}

const feedSummaries = async (agent) => (await agent.get('/api/activity')).body.map((a) => a.summary);
const wallSummaries = async (agent) => (await agent.get('/api/wall/feed?filter=activity')).body.items.map((i) => i.activity.summary);

test('audience-restricted activity is hidden from non-members in /api/activity, the Wall feed and SSE', async () => {
  const { admin, member, kid } = await trio('Aud');
  const kidStream = await collectEvents(kid.agent, { timeoutMs: 1500, until: (e) => e.type === 'activity' });
  const memberStream = await collectEvents(member.agent, { timeoutMs: 3000, until: (e) => e.type === 'activity' });
  const created = await admin.agent.post('/api/messages/conversations', { kind: 'group', name: "Mia's surprise party", member_ids: [member.user.id] });
  assert.equal(created.status, 201);
  const secret = 'started the group chat “Mia\'s surprise party”';

  const kidEvents = await kidStream.events;
  assert.ok(!kidEvents.some((e) => e.type === 'activity'), 'kid got no live activity event');
  const memberEvents = await memberStream.events;
  const live = memberEvents.find((e) => e.type === 'activity');
  assert.equal(live?.payload.summary, secret);
  assert.equal(live.payload.audience, undefined, 'audience column is not exposed');

  assert.ok(!(await feedSummaries(kid.agent)).includes(secret));
  assert.ok(!(await wallSummaries(kid.agent)).includes(secret));
  assert.ok((await feedSummaries(member.agent)).includes(secret));
  assert.ok((await wallSummaries(admin.agent)).includes(secret));

  // Adding the kid to the group extends the audience; removing them again hides it.
  const convId = created.body.id;
  assert.equal((await admin.agent.post(`/api/messages/conversations/${convId}/members`, { user_ids: [kid.user.id] })).status, 200);
  assert.ok((await feedSummaries(kid.agent)).includes(secret));
  assert.equal((await admin.agent.del(`/api/messages/conversations/${convId}/members/${kid.user.id}`)).status, 200);
  assert.ok(!(await feedSummaries(kid.agent)).includes(secret));

  // Deleting the group removes the entry for everyone.
  assert.equal((await admin.agent.del(`/api/messages/conversations/${convId}`)).status, 200);
  assert.ok(!(await feedSummaries(member.agent)).includes(secret));
});

test('ctx.logActivity audience: family-wide entries are unaffected, restricted ones only reach the audience', async () => {
  const { admin, member, kid, family } = await trio('Aud2');
  srv.ctx.logActivity({ familyId: family.id, userId: admin.user.id, module: 'lists', verb: 'created', summary: 'public thing', link: '/lists' });
  srv.ctx.logActivity({ familyId: family.id, userId: admin.user.id, module: 'lists', verb: 'created', summary: 'private thing', link: '/lists', audience: [admin.user.id, member.user.id] });
  const kidSees = await feedSummaries(kid.agent);
  assert.ok(kidSees.includes('public thing'));
  assert.ok(!kidSees.includes('private thing'));
  assert.ok((await feedSummaries(member.agent)).includes('private thing'));
  assert.ok((await wallSummaries(admin.agent)).includes('private thing'));
  assert.throws(() => srv.ctx.logActivity({ familyId: family.id, module: 'x', verb: 'y', summary: 'z', audience: 5 }));
});

test('renaming a group rewrites its feed entry, so members added later never see the old name', async () => {
  const { admin, member, kid } = await trio('Rename');
  const created = await admin.agent.post('/api/messages/conversations', { kind: 'group', name: "Mia's surprise party", member_ids: [member.user.id] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const renamed = await admin.agent.patch(`/api/messages/conversations/${id}`, { name: 'Party planning' });
  assert.equal(renamed.status, 200);
  const memberFeed = await feedSummaries(member.agent);
  assert.ok(memberFeed.includes('started the group chat “Party planning”'));
  assert.ok(!memberFeed.some((s) => s.includes('surprise')), 'old name gone for existing members');
  const add = await admin.agent.post(`/api/messages/conversations/${id}/members`, { user_ids: [kid.user.id] });
  assert.ok(add.status < 300, `add member: ${add.status} ${JSON.stringify(add.body)}`);
  const kidFeed = await feedSummaries(kid.agent);
  assert.ok(kidFeed.includes('started the group chat “Party planning”'));
  assert.ok(!kidFeed.some((s) => s.includes('surprise')), 'late joiner never sees the old name');
});
