// Test helpers shared by core and module tests.
//   const srv = await startServer();            // fresh temp DB + upload dir, random port
//   const alex = srv.agent();                   // cookie-jar HTTP client
//   await alex.post('/api/auth/register', {...})
//   const { status, body } = await alex.get('/api/family');
//   after(() => srv.close());
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

/** Rate limits are effectively disabled in tests unless a test passes its own `limits`. */
const RELAXED = { max: 1e9, windowMs: 60_000 };
export const TEST_LIMITS = {
  'login-ip': RELAXED, 'login-email': RELAXED, 'register-ip': RELAXED, 'join-ip': RELAXED, 'invite-ip': RELAXED,
};

export async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
  const app = createApp({
    dbPath: path.join(dir, 'test.db'),
    uploadDir: path.join(dir, 'uploads'),
    clientDist: path.join(dir, 'no-client'),
    ...options,
    limits: { ...TEST_LIMITS, ...(options.limits ?? {}) },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    dir,
    db: app.locals.db,
    ctx: app.locals.ctx,
    agent: () => createAgent(base),
    async close() {
      app.locals.hub.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      app.locals.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createAgent(base) {
  let cookie = '';
  let familyId = null; // like a browser tab: when set, sent as X-Family-Id
  async function request(method, url, { body, form, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (cookie) init.headers.cookie = cookie;
    if (familyId && !init.headers['x-family-id']) init.headers['x-family-id'] = String(familyId);
    if (form) init.body = form;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, init);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (k === 'hearth_session') cookie = v ? `${k}=${v}` : '';
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  }
  return {
    get: (url, opts) => request('GET', url, opts),
    post: (url, body, opts) => request('POST', url, { ...opts, body }),
    patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
    put: (url, body, opts) => request('PUT', url, { ...opts, body }),
    del: (url, opts) => request('DELETE', url, opts),
    /** multipart upload: agent.upload('/api/photos', { file: blobOrBuffer, filename, fields }) */
    upload(url, { file, filename = 'file.png', type = 'image/png', field = 'file', fields = {} } = {}) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
      if (file) form.append(field, file instanceof Blob ? file : new Blob([file], { type }), filename);
      return request('POST', url, { form });
    },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    /** Pin this agent to a family (sends X-Family-Id on every request), or null for the session default. */
    get familyId() { return familyId; },
    set familyId(v) { familyId = v; },
    /** Same cookie (same session) but its own family pin — simulates a second browser tab. */
    tab() { const t = createAgent(base); t.cookie = cookie; return t; },
    base,
  };
}

let counter = 0;
/** Register a fresh user (optionally creating a family). Returns { agent, user, families }. */
export async function registerUser(srv, { name = 'Test User', email, password = 'secret123', family_name } = {}) {
  const agent = srv.agent();
  const res = await agent.post('/api/auth/register', {
    name,
    email: email ?? `user${Date.now()}${counter++}@example.test`,
    password,
    family_name,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user, families: res.body.families };
}

/** A family with an admin and a member already joined. */
export async function familyFixture(srv, familyName = 'Test Family') {
  const admin = await registerUser(srv, { name: 'Admin', family_name: familyName });
  const fam = (await admin.agent.get('/api/family')).body;
  const member = await registerUser(srv, { name: 'Member' });
  await member.agent.post('/api/families/join', { invite_code: fam.invite_code });
  return { admin, member, family: fam };
}

/** A tiny valid 1x1 PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Read the first N SSE messages from /api/stream (resolves with parsed {type,payload}). */
export async function collectEvents(agent, { count = 1, timeoutMs = 3000, until } = {}) {
  const ctrl = new AbortController();
  const qsFamily = agent.familyId ? `?family_id=${agent.familyId}` : '';
  const res = await fetch(agent.base + '/api/stream' + qsFamily, { headers: { cookie: agent.cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const ready = { resolve: null };
  const readyPromise = new Promise((r) => (ready.resolve = r));
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'hello') { ready.resolve(); continue; }
          events.push(evt);
          if ((until && until(evt)) || (!until && events.length >= count)) { ctrl.abort(); return events; }
        }
      }
    } catch { /* aborted */ }
    return events;
  })().finally(() => clearTimeout(timer));
  await Promise.race([readyPromise, done]);
  return { events: done };
}
