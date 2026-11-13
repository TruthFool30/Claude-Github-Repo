// Encryption at rest: AES-256-GCM with one key per Hearth instance.
//
// The key comes from HEARTH_ENCRYPTION_KEY (32 bytes as base64 or hex) or, when that is unset, from
// a key file next to the database (created with mode 0600 on first start). Anyone holding both
// the key and the data can read everything, so for real protection keep the key out of backups.
//
//   const box = makeSecretBox(loadKey({ keyFile }));
//   box.seal('text')  -> 'enc:v1:<base64>'     box.open(sealed) -> 'text'
//   box.sealBuffer(b) -> Buffer (magic header) box.openBuffer(b) -> Buffer
//
// open/openBuffer pass unencrypted input through unchanged, so data written before encryption was
// enabled keeps working and can be re-sealed in place.
// ponytail: single key, no rotation; add a key id byte + re-encrypt job when rotation is needed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const MAGIC = Buffer.from('HRTHENC1');
const IV = 12;
const TAG = 16;

function parseKey(raw) {
  const s = String(raw).trim();
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (key.length !== 32) throw new Error('HEARTH_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

/**
 * The instance key: env var first, else the key file. A missing key file is generated, unless
 * `create` is false (the database already holds encrypted data): then it throws instead.
 */
export function loadKey({ keyFile, env = process.env.HEARTH_ENCRYPTION_KEY, create = true } = {}) {
  if (env) return parseKey(env);
  if (fs.existsSync(keyFile)) return parseKey(fs.readFileSync(keyFile, 'utf8'));
  if (!create) {
    throw new Error(`The encryption key file ${keyFile} is missing, but this database already holds encrypted data. `
      + 'Restore the original hearth.key (or set HEARTH_ENCRYPTION_KEY / KEY_FILE). A new key would make that data unreadable.');
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

export function makeSecretBox(key) {
  const encrypt = (plain) => {
    const iv = crypto.randomBytes(IV);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };
  const decrypt = (blob) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV));
    d.setAuthTag(blob.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(blob.subarray(IV + TAG)), d.final()]);
  };
  const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);
  const isSealedBuffer = (b) => Buffer.isBuffer(b) && b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC);
  return {
    isSealed,
    isSealedBuffer,
    /** null/undefined stay as they are; everything else is stringified and sealed. */
    seal: (v) => (v == null || isSealed(v) ? v : PREFIX + encrypt(Buffer.from(String(v), 'utf8')).toString('base64')),
    open: (v) => (isSealed(v) ? decrypt(Buffer.from(v.slice(PREFIX.length), 'base64')).toString('utf8') : v),
    sealBuffer: (b) => (isSealedBuffer(b) ? b : Buffer.concat([MAGIC, encrypt(b)])),
    openBuffer: (b) => (isSealedBuffer(b) ? decrypt(b.subarray(MAGIC.length)) : b),
  };
}
