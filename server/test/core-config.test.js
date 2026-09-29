import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { startServer } from './helpers.js';
import { parseTrustProxy } from '../src/config.js';

const ipEcho = { name: 'ipecho', migrations: [], router: () => Router() };

test('parseTrustProxy handles booleans, hop counts and subnet lists', () => {
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy(''), 'loopback');
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.deepEqual(parseTrustProxy('loopback'), ['loopback']);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
});

// req.ip decides rate-limit buckets: with trust proxy off, X-Forwarded-For must be ignored.
async function blockedAfterSpoofing(trustProxy) {
  const srv = await startServer({ trustProxy, modules: [ipEcho], limits: { 'register-ip': { max: 1, windowMs: 60_000 } } });
  try {
    const a = srv.agent();
    const first = await a.post('/api/auth/register', { name: 'A', email: 'a@x.test', password: 'secret123' }, { headers: { 'x-forwarded-for': '10.1.1.1' } });
    assert.equal(first.status, 201);
    const second = await a.post('/api/auth/register', { name: 'B', email: 'b@x.test', password: 'secret123' }, { headers: { 'x-forwarded-for': '10.2.2.2' } });
    return second.status === 429;
  } finally {
    await srv.close();
  }
}

test('trust proxy setting controls whether X-Forwarded-For is honoured', async () => {
  assert.equal(await blockedAfterSpoofing(false), true, 'untrusted: spoofed header ignored, same bucket');
  assert.equal(await blockedAfterSpoofing('loopback'), false, 'trusted loopback proxy: header used');
  assert.equal(await blockedAfterSpoofing(1), false, 'one trusted hop');
});
