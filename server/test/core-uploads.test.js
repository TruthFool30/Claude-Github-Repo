import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { startServer, familyFixture, PNG_1X1 } from './helpers.js';
import { modules as realModules } from '../src/modules/index.js';

const files = {
  name: 'files',
  migrations: [],
  router(ctx) {
    const r = Router();
    r.post('/', ctx.upload.single('file'), (req, res) => res.status(201).json({ url: req.file.url, size: req.file.size }));
    return r;
  },
};

let srv;
before(async () => { srv = await startServer({ modules: [...realModules, files] }); });
after(() => srv.close());

describe('uploads', () => {
  test('module upload is stored per family and only served to members', async () => {
    const a = await familyFixture(srv, 'A');
    const b = await familyFixture(srv, 'B');
    const up = await a.admin.agent.upload('/api/files', { file: PNG_1X1, filename: 'dot.png' });
    assert.equal(up.status, 201);
    assert.match(up.body.url, new RegExp(`^/uploads/${a.family.id}/[a-f0-9]{24}\\.png$`));
    const own = await a.member.agent.get(up.body.url);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await b.admin.agent.get(up.body.url)).status, 404, 'other family');
    assert.equal((await srv.agent().get(up.body.url)).status, 401, 'anonymous');
    assert.equal((await a.admin.agent.get(`/uploads/${a.family.id}/..%2F..%2Ftest.db`)).status, 404, 'traversal');
    assert.equal((await a.admin.agent.get(`/uploads/${a.family.id}/missing.png`)).status, 404);
  });

  test('avatar upload is visible to people sharing a family only', async () => {
    const a = await familyFixture(srv, 'A2');
    const b = await familyFixture(srv, 'B2');
    const res = await a.member.agent.upload('/api/auth/me/avatar', { file: PNG_1X1 });
    assert.equal(res.status, 200);
    const url = res.body.user.avatar_url;
    assert.match(url, new RegExp(`^/uploads/users/${a.member.user.id}/`));
    assert.equal((await a.member.agent.get(url)).status, 200);
    assert.equal((await a.admin.agent.get(url)).status, 200);
    assert.equal((await b.admin.agent.get(url)).status, 404);
    const nonImage = await a.member.agent.upload('/api/auth/me/avatar', { file: Buffer.from('hi'), filename: 'x.txt', type: 'text/plain' });
    assert.equal(nonImage.status, 400);
    const del = await a.member.agent.del('/api/auth/me/avatar');
    assert.equal(del.body.user.avatar_url, null);
  });

  test('family cover is admin-only', async () => {
    const { admin, member } = await familyFixture(srv, 'Cover');
    assert.equal((await member.agent.upload('/api/family/cover', { file: PNG_1X1 })).status, 403);
    const res = await admin.agent.upload('/api/family/cover', { file: PNG_1X1 });
    assert.equal(res.status, 200);
    assert.match(res.body.cover_url, /^\/uploads\/\d+\//);
    assert.equal((await member.agent.get(res.body.cover_url)).status, 200);
    const cleared = await admin.agent.patch('/api/family', { cover_url: null });
    assert.equal(cleared.body.cover_url, null);
  });

  test('ctx.storeFile writes into the family folder', async () => {
    const { admin, family } = await familyFixture(srv, 'Store');
    const url = srv.ctx.storeFile(family.id, PNG_1X1, 'png');
    assert.equal((await admin.agent.get(url)).status, 200);
  });

  test('non-image files are never served inline, and image uploads are verified by their bytes', async () => {
    const a = await familyFixture(srv, 'Sniff');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const up = await a.admin.agent.upload('/api/files', { file: html, filename: 'evil.html', type: 'image/png' });
    assert.equal(up.status, 201);
    const got = await a.admin.agent.get(up.body.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.match(got.headers.get('content-disposition') || '', /attachment/);
    const svg = await a.admin.agent.upload('/api/files', { file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), filename: 'x.svg', type: 'image/jpeg' });
    const svgRes = await a.admin.agent.get(svg.body.url);
    assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');
    assert.match(svgRes.headers.get('content-security-policy'), /sandbox/);
    assert.match(svgRes.headers.get('content-security-policy'), /default-src 'none'/);
    const png = await a.admin.agent.get((await a.admin.agent.upload('/api/files', { file: PNG_1X1, filename: 'p.png' })).body.url);
    assert.equal(png.headers.get('content-type'), 'image/png');
    // avatar: HTML disguised as PNG is rejected; a real PNG named .gif is stored as .png
    const fake = await a.admin.agent.upload('/api/auth/me/avatar', { file: html, filename: 'a.png', type: 'image/png' });
    assert.equal(fake.status, 400);
    const renamed = await a.admin.agent.upload('/api/auth/me/avatar', { file: PNG_1X1, filename: 'a.gif', type: 'image/gif' });
    assert.equal(renamed.status, 200);
    assert.match(renamed.body.user.avatar_url, /\.png$/);
  });
});
