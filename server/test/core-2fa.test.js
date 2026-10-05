import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, registerUser, familyFixture } from './helpers.js';
import { base32Decode, base32Encode, hotp, timeStep, verifyTotp } from '../src/totp.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const codeFor = (secret, offset = 0) => hotp(base32Decode(secret), timeStep() + offset);
/** A 6-digit code that is not valid right now. */
const wrongCode = (secret) => {
  const valid = [-1, 0, 1].map((o) => codeFor(secret, o));
  let n = 0;
  while (valid.includes(String(n).padStart(6, '0'))) n++;
  return String(n).padStart(6, '0');
};
/** Forget the last accepted step so a fresh code for "now" is accepted again (tests only). */
const allowReuse = (userId) => srv.db.prepare('UPDATE users SET totp_last_step = NULL WHERE id = ?').run(userId);

/** Register a user and turn 2FA on. Returns { agent, user, secret, codes, password }. */
async function withTwoFactor(opts = {}) {
  const password = 'secret123';
  const u = await registerUser(srv, { password, family_name: opts.family_name });
  const setup = await u.agent.post('/api/auth/2fa/setup', { password });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const enable = await u.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  return { ...u, password, secret: setup.body.secret, codes: enable.body.recovery_codes };
}

describe('totp primitives', () => {
  test('RFC 6238 SHA1 test vectors', () => {
    const key = Buffer.from('12345678901234567890');
    const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, expected] of vectors) {
      assert.equal(hotp(key, Math.floor(t / 30), 8), expected, `T=${t}`);
      assert.equal(hotp(key, Math.floor(t / 30)), expected.slice(-6), `T=${t} (6 digits)`);
    }
  });

  test('base32 round-trips and verify accepts ±1 step, refuses replays', () => {
    const key = Buffer.from('12345678901234567890');
    const b32 = base32Encode(key);
    assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode(b32.toLowerCase().match(/.{4}/g).join(' ')), key);
    const now = 59_000; // step 1
    assert.equal(verifyTotp(b32, '287082', { now }), 1);
    assert.equal(verifyTotp(b32, hotp(key, 0), { now }), 0);
    assert.equal(verifyTotp(b32, hotp(key, 2), { now }), 2);
    assert.equal(verifyTotp(b32, hotp(key, 3), { now }), null);
    assert.equal(verifyTotp(b32, '287082', { now, lastStep: 1 }), null);
    assert.equal(verifyTotp(b32, '28708', { now }), null);
    assert.equal(verifyTotp(b32, 'abcdef', { now }), null);
  });
});

describe('two-factor login', () => {
  test('setup returns a sealed pending secret, QR and otpauth URI; enable needs a valid code', async () => {
    const u = await registerUser(srv, { password: 'secret123' });
    assert.equal((await u.agent.post('/api/auth/2fa/setup', { password: 'nope' })).status, 400);
    const setup = await u.agent.post('/api/auth/2fa/setup', { password: 'secret123' });
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^([A-Z2-7]{4} )+[A-Z2-7]{4}$/);
    assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\/Hearth:.+\?secret=[A-Z2-7]+&issuer=Hearth/);
    assert.ok(setup.body.otpauth_uri.includes(encodeURIComponent(u.user.email)));
    assert.match(setup.body.qr_svg, /^<svg[\s\S]*<\/svg>\s*$/);
    const raw = srv.db.prepare('SELECT totp_secret, totp_pending FROM users WHERE id = ?').get(u.user.id);
    assert.equal(raw.totp_secret, null, 'not active until confirmed');
    assert.ok(raw.totp_pending.startsWith('enc:v1:'), 'pending secret stored sealed');
    assert.equal((await u.agent.get('/api/auth/me')).body.two_factor_enabled, false);

    assert.equal((await u.agent.post('/api/auth/2fa/enable', { code: wrongCode(setup.body.secret) })).status, 400);
    const ok = await u.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recovery_codes.length, 10);
    for (const c of ok.body.recovery_codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal(new Set(ok.body.recovery_codes).size, 10);
    assert.equal(ok.body.two_factor_enabled, true);
    const after = srv.db.prepare('SELECT totp_secret, totp_pending, totp_recovery FROM users WHERE id = ?').get(u.user.id);
    assert.ok(after.totp_secret.startsWith('enc:v1:'), 'active secret stored sealed');
    assert.equal(after.totp_pending, null);
    assert.ok(!after.totp_recovery.includes(ok.body.recovery_codes[0]), 'only hashes are stored');
    assert.equal((await u.agent.post('/api/auth/2fa/setup', { password: 'secret123' })).status, 409);
  });

  test('login then requires a code; ticket is single-use; replayed code is refused', async () => {
    const u = await withTwoFactor();
    await u.agent.post('/api/auth/logout');
    const a = srv.agent();
    const step1 = await a.post('/api/auth/login', { email: u.user.email, password: u.password });
    assert.equal(step1.status, 200);
    assert.equal(step1.body.two_factor_required, true);
    assert.equal(step1.body.user, undefined);
    assert.equal(a.cookie, '', 'no session before the code');
    assert.equal((await a.get('/api/auth/me')).body.user, null);

    const wrong = await a.post('/api/auth/login/2fa', { ticket: step1.body.ticket, code: '12345' });
    assert.equal(wrong.status, 401);
    allowReuse(u.user.id);
    const code = codeFor(u.secret);
    const ok = await a.post('/api/auth/login/2fa', { ticket: step1.body.ticket, code });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, u.user.id);
    assert.ok(a.cookie.startsWith('hearth_session='));
    assert.equal((await a.get('/api/auth/me')).body.user.id, u.user.id);

    // Same ticket again -> gone.
    const again = await srv.agent().post('/api/auth/login/2fa', { ticket: step1.body.ticket, code });
    assert.equal(again.status, 401);
    assert.equal(again.body.code, 'TWO_FACTOR_EXPIRED');

    // A fresh ticket with the same (already used) code -> replay refused.
    const b = srv.agent();
    const t2 = (await b.post('/api/auth/login', { email: u.user.email, password: u.password })).body.ticket;
    const replay = await b.post('/api/auth/login/2fa', { ticket: t2, code });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, undefined, 'ticket survives one wrong code');
    assert.equal(b.cookie, '');
  });

  test('a recovery code works exactly once', async () => {
    const u = await withTwoFactor();
    const login = async (code) => {
      const a = srv.agent();
      const { ticket } = (await a.post('/api/auth/login', { email: u.user.email, password: u.password })).body;
      return a.post('/api/auth/login/2fa', { ticket, code });
    };
    const ok = await login(u.codes[3].toUpperCase().replace(/-/g, ' '));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recovery_codes_left, 9);
    assert.equal((await login(u.codes[3])).status, 401);
    assert.equal((await login('zzzz-zzzz-zzzz')).status, 401);
  });

  test('ticket dies after 5 wrong codes and after 5 minutes', async () => {
    const u = await withTwoFactor();
    const a = srv.agent();
    const { ticket } = (await a.post('/api/auth/login', { email: u.user.email, password: u.password })).body;
    for (let i = 0; i < 4; i++) assert.equal((await a.post('/api/auth/login/2fa', { ticket, code: 'nope-nope-nope' })).body.code, undefined);
    const fifth = await a.post('/api/auth/login/2fa', { ticket, code: 'nope-nope-nope' });
    assert.equal(fifth.status, 401);
    assert.equal(fifth.body.code, 'TWO_FACTOR_EXPIRED');
    allowReuse(u.user.id);
    assert.equal((await a.post('/api/auth/login/2fa', { ticket, code: codeFor(u.secret) })).status, 401, 'killed ticket stays dead');

    const t2 = (await a.post('/api/auth/login', { email: u.user.email, password: u.password })).body.ticket;
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000 + 1000;
    try {
      const late = await a.post('/api/auth/login/2fa', { ticket: t2, code: u.codes[0] });
      assert.equal(late.status, 401);
      assert.equal(late.body.code, 'TWO_FACTOR_EXPIRED');
    } finally {
      Date.now = realNow;
    }
    assert.equal((await a.post('/api/auth/login/2fa', { ticket: t2, code: u.codes[0] })).status, 401);
  });

  test('wrong codes use the sign-in failure budget (per email+IP)', async () => {
    const limited = await startServer({ limits: { 'login-email': { max: 6, windowMs: 60_000 } } });
    try {
      const ag = limited.agent();
      assert.equal((await ag.post('/api/auth/register', { name: 'L', email: 'limited@example.test', password: 'secret123' })).status, 201);
      const setup = await ag.post('/api/auth/2fa/setup', { password: 'secret123' });
      assert.equal((await ag.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) })).status, 200);
      const a = limited.agent();
      let { ticket } = (await a.post('/api/auth/login', { email: 'limited@example.test', password: 'secret123' })).body;
      for (let i = 0; i < 5; i++) await a.post('/api/auth/login/2fa', { ticket, code: 'aaaa-aaaa-aaaa' });
      // The correct password again doesn't reset the counter...
      ({ ticket } = (await a.post('/api/auth/login', { email: 'limited@example.test', password: 'secret123' })).body);
      assert.ok(ticket);
      assert.equal((await a.post('/api/auth/login/2fa', { ticket, code: 'aaaa-aaaa-aaaa' })).status, 401);
      // ...so the budget (6) is now spent.
      const blocked = await a.post('/api/auth/login/2fa', { ticket, code: 'aaaa-aaaa-aaaa' });
      assert.equal(blocked.status, 429);
      assert.ok(blocked.headers.get('retry-after'));
      assert.equal((await a.post('/api/auth/login', { email: 'limited@example.test', password: 'secret123' })).status, 429);
    } finally {
      await limited.close();
    }
  });

  test('disable needs the password and a code; recovery codes can be regenerated', async () => {
    const u = await withTwoFactor();
    allowReuse(u.user.id);
    assert.equal((await u.agent.post('/api/auth/2fa/recovery-codes', { code: wrongCode(u.secret) })).status, 400);
    const regen = await u.agent.post('/api/auth/2fa/recovery-codes', { code: codeFor(u.secret) });
    assert.equal(regen.status, 200);
    assert.equal(regen.body.recovery_codes.length, 10);
    assert.equal(regen.body.recovery_codes_left, 10);
    // Old codes no longer work.
    assert.equal((await u.agent.post('/api/auth/2fa/disable', { password: u.password, code: u.codes[0] })).status, 400);

    const badPw = await u.agent.post('/api/auth/2fa/disable', { password: 'wrong', code: regen.body.recovery_codes[0] });
    assert.equal(badPw.status, 400);
    assert.equal(badPw.body.field, 'password');
    assert.equal((await u.agent.post('/api/auth/2fa/disable', { password: u.password, code: '' })).status, 400);
    const off = await u.agent.post('/api/auth/2fa/disable', { password: u.password, code: regen.body.recovery_codes[0] });
    assert.equal(off.status, 200);
    assert.equal(off.body.two_factor_enabled, false);
    const raw = srv.db.prepare('SELECT totp_secret, totp_recovery, totp_pending FROM users WHERE id = ?').get(u.user.id);
    assert.deepEqual({ ...raw }, { totp_secret: null, totp_recovery: null, totp_pending: null });
    // Plain password sign-in again.
    const a = srv.agent();
    const login = await a.post('/api/auth/login', { email: u.user.email, password: u.password });
    assert.equal(login.body.user.id, u.user.id);
    assert.equal(login.body.two_factor_required, undefined);
  });

  test('2FA state is only visible to the user themself', async () => {
    const fx = await familyFixture(srv, 'Private 2FA');
    const setup = await fx.admin.agent.post('/api/auth/2fa/setup', { password: 'secret123' });
    await fx.admin.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) });
    const me = await fx.admin.agent.get('/api/auth/me');
    assert.equal(me.body.two_factor_enabled, true);
    assert.equal(me.body.recovery_codes_left, 10);
    assert.equal(me.body.user.two_factor_enabled, undefined);
    const other = await fx.member.agent.get('/api/auth/me');
    assert.equal(other.body.two_factor_enabled, false);
    const fam = await fx.member.agent.get('/api/family');
    const admin = fam.body.members.find((m) => m.id === fx.admin.user.id);
    assert.ok(admin);
    assert.ok(!JSON.stringify(fam.body).match(/totp|two_factor|recovery/));
  });

  test('turning 2FA on signs out other sessions', async () => {
    const u = await registerUser(srv, { password: 'secret123' });
    const other = srv.agent();
    await other.post('/api/auth/login', { email: u.user.email, password: 'secret123' });
    assert.equal((await other.get('/api/auth/me')).body.user.id, u.user.id);
    const setup = await u.agent.post('/api/auth/2fa/setup', { password: 'secret123' });
    await u.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) });
    assert.equal((await other.get('/api/auth/me')).body.user, null);
    assert.equal((await u.agent.get('/api/auth/me')).body.user.id, u.user.id, 'this session stays');
  });

  test('enable: abandoned setups expire, cancel clears them, wrong passwords name their field', async () => {
    const u = await registerUser(srv, { password: 'secret123' });
    const wrongPw = await u.agent.post('/api/auth/2fa/setup', { password: 'nope' });
    assert.equal(wrongPw.body.field, 'password');
    let setup = await u.agent.post('/api/auth/2fa/setup', { password: 'secret123' });
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      const late = await u.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) });
      assert.equal(late.status, 400);
      assert.match(late.body.error, /expired/);
    } finally {
      Date.now = realNow;
    }
    setup = await u.agent.post('/api/auth/2fa/setup', { password: 'secret123' });
    assert.equal((await u.agent.del('/api/auth/2fa/setup')).status, 200);
    assert.equal(srv.db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(u.user.id).totp_pending, null);
    assert.equal((await u.agent.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) })).status, 400);
  });

  test('wrong codes are budgeted per account, whatever the IP (enable and sign-in)', async () => {
    const limited = await startServer({ trustProxy: true, limits: { 'code-user': { max: 3, windowMs: 60_000 } } });
    let ip = 1;
    const from = () => ({ headers: { 'x-forwarded-for': `10.0.0.${ip++}` } });
    try {
      const ag = limited.agent();
      await ag.post('/api/auth/register', { name: 'P', email: 'peracct@example.test', password: 'secret123' });
      const setup = await ag.post('/api/auth/2fa/setup', { password: 'secret123' });
      const wrong = wrongCode(setup.body.secret);
      for (let i = 0; i < 3; i++) assert.equal((await ag.post('/api/auth/2fa/enable', { code: wrong }, from())).status, 400);
      const blocked = await ag.post('/api/auth/2fa/enable', { code: codeFor(setup.body.secret) }, from());
      assert.equal(blocked.status, 429, 'even the right code is refused once the budget is spent');

      const other = limited.agent();
      await other.post('/api/auth/register', { name: 'Q', email: 'peracct2@example.test', password: 'secret123' });
      const s2 = await other.post('/api/auth/2fa/setup', { password: 'secret123' });
      assert.equal((await other.post('/api/auth/2fa/enable', { code: codeFor(s2.body.secret) })).status, 200, 'budget is per account');
      const a = limited.agent();
      const { ticket } = (await a.post('/api/auth/login', { email: 'peracct2@example.test', password: 'secret123' }, from())).body;
      for (let i = 0; i < 3; i++) assert.equal((await a.post('/api/auth/login/2fa', { ticket, code: 'aaaa-aaaa-aaaa' }, from())).status, 401);
      assert.equal((await a.post('/api/auth/login/2fa', { ticket, code: 'aaaa-aaaa-aaaa' }, from())).status, 429);

      // A successful sign-in clears the account's budget: earlier typos don't linger.
      const c = limited.agent();
      await c.post('/api/auth/register', { name: 'R', email: 'peracct3@example.test', password: 'secret123' });
      const s3 = await c.post('/api/auth/2fa/setup', { password: 'secret123' });
      const codes = (await c.post('/api/auth/2fa/enable', { code: codeFor(s3.body.secret) })).body.recovery_codes;
      const login = async () => (await limited.agent().post('/api/auth/login', { email: 'peracct3@example.test', password: 'secret123' }, from())).body.ticket;
      let t3 = await login();
      for (let i = 0; i < 2; i++) assert.equal((await c.post('/api/auth/login/2fa', { ticket: t3, code: 'aaaa-aaaa-aaaa' }, from())).status, 401);
      assert.equal((await c.post('/api/auth/login/2fa', { ticket: t3, code: codes[0] }, from())).status, 200);
      t3 = await login();
      for (let i = 0; i < 2; i++) assert.equal((await c.post('/api/auth/login/2fa', { ticket: t3, code: 'aaaa-aaaa-aaaa' }, from())).status, 401);
      assert.equal((await c.post('/api/auth/login/2fa', { ticket: t3, code: codes[1] }, from())).status, 200, 'budget was reset by the earlier success');
    } finally {
      await limited.close();
    }
  });

  test('npm run reset-2fa turns it off for a locked-out user', async () => {
    const u = await withTwoFactor();
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/reset-2fa.js');
    const run = (email) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, email], {
      env: { ...process.env, DB_PATH: path.join(srv.dir, 'test.db') }, encoding: 'utf8',
    });
    assert.equal(run('nobody@example.test').status, 1);
    const ok = run(u.user.email.toUpperCase());
    assert.equal(ok.status, 0, ok.stderr);
    const login = await srv.agent().post('/api/auth/login', { email: u.user.email, password: u.password });
    assert.equal(login.body.user.id, u.user.id);
  });
});
