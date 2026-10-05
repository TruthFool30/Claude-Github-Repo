// Encryption at rest for the document vault: files, document notes and info cards are sealed.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, familyFixture } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { seedDemo } from '../src/seed.js';
import { vaultPath } from '../src/modules/vault/files.js';
import { makeSecretBox } from '../src/secretbox.js';

const SECRET_FILE = Buffer.from('Passport no. 548211832 — top secret scan contents');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const fileOf = (s, doc) => {
  const row = s.db.prepare('SELECT family_id, storage_key FROM vault_documents WHERE id = ?').get(doc.id);
  return vaultPath(s.ctx.uploadDir, row.family_id, row.storage_key);
};
const get = (s, agent, url, headers = {}) => fetch(s.base + url, { headers: { cookie: agent.cookie, ...headers } });
/** Plain node:http GET (fetch adds Cache-Control: no-cache to conditional requests, which defeats 304s). */
const rawGet = (s, agent, url, headers) => new Promise((resolve, reject) => {
  http.get(s.base + url, { headers: { cookie: agent.cookie, ...headers } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
});
const uploadText = (agent, fields = {}) =>
  agent.upload('/api/vault/documents', { file: SECRET_FILE, filename: 'passport.txt', type: 'text/plain', fields });

describe('documents', () => {
  test('files and notes are sealed on disk, served decrypted with the same headers', async () => {
    const { admin } = await familyFixture(srv, 'Enc docs');
    const up = await uploadText(admin.agent, { notes: 'Kept in the blue folder at Grandma Rosa’s' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.notes, 'Kept in the blue folder at Grandma Rosa’s');

    const raw = fs.readFileSync(fileOf(srv, up.body));
    assert.ok(srv.ctx.box.isSealedBuffer(raw), 'file on disk is sealed');
    assert.ok(!raw.includes('548211832') && !raw.includes('top secret'), 'no plaintext on disk');
    const familyDir = path.join(srv.dir, 'uploads', String(up.body.family_id));
    assert.deepEqual(fs.readdirSync(familyDir), ['vault'], 'no plaintext temp copy next to the vault folder');

    const row = srv.db.prepare('SELECT notes, name FROM vault_documents WHERE id = ?').get(up.body.id);
    assert.ok(srv.ctx.box.isSealed(row.notes) && !row.notes.includes('Grandma'));
    assert.equal(row.name, 'passport', 'names stay plaintext');

    const res = await get(srv, admin.agent, up.body.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^inline;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-cache');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), SECRET_FILE);

    // Revalidation still works without re-sending the file.
    const again = await rawGet(srv, admin.agent, up.body.url, { 'if-none-match': res.headers.get('etag') });
    assert.equal(again.statusCode, 304);

    // Listing filter and PATCH see the decrypted notes; PATCH re-seals.
    assert.deepEqual((await admin.agent.get('/api/vault/documents?q=blue folder')).body.map((d) => d.id), [up.body.id]);
    assert.deepEqual((await admin.agent.get('/api/vault/documents?q=PASSPORT')).body.map((d) => d.id), [up.body.id]);
    assert.deepEqual((await admin.agent.get('/api/vault/documents?q=nothing-like-this')).body, []);
    const patched = await admin.agent.patch(`/api/vault/documents/${up.body.id}`, { notes: 'Moved to the safe' });
    assert.equal(patched.body.notes, 'Moved to the safe');
    const after = srv.db.prepare('SELECT notes FROM vault_documents WHERE id = ?').get(up.body.id).notes;
    assert.ok(srv.ctx.box.isSealed(after) && !after.includes('safe'));
    assert.equal((await admin.agent.patch(`/api/vault/documents/${up.body.id}`, { notes: null })).body.notes, null);
  });

  test('byte ranges: 206 with the right slice, 416 when unsatisfiable, full file otherwise', async () => {
    const { admin } = await familyFixture(srv, 'Enc ranges');
    const doc = (await uploadText(admin.agent)).body;
    const len = SECRET_FILE.length;

    const part = await get(srv, admin.agent, doc.url, { range: 'bytes=4-9' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 4-9/${len}`);
    assert.equal(part.headers.get('content-length'), '6');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), SECRET_FILE.subarray(4, 10));

    const tail = await get(srv, admin.agent, doc.url, { range: 'bytes=-5', 'accept-encoding': 'gzip' });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-encoding'), null, 'partial content is never compressed');
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), SECRET_FILE.subarray(len - 5));

    const open = await get(srv, admin.agent, doc.url, { range: `bytes=${len - 3}-` });
    assert.equal(open.headers.get('content-range'), `bytes ${len - 3}-${len - 1}/${len}`);
    await open.arrayBuffer();

    const bad = await get(srv, admin.agent, doc.url, { range: `bytes=${len + 10}-` });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${len}`);
    await bad.arrayBuffer();

    const stale = await get(srv, admin.agent, doc.url, { range: 'bytes=0-1', 'if-range': '"something-else"' });
    assert.equal(stale.status, 200, 'If-Range mismatch → whole file');
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), SECRET_FILE);
    const fresh = await get(srv, admin.agent, doc.url, { range: 'bytes=0-1', 'if-range': part.headers.get('etag') });
    assert.equal(fresh.status, 206);
    await fresh.arrayBuffer();

    const multi = await get(srv, admin.agent, doc.url, { range: 'bytes=0-1,5-6' });
    assert.equal(multi.status, 200, 'multiple ranges → whole file');
    assert.deepEqual(Buffer.from(await multi.arrayBuffer()), SECRET_FILE);
  });

  test('already-sealed input is refused (no decryption oracle)', async () => {
    const { admin } = await familyFixture(srv, 'Enc oracle');
    const stolenFile = srv.ctx.box.sealBuffer(Buffer.from('another family’s file'));
    const up = await admin.agent.upload('/api/vault/documents', { file: stolenFile, filename: 'x.txt', type: 'text/plain' });
    assert.equal(up.status, 400);
    const stolenText = srv.ctx.box.seal('another family’s secret');
    assert.equal((await uploadText(admin.agent, { notes: stolenText })).status, 400);
    const doc = (await uploadText(admin.agent)).body;
    assert.equal((await admin.agent.patch(`/api/vault/documents/${doc.id}`, { notes: stolenText })).status, 400);
    assert.equal((await admin.agent.post('/api/vault/notes', { title: 'x', body: stolenText })).status, 400);
  });
});

describe('damaged data', () => {
  test('304s skip decryption; one undecryptable item does not break the lists', async () => {
    const { admin } = await familyFixture(srv, 'Enc damaged');
    const doc = (await uploadText(admin.agent, { notes: 'fine' })).body;
    const good = (await admin.agent.post('/api/vault/notes', { title: 'Good', body: 'readable' })).body;
    const bad = (await admin.agent.post('/api/vault/notes', { title: 'Bad', body: 'soon broken' })).body;
    const etag = (await get(srv, admin.agent, doc.url)).headers.get('etag');

    // Corrupt the stored file: a conditional request still answers 304 (nothing is decrypted)…
    const abs = fileOf(srv, doc);
    const sealed = fs.readFileSync(abs);
    sealed[sealed.length - 1] ^= 1;
    fs.writeFileSync(abs, sealed);
    assert.equal((await rawGet(srv, admin.agent, doc.url, { 'if-none-match': etag })).statusCode, 304);
    const failed = await get(srv, admin.agent, doc.url);
    assert.equal(failed.status, 500, '…while a real download fails the GCM check');
    assert.match((await failed.json()).error, /can't be decrypted/, 'with a clear message instead of a generic one');

    const otherKey = makeSecretBox(crypto.randomBytes(32));
    srv.db.prepare('UPDATE vault_notes SET body = ? WHERE id = ?').run(otherKey.seal('x'), bad.id);
    srv.db.prepare('UPDATE vault_documents SET notes = ? WHERE id = ?').run(otherKey.seal('x'), doc.id);
    const notes = await admin.agent.get('/api/vault/notes');
    assert.equal(notes.status, 200);
    assert.equal(notes.body.find((n) => n.id === good.id).body, 'readable');
    const broken = notes.body.find((n) => n.id === bad.id);
    assert.equal(broken.unreadable, true);
    assert.equal(broken.body, null);
    const docs = await admin.agent.get('/api/vault/documents?q=passport');
    assert.equal(docs.status, 200);
    assert.equal(docs.body[0].unreadable, true);
    assert.equal((await admin.agent.get('/api/vault')).status, 200);

    // Editing an unreadable item never overwrites its ciphertext; rename/move/visibility still work.
    const stored = () => [
      srv.db.prepare('SELECT notes FROM vault_documents WHERE id = ?').get(doc.id).notes,
      srv.db.prepare('SELECT fields, body FROM vault_notes WHERE id = ?').get(bad.id),
    ];
    const ciphertext = stored();
    const folder = (await admin.agent.post('/api/vault/folders', { name: 'Damaged' })).body;
    const docEdit = await admin.agent.patch(`/api/vault/documents/${doc.id}`, { name: 'Renamed', folder_id: folder.id, expires_on: null, notes: '', visibility: 'adults' });
    assert.equal(docEdit.status, 200, JSON.stringify(docEdit.body));
    assert.equal(docEdit.body.name, 'Renamed');
    assert.equal(docEdit.body.visibility, 'adults');
    assert.equal(docEdit.body.unreadable, true);
    assert.equal((await admin.agent.patch(`/api/vault/documents/${doc.id}`, { notes: 'new text' })).status, 409);
    assert.equal((await admin.agent.patch(`/api/vault/notes/${bad.id}`, { title: 'Bad renamed' })).status, 200, 'title-only edit');
    assert.equal((await admin.agent.patch(`/api/vault/notes/${bad.id}`, { visibility: 'private' })).status, 200, 'visibility-only edit');
    const cardEdit = await admin.agent.patch(`/api/vault/notes/${bad.id}`, { title: 'Bad again', kind: 'code', fields: [], body: '' });
    assert.equal(cardEdit.status, 200, 'the unchanged placeholders are ignored');
    assert.equal(cardEdit.body.unreadable, true);
    assert.equal((await admin.agent.patch(`/api/vault/notes/${bad.id}`, { body: 'new' })).status, 409);
    assert.equal((await admin.agent.patch(`/api/vault/notes/${bad.id}`, { fields: [{ label: 'a', value: 'b' }] })).status, 409);
    assert.deepEqual(stored(), ciphertext, 'ciphertext byte-identical');

    fs.rmSync(abs);
    assert.equal((await rawGet(srv, admin.agent, doc.url, { 'if-none-match': etag })).statusCode, 404, 'a missing file is a 404, not a 304');
  });
});

describe('info cards', () => {
  test('fields and body are sealed; masking, reveal and search are unchanged', async () => {
    const { admin, member } = await familyFixture(srv, 'Enc cards');
    const created = await admin.agent.post('/api/vault/notes', {
      title: 'Router login', kind: 'wifi', body: 'Router sits behind the bookshelf',
      fields: [{ label: 'Network', value: 'Hearthnet' }, { label: 'Password', value: 'correct-horse-77', secret: true }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const note = created.body;
    assert.equal(note.fields[1].value, null, 'secret is masked in the create response');

    const row = srv.db.prepare('SELECT * FROM vault_notes WHERE id = ?').get(note.id);
    for (const leak of ['correct-horse-77', 'Hearthnet', 'bookshelf', 'Password']) {
      assert.ok(!JSON.stringify(row).includes(leak), `${leak} is not stored in plaintext`);
    }
    assert.equal(row.title, 'Router login', 'title stays plaintext');
    assert.equal(row.kind, 'wifi');

    const listed = (await member.agent.get('/api/vault/notes')).body.find((n) => n.id === note.id);
    assert.deepEqual(listed.fields, [{ label: 'Network', value: 'Hearthnet', secret: false }, { label: 'Password', value: null, secret: true }]);
    assert.equal(listed.body, 'Router sits behind the bookshelf');
    assert.equal(listed.secret_count, 1);
    const one = (await member.agent.get(`/api/vault/notes/${note.id}`)).body;
    assert.equal(one.fields[1].value, null);
    const revealed = await member.agent.get(`/api/vault/notes/${note.id}/reveal`);
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    assert.equal(revealed.body.fields[1].value, 'correct-horse-77');

    const hits = (await member.agent.get('/api/search?q=router')).body.results.filter((r) => r.link === `/vault/notes/${note.id}`);
    assert.equal(hits.length, 1, 'cards are still found by title');
    assert.equal((await member.agent.get('/api/search?q=correct-horse')).body.results.filter((r) => r.module === 'vault').length, 0, 'secrets never searchable');

    // Partial PATCH keeps the sealed fields and re-seals the new body.
    const patched = await admin.agent.patch(`/api/vault/notes/${note.id}`, { body: 'Moved to the attic' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.fields.length, 2);
    assert.equal(patched.body.body, 'Moved to the attic');
    const after = srv.db.prepare('SELECT fields, body FROM vault_notes WHERE id = ?').get(note.id);
    assert.ok(srv.ctx.box.isSealed(after.fields) && srv.ctx.box.isSealed(after.body) && !after.body.includes('attic'));
    // Clearing the body when fields remain is fine; clearing everything is still refused.
    assert.equal((await admin.agent.patch(`/api/vault/notes/${note.id}`, { body: '' })).status, 200);
    assert.equal((await admin.agent.patch(`/api/vault/notes/${note.id}`, { fields: [] })).status, 400);
  });

  test('the demo seed stores sealed cards, notes and files', async () => {
    const s = await startServer();
    try {
      const { familyId } = await seedDemo(s.ctx, s.app.locals.modules, { log: () => {} });
      const notes = s.db.prepare('SELECT fields, body FROM vault_notes WHERE family_id = ?').all(familyId);
      assert.ok(notes.length > 0 && notes.every((n) => s.ctx.box.isSealed(n.fields) && (n.body === null || s.ctx.box.isSealed(n.body))));
      const docs = s.db.prepare('SELECT id, notes FROM vault_documents WHERE family_id = ?').all(familyId);
      assert.ok(docs.some((d) => d.notes) && docs.every((d) => d.notes === null || s.ctx.box.isSealed(d.notes)));
      for (const d of docs) assert.ok(s.ctx.box.isSealedBuffer(fs.readFileSync(fileOf(s, d))));
    } finally {
      await s.close();
    }
  });
});

describe('startup', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-enc-'));
  const paths = (dir) => ({ dbPath: path.join(dir, 'hearth.db'), uploadDir: path.join(dir, 'uploads') });
  const boot = (dir, extra = {}) => createApp({ ...paths(dir), clientDist: path.join(dir, 'none'), ...extra });

  test('legacy plaintext cards, notes and files are sealed once on restart', async () => {
    const dir = tmp();
    let s;
    try {
      s = await startServer(paths(dir));
      const { admin } = await familyFixture(s, 'Legacy');
      const doc = (await uploadText(admin.agent)).body;
      const note = (await admin.agent.post('/api/vault/notes', { title: 'Old card', fields: [{ label: 'PIN', value: '0000', secret: true }] })).body;
      const abs = fileOf(s, doc);
      // Rewind to how a pre-encryption Hearth stored them.
      s.db.prepare('UPDATE vault_notes SET fields = ?, body = ? WHERE id = ?')
        .run(JSON.stringify([{ label: 'PIN', value: '0000', secret: true }]), 'legacy body text', note.id);
      s.db.prepare('UPDATE vault_documents SET notes = ? WHERE id = ?').run('legacy doc note', doc.id);
      fs.writeFileSync(abs, SECRET_FILE);
      // A document whose file went missing must not stop the migration.
      s.db.prepare(`INSERT INTO vault_documents (family_id, name, original_name, storage_key, owner_id, notes)
                    VALUES (?, 'Lost', 'lost.pdf', 'aaaaaaaaaaaaaaaaaaaaaaaa.pdf', ?, 'lost note')`).run(doc.family_id, admin.user.id);
      // An unreferenced (orphan) plaintext file in the vault folder is sealed too.
      const orphan = path.join(path.dirname(abs), 'bbbbbbbbbbbbbbbbbbbbbbbb.txt');
      fs.writeFileSync(orphan, 'orphan plaintext');
      // Plaintext still reads fine before the migration runs.
      assert.deepEqual(Buffer.from(await (await get(s, admin.agent, doc.url)).arrayBuffer()), SECRET_FILE);
      const cookie = admin.agent.cookie;
      await s.close();

      s = await startServer(paths(dir));
      const raw = s.db.prepare('SELECT fields, body FROM vault_notes WHERE id = ?').get(note.id);
      assert.ok(s.ctx.box.isSealed(raw.fields) && s.ctx.box.isSealed(raw.body) && !raw.fields.includes('0000'));
      const docNotes = s.db.prepare('SELECT notes FROM vault_documents WHERE family_id = ? ORDER BY id').all(doc.family_id).map((d) => d.notes);
      assert.ok(docNotes.every((n) => s.ctx.box.isSealed(n)));
      const sealedFile = fs.readFileSync(abs);
      assert.ok(s.ctx.box.isSealedBuffer(sealedFile) && !sealedFile.includes('548211832'));
      assert.ok(s.ctx.box.isSealedBuffer(fs.readFileSync(orphan)), 'orphan file sealed');
      assert.deepEqual(fs.readdirSync(path.dirname(abs)).sort(), [path.basename(abs), path.basename(orphan)].sort(), 'no temp files left behind');
      assert.equal(s.db.prepare("SELECT 1 FROM app_meta WHERE key = 'vacuum_pending'").get(), undefined);
      for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('hearth.db'))) {
        const bytes = fs.readFileSync(path.join(dir, f));
        assert.ok(!bytes.includes('legacy body text') && !bytes.includes('legacy doc note'), `no plaintext left in ${f}`);
      }

      const a = s.agent();
      a.cookie = cookie;
      assert.deepEqual(Buffer.from(await (await get(s, a, doc.url)).arrayBuffer()), SECRET_FILE);
      assert.equal((await a.get(`/api/vault/documents/${doc.id}`)).body.notes, 'legacy doc note');
      assert.equal((await a.get(`/api/vault/notes/${note.id}/reveal`)).body.fields[0].value, '0000');
      assert.equal((await a.get(`/api/vault/notes/${note.id}`)).body.body, 'legacy body text');
      await s.close();

      // A second run changes nothing.
      s = await startServer(paths(dir));
      assert.deepEqual(s.db.prepare('SELECT fields, body FROM vault_notes WHERE id = ?').get(note.id), raw);
      assert.deepEqual(fs.readFileSync(abs), sealedFile);
    } finally {
      await s?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a crash between sealing and VACUUM is scrubbed on the next start', async () => {
    const dir = tmp();
    let s;
    try {
      s = await startServer(paths(dir));
      const { admin } = await familyFixture(s, 'Crash');
      const note = (await admin.agent.post('/api/vault/notes', { title: 'Crash card', body: 'x' })).body;
      const plain = `OLDBODY888 ${'old plaintext that must not survive '.repeat(250)}`;
      s.db.prepare('UPDATE vault_notes SET body = ? WHERE id = ?').run(plain, note.id);
      const { box } = s.ctx;
      await s.close();
      // Simulate the crash window: the sealing transaction committed (flag set), VACUUM never ran.
      // (A short sealed value, so the freed pages holding the old plaintext aren't simply reused.)
      const db = new DatabaseSync(paths(dir).dbPath);
      db.exec('BEGIN');
      db.prepare('UPDATE vault_notes SET body = ? WHERE id = ?').run(box.seal('short'), note.id);
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('vacuum_pending', 'x')").run();
      db.exec('COMMIT');
      db.close();
      const leftovers = () => fs.readdirSync(dir).filter((f) => f.startsWith('hearth.db') && fs.readFileSync(path.join(dir, f)).includes('OLDBODY888'));
      assert.ok(leftovers().length > 0, 'precondition: old plaintext still in the database file');

      s = await startServer(paths(dir));
      assert.deepEqual(leftovers(), [], 'plaintext scrubbed');
      assert.equal(s.db.prepare("SELECT 1 FROM app_meta WHERE key = 'vacuum_pending'").get(), undefined, 'flag cleared after VACUUM');
    } finally {
      await s?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a wrong key refuses to start', () => {
    const dir = tmp();
    const saved = process.env.HEARTH_ENCRYPTION_KEY;
    try {
      boot(dir).locals.close();
      const keyFile = path.join(dir, 'hearth.key');
      const original = fs.readFileSync(keyFile, 'utf8');
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'));
      assert.throws(() => boot(dir), /encryption key doesn't match this database.*Restore the original key/);
      process.env.HEARTH_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyFile, original);
      assert.throws(() => boot(dir), /doesn't match this database \(HEARTH_ENCRYPTION_KEY\)/, 'env key wins and is checked too');
      delete process.env.HEARTH_ENCRYPTION_KEY;
      boot(dir).locals.close(); // the original key still works
    } finally {
      if (saved === undefined) delete process.env.HEARTH_ENCRYPTION_KEY;
      else process.env.HEARTH_ENCRYPTION_KEY = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing key file for a database with encrypted data refuses to start (no new key)', () => {
    const dir = tmp();
    try {
      const custom = path.join(dir, 'secrets', 'vault.key');
      boot(dir, { keyFile: custom }).locals.close();
      assert.ok(fs.existsSync(custom), 'keyFile option is honoured');
      fs.rmSync(custom);
      assert.throws(() => boot(dir, { keyFile: custom }), /key file .*vault\.key is missing/);
      assert.ok(!fs.existsSync(custom), 'no replacement key was generated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
