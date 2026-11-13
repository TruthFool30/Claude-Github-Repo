import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadKey, makeSecretBox } from '../src/secretbox.js';

test('secretbox seals and opens strings and buffers, passes plaintext through, rejects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-key-'));
  const keyFile = path.join(dir, 'sub', 'hearth.key');
  const key = loadKey({ keyFile, env: '' });
  assert.equal((fs.statSync(keyFile).mode & 0o777), 0o600);
  assert.deepEqual(loadKey({ keyFile, env: '' }), key, 'key file is reused');
  assert.deepEqual(loadKey({ keyFile, env: key.toString('hex') }), key, 'hex env key');
  assert.throws(() => loadKey({ keyFile, env: 'short' }), /32 bytes/);

  const box = makeSecretBox(key);
  const sealed = box.seal('Wi-Fi: hunter2 ✓');
  assert.ok(box.isSealed(sealed) && !sealed.includes('hunter2'));
  assert.notEqual(box.seal('x'), box.seal('x'), 'random IV');
  assert.equal(box.open(sealed), 'Wi-Fi: hunter2 ✓');
  assert.equal(box.seal(sealed), sealed, 'never double-sealed');
  assert.equal(box.open('legacy plain'), 'legacy plain');
  assert.equal(box.seal(null), null);

  const file = Buffer.from('%PDF-1.7 secret');
  const sb = box.sealBuffer(file);
  assert.ok(box.isSealedBuffer(sb) && !sb.includes('secret'));
  assert.deepEqual(box.openBuffer(sb), file);
  assert.deepEqual(box.openBuffer(file), file, 'legacy file passthrough');

  sb[sb.length - 1] ^= 1;
  assert.throws(() => box.openBuffer(sb), 'tampered data is rejected');
  assert.throws(() => makeSecretBox(Buffer.alloc(32, 7)).open(sealed), 'wrong key is rejected');
  fs.rmSync(dir, { recursive: true, force: true });
});
