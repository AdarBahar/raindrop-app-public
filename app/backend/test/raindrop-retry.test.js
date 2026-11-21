import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { raindropCall, retryWait } from '../src/raindrop.js';

// A service with one connected user. The token is valid, so no refresh is made.
function fakeService() {
  const key = randomBytes(32);
  return {
    key,
    generations: new Map(),
    refreshing: new Map(),
    store: {
      getTokens: async () => ({ access_enc: encrypt('tok', key), refresh_enc: encrypt('ref', key), expires_at: Date.now() + 60000 }),
    },
  };
}

// Replace fetch with a list of answers. Each call takes the next answer. Returns the calls made.
function fakeFetch(statuses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    const status = statuses[Math.min(calls.length, statuses.length) - 1];
    return new Response(status === 200 ? '{"ok":true}' : 'error', {
      status,
      headers: { 'retry-after': '0' },
    });
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.beforeEach(() => { config.raindrop.minIntervalMs = 0; });
test.afterEach(() => { globalThis.fetch = realFetch; });

test('a GET is retried after a server error', async () => {
  const calls = fakeFetch([500, 200]);
  const res = await raindropCall(fakeService(), 'u', 'GET', '/collections');
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 2);
});

test('a PUT is retried after a server error, because it sets the full state', async () => {
  const calls = fakeFetch([502, 200]);
  const res = await raindropCall(fakeService(), 'u', 'PUT', '/raindrop/1', { tags: ['a'] });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 2);
});

test('a POST is not retried after a server error, because the server may have run it', async () => {
  const calls = fakeFetch([500, 200]);
  await assert.rejects(raindropCall(fakeService(), 'u', 'POST', '/collection', { title: 'x' }), /failed with 500/);
  assert.equal(calls.length, 1);
});

test('a POST is retried after a rate limit, because the server did not run it', async () => {
  const calls = fakeFetch([429, 200]);
  const res = await raindropCall(fakeService(), 'u', 'POST', '/collection', { title: 'x' });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 2);
});

test('the wait comes from Retry-After when it is present', () => {
  assert.equal(retryWait(new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(retryWait(new Headers({ 'retry-after': '0', 'x-ratelimit-reset': '9999999999' })), 0);
});

test('the wait comes from X-RateLimit-Reset when Retry-After is missing', () => {
  const now = 1_700_000_000_000;
  const reset = (seconds) => new Headers({ 'x-ratelimit-reset': String(now / 1000 + seconds) });
  assert.equal(retryWait(reset(7), now), 7000);
  assert.equal(retryWait(reset(0), now), 1000, 'a window that already ended still waits one second');
  assert.equal(retryWait(reset(-5), now), 1000, 'a reset time in the past waits one second');
  assert.equal(retryWait(reset(300), now), 60000, 'the wait is limited to one minute');
});

test('the wait is ten seconds without both headers', () => {
  assert.equal(retryWait(new Headers()), 10000);
  assert.equal(retryWait(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })), 10000, 'a date is not used');
});

test('retries stop after the limit', async () => {
  const calls = fakeFetch([500, 500, 500, 500, 500, 500]);
  await assert.rejects(raindropCall(fakeService(), 'u', 'GET', '/collections'), /failed with 500/);
  assert.equal(calls.length, 5);
});
