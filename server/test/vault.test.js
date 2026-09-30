import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import * as vault from '../src/modules/vault.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

/** Admin + member + a child (managed member who signs in) in one family. */
async function familyWithChild(name) {
  const fx = await familyFixture(srv, name);
  const email = `kid${Date.now()}${Math.random().toString(16).slice(2, 6)}@example.test`;
  const res = await fx.admin.agent.post('/api/family/members', { name: 'Kiddo', email, role: 'child', password: 'secret123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const child = { agent: srv.agent() };
  const login = await child.agent.post('/api/auth/login', { email, password: 'secret123' });
  assert.equal(login.status, 200);
  child.user = login.body.user;
  return { ...fx, child };
}

const upload = (agent, { file = PNG_1X1, filename = 'scan.png', type = 'image/png', fields = {} } = {}) =>
  agent.upload('/api/vault/documents', { file, filename, type, fields });

describe('contacts', () => {
  test('CRUD with validation, search and category filter', async () => {
    const { admin } = await familyFixture(srv, 'Contacts A');
    const a = admin.agent;

    assert.equal((await a.post('/api/vault/contacts', {})).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X', category: 'aliens' })).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X', email: 'nope' })).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X', phones: [{ label: 'Mobile', number: 'call me' }] })).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X', phones: 'nope' })).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X', website: 'not a url' })).status, 400);
    assert.equal((await a.post('/api/vault/contacts', { name: 'X'.repeat(121) })).status, 400);

    const created = await a.post('/api/vault/contacts', {
      name: '  Dr. Priya Patel ', category: 'medical', role: 'Pediatrician', organization: 'Maple Grove',
      phones: [{ label: 'Office', number: '+1 555 0142' }, { label: '', number: '' }], email: 'dr@example.test',
      website: 'maplegrove.example', favorite: true, emergency: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const c = created.body;
    assert.equal(c.name, 'Dr. Priya Patel');
    assert.deepEqual(c.phones, [{ label: 'Office', number: '+1 555 0142' }]);
    assert.equal(c.website, 'https://maplegrove.example');
    assert.equal(c.favorite, true);
    assert.equal(c.emergency, true);
    assert.equal(c.can_edit, true);

    await a.post('/api/vault/contacts', { name: "Mike's Plumbing", category: 'home', phones: [{ label: 'Office', number: '555-0181' }] });

    const all = (await a.get('/api/vault/contacts')).body;
    assert.deepEqual(all.map((x) => x.name), ['Dr. Priya Patel', "Mike's Plumbing"]);
    assert.deepEqual((await a.get('/api/vault/contacts?category=home')).body.map((x) => x.name), ["Mike's Plumbing"]);
    assert.deepEqual((await a.get('/api/vault/contacts?q=pediat')).body.map((x) => x.name), ['Dr. Priya Patel']);
    assert.deepEqual((await a.get('/api/vault/contacts?q=0181')).body.map((x) => x.name), ["Mike's Plumbing"]);
    assert.deepEqual((await a.get('/api/vault/contacts?favorite=1')).body.map((x) => x.name), ['Dr. Priya Patel']);
    assert.equal((await a.get('/api/vault/contacts?category=bogus')).status, 400);

    const patched = await a.patch(`/api/vault/contacts/${c.id}`, { notes: 'Same-day visits', emergency: false, email: '' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.notes, 'Same-day visits');
    assert.equal(patched.body.emergency, false);
    assert.equal(patched.body.email, null);
    assert.equal(patched.body.role, 'Pediatrician', 'untouched fields are kept');
    assert.equal((await a.patch(`/api/vault/contacts/${c.id}`, { name: '' })).status, 400);

    assert.equal((await a.del(`/api/vault/contacts/${c.id}`)).status, 200);
    assert.equal((await a.get(`/api/vault/contacts/${c.id}`)).status, 404);
    assert.equal((await a.get('/api/vault/contacts/abc')).status, 400);
  });

  test('children can add contacts but only manage their own; anyone may favorite', async () => {
    const { admin, member, child } = await familyWithChild('Contacts roles');
    const adult = (await admin.agent.post('/api/vault/contacts', { name: 'School office', category: 'school' })).body;
    const mine = (await child.agent.post('/api/vault/contacts', { name: 'Best friend Zoe', category: 'family' })).body;
    assert.equal(mine.can_edit, true);

    const seen = (await child.agent.get('/api/vault/contacts')).body.find((x) => x.id === adult.id);
    assert.equal(seen.can_edit, false);
    assert.equal((await child.agent.patch(`/api/vault/contacts/${adult.id}`, { name: 'Hacked' })).status, 403);
    assert.equal((await child.agent.del(`/api/vault/contacts/${adult.id}`)).status, 403);
    const fav = await child.agent.patch(`/api/vault/contacts/${adult.id}`, { favorite: true });
    assert.equal(fav.status, 200);
    assert.equal(fav.body.favorite, true);
    // Favorites are per person: the child's star doesn't change anyone else's list.
    assert.equal((await admin.agent.get(`/api/vault/contacts/${adult.id}`)).body.favorite, false);
    assert.deepEqual((await admin.agent.get('/api/vault/contacts?favorite=1')).body, []);
    assert.deepEqual((await child.agent.get('/api/vault/contacts?favorite=1')).body.map((c) => c.id), [adult.id]);

    assert.equal((await child.agent.patch(`/api/vault/contacts/${mine.id}`, { role: 'Classmate' })).status, 200);
    // Adults can manage anything shared.
    assert.equal((await member.agent.patch(`/api/vault/contacts/${adult.id}`, { role: 'Front desk' })).status, 200);
    assert.equal((await member.agent.del(`/api/vault/contacts/${mine.id}`)).status, 200);
  });

  test('emergency contacts notify the rest of the family', async () => {
    const { admin, member } = await familyFixture(srv, 'Contacts notify');
    await admin.agent.post('/api/vault/contacts', { name: 'Grandma Rosa', category: 'family', emergency: true });
    const notes = (await member.agent.get('/api/notifications')).body.items;
    assert.ok(notes.some((n) => n.title === 'New emergency contact: Grandma Rosa' && n.module === 'vault'));
    const own = (await admin.agent.get('/api/notifications')).body.items;
    assert.ok(!own.some((n) => n.title.includes('Grandma Rosa')), 'no self-notification');
    const act = (await member.agent.get('/api/activity?module=vault')).body;
    assert.ok(act.some((x) => x.summary === 'added Grandma Rosa to emergency contacts' && x.link.startsWith('/vault/contacts/')));
  });
});

describe('folders & documents', () => {
  test('upload, list, preview, download, rename, move and delete', async () => {
    const { admin, member } = await familyFixture(srv, 'Docs A');
    const a = admin.agent;

    assert.equal((await a.post('/api/vault/folders', { name: '' })).status, 400);
    assert.equal((await a.post('/api/vault/folders', { name: 'Medical', color: 'red' })).status, 400);
    assert.equal((await a.post('/api/vault/folders', { name: 'Medical', icon: 'rocket' })).status, 400);
    const medical = (await a.post('/api/vault/folders', { name: 'Medical', color: '#E5484D', icon: 'medical' })).body;
    assert.equal(medical.doc_count, 0);
    assert.equal((await a.post('/api/vault/folders', { name: 'medical' })).status, 409, 'folder names are unique per family');
    const school = (await a.post('/api/vault/folders', { name: 'School' })).body;

    assert.equal((await a.upload('/api/vault/documents', { fields: { name: 'nothing' } })).status, 400, 'file is required');
    assert.equal((await upload(a, { fields: { folder_id: 99999 } })).status, 404, 'unknown folder');
    assert.equal((await upload(a, { fields: { expires_on: '2026-02-31' } })).status, 400, 'invalid expiry');

    const up = await upload(a, { filename: 'Vaccination – Mia.png', fields: { folder_id: medical.id, notes: 'For school' } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const doc = up.body;
    assert.equal(doc.name, 'Vaccination – Mia', 'UTF-8 names survive and the extension is split off');
    assert.equal(doc.ext, 'png');
    assert.equal(doc.kind, 'image');
    assert.equal(doc.folder_id, medical.id);
    assert.equal(doc.folder_name, 'Medical');
    assert.equal(doc.size, PNG_1X1.length);
    assert.equal(doc.is_private, false);
    assert.equal(doc.storage_key, undefined, 'storage key is never exposed');
    assert.equal(doc.url, `/api/vault/documents/${doc.id}/file`);

    // Stored outside the public /uploads/<family>/<file> route.
    const vaultFiles = fs.readdirSync(path.join(srv.dir, 'uploads', String(doc.family_id), 'vault'));
    assert.equal(vaultFiles.length, 1);
    assert.equal((await a.get(`/uploads/${doc.family_id}/${vaultFiles[0]}`)).status, 404);
    assert.equal((await a.get(`/uploads/${doc.family_id}/vault/${vaultFiles[0]}`)).status, 404);

    const inline = await fetch(srv.base + doc.url, { headers: { cookie: a.cookie } });
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-disposition'), /^inline;/);
    assert.equal(inline.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), PNG_1X1);
    const dl = await fetch(`${srv.base}${doc.url}?download=1`, { headers: { cookie: a.cookie } });
    assert.match(dl.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''Vaccination%20%E2%80%93%20Mia\.png/);
    await dl.arrayBuffer();

    const folders = (await member.agent.get('/api/vault/folders')).body;
    assert.equal(folders.folders.find((f) => f.id === medical.id).doc_count, 1);
    assert.equal(folders.unfiled.doc_count, 0);

    // Unfiled upload + listing filters.
    const loose = (await upload(member.agent, { filename: 'notes.txt', type: 'text/plain', file: Buffer.from('hello') })).body;
    assert.equal(loose.kind, 'text');
    assert.deepEqual((await a.get('/api/vault/documents?folder_id=none')).body.map((d) => d.id), [loose.id]);
    assert.deepEqual((await a.get(`/api/vault/documents?folder_id=${medical.id}`)).body.map((d) => d.id), [doc.id]);
    assert.deepEqual((await a.get('/api/vault/documents?q=vaccin')).body.map((d) => d.id), [doc.id]);
    assert.equal((await a.get('/api/vault/documents?folder_id=424242')).status, 404);

    // Rename + move + expiry.
    assert.equal((await a.patch(`/api/vault/documents/${doc.id}`, { name: ' ' })).status, 400);
    const moved = await a.patch(`/api/vault/documents/${doc.id}`, { name: 'Shot record', folder_id: school.id, expires_on: '2031-01-15' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.name, 'Shot record');
    assert.equal(moved.body.folder_id, school.id);
    assert.equal(moved.body.download_name, 'Shot record.png');
    assert.equal(moved.body.expires_on, '2031-01-15');
    const unfiled = await a.patch(`/api/vault/documents/${doc.id}`, { folder_id: null });
    assert.equal(unfiled.body.folder_id, null);

    // Deleting a folder keeps its documents (they become unfiled).
    await a.patch(`/api/vault/documents/${doc.id}`, { folder_id: school.id });
    const delFolder = await a.del(`/api/vault/folders/${school.id}`);
    assert.equal(delFolder.status, 200);
    assert.equal(delFolder.body.moved, 1);
    assert.equal((await a.get(`/api/vault/documents/${doc.id}`)).body.folder_id, null);

    // Delete removes the row and the file.
    assert.equal((await a.del(`/api/vault/documents/${doc.id}`)).status, 200);
    assert.equal((await a.get(`/api/vault/documents/${doc.id}`)).status, 404);
    assert.equal((await fetch(srv.base + doc.url, { headers: { cookie: a.cookie } })).status, 404);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readdirSync(path.join(srv.dir, 'uploads', String(doc.family_id), 'vault')).length, 1, 'only the text file remains');
  });

  test('unsafe types are never served inline', async () => {
    const { admin } = await familyFixture(srv, 'Docs unsafe');
    const html = (await upload(admin.agent, { filename: 'evil.html', type: 'image/png', file: Buffer.from('<script>alert(1)</script>') })).body;
    assert.equal(html.kind, 'other');
    const res = await fetch(srv.base + html.url, { headers: { cookie: admin.agent.cookie } });
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    await res.arrayBuffer();
  });

  test('private documents are invisible to everyone but the owner', async () => {
    const { admin, member } = await familyFixture(srv, 'Docs private');
    const folder = (await admin.agent.post('/api/vault/folders', { name: 'Taxes' })).body;
    const priv = (await upload(member.agent, { filename: 'secret.pdf', type: 'application/pdf', fields: { is_private: 'true', folder_id: folder.id } })).body;
    assert.equal(priv.is_private, true);
    const shared = (await upload(member.agent, { filename: 'shared.pdf', type: 'application/pdf', fields: { folder_id: folder.id } })).body;

    // Owner sees both; the admin sees only the shared one — everywhere.
    assert.equal((await member.agent.get('/api/vault/documents')).body.length, 2);
    const adminList = (await admin.agent.get('/api/vault/documents')).body;
    assert.deepEqual(adminList.map((d) => d.id), [shared.id]);
    assert.equal((await admin.agent.get(`/api/vault/documents/${priv.id}`)).status, 404);
    assert.equal((await fetch(srv.base + priv.url, { headers: { cookie: admin.agent.cookie } })).status, 404);
    assert.equal((await admin.agent.patch(`/api/vault/documents/${priv.id}`, { name: 'x' })).status, 404);
    assert.equal((await admin.agent.del(`/api/vault/documents/${priv.id}`)).status, 404);
    assert.equal((await admin.agent.get('/api/vault/folders')).body.folders[0].doc_count, 1);
    assert.equal((await member.agent.get('/api/vault/folders')).body.folders[0].doc_count, 2);
    assert.equal((await admin.agent.get('/api/vault')).body.documents, 1);
    const adminSearch = (await admin.agent.get('/api/search?q=secret')).body.results.filter((r) => r.module === 'vault');
    assert.equal(adminSearch.length, 0);
    const ownerSearch = (await member.agent.get('/api/search?q=secret')).body.results.filter((r) => r.module === 'vault');
    assert.equal(ownerSearch.length, 1);
    // No Wall entry for a private upload.
    const act = (await admin.agent.get('/api/activity?module=vault')).body;
    assert.ok(!act.some((x) => x.summary.includes('secret')));

    // Only the owner may change who sees a document.
    assert.equal((await admin.agent.patch(`/api/vault/documents/${shared.id}`, { is_private: true })).status, 403);
    // Deleting the folder keeps the member's private document (now unfiled, still private).
    await admin.agent.del(`/api/vault/folders/${folder.id}`);
    const still = (await member.agent.get(`/api/vault/documents/${priv.id}`)).body;
    assert.equal(still.folder_id, null);
    assert.equal(still.is_private, true);

    // Sharing it makes it visible, logs activity and notifies.
    const nowShared = await member.agent.patch(`/api/vault/documents/${priv.id}`, { is_private: false });
    assert.equal(nowShared.status, 200);
    assert.equal((await admin.agent.get(`/api/vault/documents/${priv.id}`)).status, 200);
    assert.ok((await admin.agent.get('/api/notifications')).body.items.some((n) => n.title === 'Member shared a document'));
  });

  test('children cannot rename or delete documents others uploaded', async () => {
    const { admin, child } = await familyWithChild('Docs kids');
    const doc = (await upload(admin.agent)).body;
    const seen = (await child.agent.get(`/api/vault/documents/${doc.id}`)).body;
    assert.equal(seen.can_edit, false);
    assert.equal((await child.agent.patch(`/api/vault/documents/${doc.id}`, { name: 'lol' })).status, 403);
    assert.equal((await child.agent.del(`/api/vault/documents/${doc.id}`)).status, 403);
    const own = (await upload(child.agent, { filename: 'drawing.png' })).body;
    assert.equal((await child.agent.patch(`/api/vault/documents/${own.id}`, { name: 'My drawing' })).status, 200);
    const folder = (await admin.agent.post('/api/vault/folders', { name: 'Parents' })).body;
    assert.equal((await child.agent.del(`/api/vault/folders/${folder.id}`)).status, 403);
    assert.equal((await child.agent.patch(`/api/vault/folders/${folder.id}`, { name: 'Kids' })).status, 403);
  });

  test('a burst of uploads becomes one Wall entry and one notification', async () => {
    const { admin, member } = await familyFixture(srv, 'Docs burst');
    const folder = (await admin.agent.post('/api/vault/folders', { name: 'Receipts' })).body;
    for (let i = 0; i < 3; i++) await upload(admin.agent, { filename: `r${i}.png`, fields: { folder_id: folder.id } });
    const act = (await member.agent.get('/api/activity?module=vault')).body.filter((x) => x.verb === 'uploaded');
    assert.equal(act.length, 1);
    assert.equal(act[0].summary, 'uploaded 3 documents to Receipts');
    assert.equal(act[0].link, `/vault/docs/f/${folder.id}`);
    const n = (await member.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'vault');
    assert.equal(n.length, 1);
  });

  test('expiring documents show up and trigger a single reminder', async () => {
    const { admin, member } = await familyFixture(srv, 'Docs expiry');
    const soon = new Date(Date.now() + 10 * 864e5);
    const key = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    const doc = (await upload(admin.agent, { filename: 'passport.png', fields: { expires_on: key } })).body;
    const later = (await upload(admin.agent, { filename: 'policy.png', fields: { expires_on: '2099-01-01' } })).body;
    const overview = (await member.agent.get('/api/vault')).body;
    assert.deepEqual(overview.expiring.map((d) => d.id), [doc.id]);
    assert.ok(later.id);
    const dash = (await member.agent.get('/api/dashboard')).body.vault;
    assert.deepEqual(dash.expiring.map((d) => d.id), [doc.id]);

    assert.ok(vault.checkExpiries(srv.ctx) >= 1);
    assert.equal(vault.checkExpiries(srv.ctx), 0, 'reminders are sent once');
    const items = (await member.agent.get('/api/notifications')).body.items;
    assert.ok(items.some((n) => n.title === 'passport expires in 10 days'));
  });
});

describe('info cards (notes)', () => {
  test('secret values are masked until revealed', async () => {
    const { admin, member } = await familyFixture(srv, 'Notes A');
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'Empty' })).status, 400, 'needs fields or text');
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'x', kind: 'nope', body: 'x' })).status, 400);
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'x', fields: [{ label: '', value: 'v' }] })).status, 400);
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'x', fields: [{ label: 'Password', value: '' }] })).status, 400);

    const created = await admin.agent.post('/api/vault/notes', {
      title: 'Home Wi-Fi', kind: 'wifi', body: 'Router in the closet',
      fields: [{ label: 'Network', value: 'RiveraHome', secret: false }, { label: 'Password', value: 'hunter2', secret: true }],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.fields, [{ label: 'Network', value: 'RiveraHome', secret: false }, { label: 'Password', value: null, secret: true }]);
    assert.equal(created.body.secret_count, 1);

    const listed = (await member.agent.get('/api/vault/notes')).body[0];
    assert.equal(listed.fields[1].value, null);
    assert.ok(!JSON.stringify((await member.agent.get('/api/vault/notes')).body).includes('hunter2'), 'listing never contains secrets');
    assert.ok(!JSON.stringify((await member.agent.get(`/api/vault/notes/${listed.id}`)).body).includes('hunter2'));
    const revealed = await member.agent.get(`/api/vault/notes/${listed.id}/reveal`);
    assert.equal(revealed.body.fields[1].value, 'hunter2');
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    // Secret values are not searchable.
    assert.equal((await member.agent.get('/api/search?q=hunter2')).body.results.filter((r) => r.module === 'vault').length, 0);
    assert.equal((await member.agent.get('/api/search?q=wi-fi')).body.results.filter((r) => r.module === 'vault').length, 1);

    const upd = await member.agent.patch(`/api/vault/notes/${listed.id}`, { fields: [{ label: 'Password', value: 'correct-horse', secret: true }] });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.fields.length, 1);
    assert.equal((await member.agent.patch(`/api/vault/notes/${listed.id}`, { fields: [], body: '' })).status, 400);
    assert.equal((await member.agent.del(`/api/vault/notes/${listed.id}`)).status, 200);
    assert.equal((await admin.agent.get(`/api/vault/notes/${listed.id}`)).status, 404);
  });

  test('private cards are owner-only', async () => {
    const { admin, member, child } = await familyWithChild('Notes private');
    const n = (await admin.agent.post('/api/vault/notes', { title: 'Passports', kind: 'id', is_private: true, fields: [{ label: 'Alex', value: '5482', secret: true }] })).body;
    assert.equal(n.is_private, true);
    for (const who of [member, child]) {
      assert.equal((await who.agent.get('/api/vault/notes')).body.length, 0);
      assert.equal((await who.agent.get(`/api/vault/notes/${n.id}/reveal`)).status, 404);
      assert.equal((await who.agent.patch(`/api/vault/notes/${n.id}`, { title: 'x' })).status, 404);
      assert.equal((await who.agent.del(`/api/vault/notes/${n.id}`)).status, 404);
    }
    assert.equal((await admin.agent.get(`/api/vault/notes/${n.id}/reveal`)).body.fields[0].value, '5482');
    const act = (await member.agent.get('/api/activity?module=vault')).body;
    assert.equal(act.length, 0, 'private cards never reach the Wall');

    const shared = (await member.agent.post('/api/vault/notes', { title: 'Alarm', kind: 'code', fields: [{ label: 'Code', value: '4815', secret: true }] })).body;
    assert.equal((await child.agent.patch(`/api/vault/notes/${shared.id}`, { title: 'x' })).status, 403);
    assert.equal((await admin.agent.patch(`/api/vault/notes/${shared.id}`, { is_private: true })).status, 403, 'only the owner changes privacy');
  });
});

describe('isolation & realtime', () => {
  test("another family's ids are 404 everywhere", async () => {
    const a = await familyFixture(srv, 'Iso A');
    const b = await familyFixture(srv, 'Iso B');
    const contact = (await a.admin.agent.post('/api/vault/contacts', { name: 'Doctor' })).body;
    const folder = (await a.admin.agent.post('/api/vault/folders', { name: 'Stuff' })).body;
    const doc = (await upload(a.admin.agent, { fields: { folder_id: folder.id } })).body;
    const note = (await a.admin.agent.post('/api/vault/notes', { title: 'Wi-Fi', fields: [{ label: 'Pw', value: 'x', secret: true }] })).body;
    const B = b.admin.agent;
    for (const url of [`/api/vault/contacts/${contact.id}`, `/api/vault/folders/${folder.id}`, `/api/vault/documents/${doc.id}`,
      `/api/vault/documents/${doc.id}/file`, `/api/vault/notes/${note.id}`, `/api/vault/notes/${note.id}/reveal`]) {
      assert.equal((await B.get(url)).status, 404, url);
    }
    assert.equal((await B.patch(`/api/vault/contacts/${contact.id}`, { name: 'x' })).status, 404);
    assert.equal((await B.del(`/api/vault/contacts/${contact.id}`)).status, 404);
    assert.equal((await B.patch(`/api/vault/documents/${doc.id}`, { name: 'x' })).status, 404);
    assert.equal((await B.del(`/api/vault/documents/${doc.id}`)).status, 404);
    assert.equal((await B.del(`/api/vault/folders/${folder.id}`)).status, 404);
    assert.equal((await B.del(`/api/vault/notes/${note.id}`)).status, 404);
    // Can't move a document into another family's folder or upload into it.
    const bDoc = (await upload(B)).body;
    assert.equal((await B.patch(`/api/vault/documents/${bDoc.id}`, { folder_id: folder.id })).status, 404);
    assert.equal((await upload(B, { fields: { folder_id: folder.id } })).status, 404);
    assert.equal((await B.get('/api/vault/contacts')).body.length, 0);
    assert.equal((await B.get('/api/vault/documents')).body.length, 1);
    // The raw upload URL is not reachable for another family either.
    const files = fs.readdirSync(path.join(srv.dir, 'uploads', String(a.family.id), 'vault'));
    assert.equal((await B.get(`/uploads/${a.family.id}/vault/${files[0]}`)).status, 404);
    // X-Family-Id of a family you are not in is rejected.
    const pinned = b.admin.agent.tab();
    pinned.familyId = a.family.id;
    assert.equal((await pinned.get('/api/vault/contacts')).status, 403);
  });

  test('mutations broadcast vault.* events; private ones only reach the owner', async () => {
    const { admin, member } = await familyFixture(srv, 'Live');
    const memberStream = await collectEvents(member.agent, { until: (e) => e.type === 'vault.note.deleted', timeoutMs: 4000 });
    const adminStream = await collectEvents(admin.agent, { until: (e) => e.type === 'vault.note.deleted', timeoutMs: 4000 });

    const c = (await admin.agent.post('/api/vault/contacts', { name: 'Plumber' })).body;
    await admin.agent.patch(`/api/vault/contacts/${c.id}`, { role: 'Plumber' });
    await admin.agent.del(`/api/vault/contacts/${c.id}`);
    const f = (await admin.agent.post('/api/vault/folders', { name: 'Home' })).body;
    const privDoc = (await upload(admin.agent, { fields: { is_private: '1' } })).body;
    const sharedDoc = (await upload(admin.agent, { fields: { folder_id: f.id } })).body;
    await admin.agent.patch(`/api/vault/documents/${sharedDoc.id}`, { is_private: true });
    // (create both before deleting either: SQLite may reuse a deleted rowid)
    const privNote = (await admin.agent.post('/api/vault/notes', { title: 'Mine', is_private: true, body: 'x' })).body;
    const n = (await admin.agent.post('/api/vault/notes', { title: 'Ours', body: 'y' })).body;
    await admin.agent.del(`/api/vault/notes/${privNote.id}`);
    await admin.agent.del(`/api/vault/notes/${n.id}`);

    const memberTypes = (await memberStream.events).filter((e) => e.type.startsWith('vault.'));
    const adminTypes = (await adminStream.events).filter((e) => e.type.startsWith('vault.'));
    const m = memberTypes.map((e) => e.type);
    for (const t of ['vault.contact.created', 'vault.contact.updated', 'vault.contact.deleted', 'vault.folder.created', 'vault.document.created',
      'vault.document.hidden', 'vault.note.created', 'vault.note.deleted']) assert.ok(m.includes(t), `member got ${t}`);
    // Private items: the member only ever hears about the shared doc + the "hidden" notice.
    assert.ok(!memberTypes.some((e) => e.payload?.id === privDoc.id && e.type.startsWith('vault.document')), 'no events about a private doc');
    assert.ok(!memberTypes.some((e) => e.payload?.id === privNote.id && e.type.startsWith('vault.note')), 'no events about a private note');
    assert.equal(memberTypes.filter((e) => e.type === 'vault.document.created').length, 1);
    // The owner hears about everything.
    assert.ok(adminTypes.some((e) => e.type === 'vault.document.created' && e.payload.id === privDoc.id));
    assert.ok(adminTypes.some((e) => e.type === 'vault.note.created' && e.payload.id === privNote.id));
    // Payloads carry ids only (no content).
    assert.deepEqual(Object.keys(memberTypes[0].payload), ['id']);
  });
});

describe('seed, search & dashboard', () => {
  test('seed creates rich demo content with private items', async () => {
    const owner = await registerUser(srv, { name: 'Seed Alex', family_name: 'Seedy' });
    const fam = (await owner.agent.get('/api/family')).body;
    const other = await registerUser(srv, { name: 'Seed Sam' });
    await other.agent.post('/api/families/join', { invite_code: fam.invite_code });
    const u = (id) => srv.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const users = { alex: u(owner.user.id), sam: u(other.user.id), mia: u(owner.user.id), leo: u(other.user.id) };
    const out = await vault.seed(srv.ctx, { familyId: fam.id, users, userList: Object.values(users) });
    assert.ok(out.contacts >= 10);
    assert.ok(out.folders >= 3);
    assert.ok(out.notes >= 5);

    const contacts = (await owner.agent.get('/api/vault/contacts')).body;
    assert.ok(contacts.length >= 10);
    assert.ok(contacts.filter((c) => c.emergency).length >= 3);
    const alexDocs = (await owner.agent.get('/api/vault/documents')).body;
    const samDocs = (await other.agent.get('/api/vault/documents')).body;
    assert.ok(alexDocs.some((d) => d.is_private && d.name.startsWith('Passport – Alex')));
    assert.ok(!samDocs.some((d) => d.name.startsWith('Passport – Alex')), "Sam can't see Alex's private passport");
    assert.ok(samDocs.some((d) => d.name.startsWith('Passport – Sam')));
    // Generated files are real and servable.
    const pdf = alexDocs.find((d) => d.ext === 'pdf');
    const res = await fetch(srv.base + pdf.url, { headers: { cookie: owner.agent.cookie } });
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const notes = (await other.agent.get('/api/vault/notes')).body;
    assert.ok(notes.some((n) => n.title === 'Home Wi-Fi' && n.fields.some((f) => f.secret && f.value === null)));
    assert.ok(!notes.some((n) => n.title === 'Passport numbers'), "Alex's private card is hidden from Sam");

    const results = (await owner.agent.get('/api/search?q=patel')).body.results.filter((r) => r.module === 'vault');
    assert.equal(results[0].title, 'Dr. Priya Patel');
    assert.match(results[0].link, /^\/vault\/contacts\/\d+$/);
    const dash = (await owner.agent.get('/api/dashboard')).body.vault;
    assert.ok(dash.emergency.length >= 3);
    assert.ok(dash.expiring.some((d) => d.name === 'Passport – Alex'));
    assert.ok(!(await other.agent.get('/api/dashboard')).body.vault.expiring.some((d) => d.name === 'Passport – Alex'));
  });
});

describe('wall & notification hygiene', () => {
  const vaultActivity = async (agent) => (await agent.get('/api/activity?module=vault')).body;
  const vaultNotes = async (agent) => (await agent.get('/api/notifications')).body.items.filter((n) => n.module === 'vault');

  test('making a shared document private scrubs its Wall entry and other people’s notifications', async () => {
    const { admin, member } = await familyFixture(srv, 'Hygiene A');
    const doc = (await upload(admin.agent, { filename: 'Divorce lawyer letter.pdf', type: 'application/pdf' })).body;
    assert.ok((await vaultActivity(member.agent)).some((a) => a.summary.includes('Divorce lawyer letter')));
    assert.equal((await vaultNotes(member.agent)).length, 1);

    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'notification.removed', timeoutMs: 3000 });
    const res = await admin.agent.patch(`/api/vault/documents/${doc.id}`, { visibility: 'private' });
    assert.equal(res.status, 200);
    assert.equal(res.body.visibility, 'private');
    const events = await stream.events;
    assert.ok(events.some((e) => e.type === 'activity.removed'), 'Wall told to refresh');
    assert.ok(events.some((e) => e.type === 'notification.removed'), 'bell told to refresh');
    assert.ok(events.some((e) => e.type === 'vault.document.hidden'));
    assert.ok(!(await vaultActivity(member.agent)).some((a) => a.summary.includes('Divorce')));
    assert.ok(!(await vaultActivity(admin.agent)).some((a) => a.summary.includes('Divorce')));
    assert.equal((await vaultNotes(member.agent)).length, 0);
    const raw = srv.db.prepare("SELECT COUNT(*) n FROM notifications WHERE link = ?").get(`/vault/docs/d/${doc.id}`).n;
    assert.equal(raw, 0);
  });

  test('coalesced upload entries are recounted when a document leaves them', async () => {
    const { admin, member } = await familyFixture(srv, 'Hygiene burst');
    const folder = (await admin.agent.post('/api/vault/folders', { name: 'Legal' })).body;
    const d1 = (await upload(admin.agent, { filename: 'Secret one.png', fields: { folder_id: folder.id } })).body;
    const d2 = (await upload(admin.agent, { filename: 'Lease.png', fields: { folder_id: folder.id } })).body;
    const d3 = (await upload(admin.agent, { filename: 'Deed.png', fields: { folder_id: folder.id } })).body;
    let entry = (await vaultActivity(member.agent)).find((a) => a.verb === 'uploaded');
    assert.equal(entry.summary, 'uploaded 3 documents to Legal');

    // The anchor (first) document goes private → 2 left, re-anchored.
    await admin.agent.patch(`/api/vault/documents/${d1.id}`, { is_private: true });
    entry = (await vaultActivity(member.agent)).find((a) => a.verb === 'uploaded');
    assert.equal(entry.summary, 'uploaded 2 documents to Legal');
    assert.notEqual(entry.entity_id, d1.id);
    // Deleting another → a single-document entry that names it.
    await admin.agent.del(`/api/vault/documents/${d3.id}`);
    entry = (await vaultActivity(member.agent)).find((a) => a.verb === 'uploaded');
    assert.equal(entry.summary, 'uploaded Lease to Legal');
    assert.equal(entry.link, `/vault/docs/d/${d2.id}`);
    // Last one hidden from children → entry disappears entirely.
    await admin.agent.patch(`/api/vault/documents/${d2.id}`, { visibility: 'adults' });
    assert.equal((await vaultActivity(member.agent)).filter((a) => a.verb === 'uploaded').length, 0);
    assert.ok(!(await vaultActivity(member.agent)).some((a) => /Secret one/.test(a.summary)));
  });

  test('deleting items removes their Wall entries; hidden info cards leave the Wall', async () => {
    const { admin, member } = await familyFixture(srv, 'Hygiene delete');
    const c = (await admin.agent.post('/api/vault/contacts', { name: 'Old babysitter', emergency: true })).body;
    const n = (await admin.agent.post('/api/vault/notes', { title: 'Safe combination', kind: 'code', fields: [{ label: 'Code', value: '1234', secret: true }] })).body;
    assert.equal((await vaultActivity(member.agent)).length, 2);
    await admin.agent.patch(`/api/vault/notes/${n.id}`, { visibility: 'private' });
    assert.ok(!(await vaultActivity(member.agent)).some((a) => a.summary.includes('Safe combination')));
    await admin.agent.del(`/api/vault/contacts/${c.id}`);
    assert.equal((await vaultActivity(member.agent)).length, 0);
    assert.equal((await vaultNotes(member.agent)).length, 0, 'emergency-contact notification removed');
  });
});

describe('adults-only visibility', () => {
  test('children cannot list, reveal, search or hear about adults-only cards and documents', async () => {
    const { admin, member, child } = await familyWithChild('Adults only');
    const childStream = await collectEvents(child.agent, { until: (e) => e.type === 'vault.contact.created', timeoutMs: 4000 });
    const card = await admin.agent.post('/api/vault/notes', { title: 'Alarm codes', kind: 'code', visibility: 'adults', fields: [{ label: 'Alarm', value: '4815', secret: true }] });
    assert.equal(card.status, 201);
    assert.equal(card.body.visibility, 'adults');
    const doc = (await upload(admin.agent, { filename: 'Insurance policy.pdf', type: 'application/pdf', fields: { visibility: 'adults', expires_on: '2099-01-01' } })).body;
    assert.equal(doc.visibility, 'adults');
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'x', body: 'y', visibility: 'everyone' })).status, 400);
    await admin.agent.post('/api/vault/contacts', { name: 'Marker' }); // ends the child's stream

    // Adults see them.
    assert.equal((await member.agent.get(`/api/vault/notes/${card.body.id}/reveal`)).body.fields[0].value, '4815');
    assert.equal((await member.agent.get(`/api/vault/documents/${doc.id}`)).status, 200);
    // Children don't — anywhere.
    assert.equal((await child.agent.get('/api/vault/notes')).body.length, 0);
    assert.equal((await child.agent.get(`/api/vault/notes/${card.body.id}/reveal`)).status, 404);
    assert.equal((await child.agent.get(`/api/vault/documents/${doc.id}`)).status, 404);
    assert.equal((await fetch(srv.base + doc.url, { headers: { cookie: child.agent.cookie } })).status, 404);
    assert.equal((await child.agent.get('/api/vault/documents')).body.length, 0);
    assert.equal((await child.agent.get('/api/vault')).body.notes, 0);
    assert.equal((await child.agent.get('/api/search?q=alarm')).body.results.filter((r) => r.module === 'vault').length, 0);
    assert.equal((await child.agent.get('/api/search?q=insurance')).body.results.filter((r) => r.module === 'vault').length, 0);
    assert.equal((await member.agent.get('/api/search?q=alarm')).body.results.filter((r) => r.module === 'vault').length, 1);
    const events = await childStream.events;
    assert.ok(!events.some((e) => e.type.startsWith('vault.note') || e.type.startsWith('vault.document')), 'no live events for adults-only items');
    // No Wall entry for adults-only items (children read the Wall too).
    assert.ok(!(await child.agent.get('/api/activity?module=vault')).body.some((a) => /Alarm|Insurance/.test(a.summary)));
  });
});

describe('audience shrinking within restricted visibilities', () => {
  test('adults → only me removes other adults’ expiry and "shared" notifications (documents)', async () => {
    const { admin, member } = await familyFixture(srv, 'Shrink docs');
    const soon = new Date(Date.now() + 10 * 864e5);
    const key = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    const doc = (await upload(admin.agent, { filename: 'Custody papers.png', fields: { expires_on: key } })).body;
    const link = `/vault/docs/d/${doc.id}`;
    const memberLinks = async () => (await member.agent.get('/api/notifications')).body.items.filter((n) => n.link === link).map((n) => n.title);
    assert.deepEqual(await memberLinks(), ['Admin shared a document']);

    await admin.agent.patch(`/api/vault/documents/${doc.id}`, { visibility: 'adults' });
    assert.deepEqual(await memberLinks(), ['Admin shared a document'], 'the member is an adult: still in the audience');
    vault.checkExpiries(srv.ctx);
    assert.equal((await memberLinks()).length, 2);
    assert.ok((await memberLinks()).includes('Custody papers expires in 10 days'));

    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'notification.removed', timeoutMs: 3000 });
    await admin.agent.patch(`/api/vault/documents/${doc.id}`, { visibility: 'private' });
    assert.ok((await stream.events).some((e) => e.type === 'notification.removed'));
    assert.deepEqual(await memberLinks(), [], 'no notifications left for someone who can no longer see it');
    const own = (await admin.agent.get('/api/notifications')).body.items.filter((n) => n.link === link);
    assert.ok(own.some((n) => n.title.includes('expires in 10 days')), "the owner's own reminder is kept");
    assert.equal((await member.agent.get(`/api/vault/documents/${doc.id}`)).status, 404);
  });

  test('adults → only me hides an info card and drops notifications about it', async () => {
    const { admin, member } = await familyFixture(srv, 'Shrink notes');
    const n = (await admin.agent.post('/api/vault/notes', { title: 'Safe', kind: 'code', visibility: 'adults', fields: [{ label: 'Code', value: '99', secret: true }] })).body;
    // Any notification about the card for the member must not survive the shrink.
    srv.ctx.notify({ familyId: n.family_id, userIds: [member.user.id], module: 'vault', title: 'Card updated', link: `/vault/notes/${n.id}` });
    const stream = await collectEvents(member.agent, { until: (e) => e.type === 'vault.note.hidden', timeoutMs: 3000 });
    await admin.agent.patch(`/api/vault/notes/${n.id}`, { visibility: 'private' });
    assert.ok((await stream.events).some((e) => e.type === 'vault.note.hidden'));
    assert.equal((await member.agent.get(`/api/vault/notes/${n.id}/reveal`)).status, 404);
    assert.equal((await member.agent.get('/api/notifications')).body.items.filter((x) => x.link === `/vault/notes/${n.id}`).length, 0);
  });

  test('children cannot make items adults-only', async () => {
    const { child } = await familyWithChild('Kid adults');
    assert.equal((await child.agent.post('/api/vault/notes', { title: 'x', body: 'y', visibility: 'adults' })).status, 403);
    assert.equal((await upload(child.agent, { fields: { visibility: 'adults' } })).status, 403);
    const note = (await child.agent.post('/api/vault/notes', { title: 'Mine', body: 'y' })).body;
    assert.equal((await child.agent.patch(`/api/vault/notes/${note.id}`, { visibility: 'adults' })).status, 403);
    const doc = (await upload(child.agent)).body;
    assert.equal((await child.agent.patch(`/api/vault/documents/${doc.id}`, { visibility: 'adults' })).status, 403);
    assert.equal((await child.agent.patch(`/api/vault/documents/${doc.id}`, { visibility: 'private' })).status, 200);
  });
});
