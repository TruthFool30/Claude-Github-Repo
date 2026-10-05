// TOTP two-factor codes (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30 s steps, ±1 step of drift.
// Also the one-time recovery codes shown when two-factor login is turned on.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient decode (ignores case, spaces, dashes and '=' padding); throws on other characters. */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP value for one counter (RFC 4226 dynamic truncation). `key` is the raw secret bytes. */
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

export const timeStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** New random secret, base32 (160 bits, the RFC 4226 recommendation). */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

/**
 * Check a 6-digit code against a base32 secret. Returns the matched time step, or null.
 * Codes for steps at or before `lastStep` are refused (replay protection).
 */
export function verifyTotp(secret, code, { lastStep = -1, now = Date.now() } = {}) {
  const c = String(code ?? '');
  if (!/^\d{6}$/.test(c)) return null;
  const given = Buffer.from(c);
  const key = base32Decode(secret);
  const current = timeStep(now);
  let matched = null;
  // Check every step in the window (no early exit) so timing doesn't reveal which one matched.
  for (let s = current - 1; s <= current + 1; s++) {
    if (crypto.timingSafeEqual(given, Buffer.from(hotp(key, s))) && s > lastStep && matched === null) matched = s;
  }
  return matched;
}

/** "JBSW Y3DP …" groups of 4 for typing the key by hand. */
export const groupSecret = (secret) => secret.match(/.{1,4}/g).join(' ');

// ---------- recovery codes ----------

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/i/l
/** 12 random chars (~59 bits) as "abcd-efgh-jkmn". */
export function newRecoveryCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Hash of a recovery code, ignoring case, spaces and dashes. High-entropy codes, so plain sha256 is enough. */
export const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
