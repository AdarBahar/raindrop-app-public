import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';

// A fake store that keeps the last check time in memory.
function fakeService({ tokens = null, checked = null } = {}) {
  const writes = [];
  return {
    writes,
    svc: {
      cache: new Map(),
      store: {
        ensureUser: async () => {},
        getTokens: async () => tokens,
        lastChecked: async () => checked,
        setLastChecked: async (user, iso) => { writes.push([user, iso]); },
      },
      key: Buffer.alloc(32),
      profiles: new Map(),
      generations: new Map(),
      states: new Map(),
      refreshing: new Map(),
    },
  };
}

async function withServer(svc, fn) {
  const server = createApp(svc);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('/api/me returns lastChecked for a signed-in user, and null for a signed-out visitor', async () => {
  const { svc } = fakeService({ checked: '2026-10-18T07:00:00.000Z' });
  await withServer(svc, async (base) => {
    const signedIn = await (await fetch(`${base}/api/me`, { headers: { 'x-admintools-email': 'alice@example.com' } })).json();
    assert.equal(signedIn.lastChecked, '2026-10-18T07:00:00.000Z');
    const anonymous = await (await fetch(`${base}/api/me`)).json();
    assert.equal(anonymous.lastChecked, null);
  });
});

test('a check for a user with no Raindrop connection records no time', async () => {
  const { svc, writes } = fakeService({ tokens: null });
  await withServer(svc, async (base) => {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'x-admintools-email': 'alice@example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 409);
  });
  assert.deepEqual(writes, []);
});

test('the migration adds the last_checked column', () => {
  const sql = readFileSync(new URL('../migrations/002_last_check.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checked TEXT;/);
});

test('/api/me still answers when the migration has not run', async () => {
  const { svc } = fakeService();
  svc.store.lastChecked = async () => { throw new Error('column "last_checked" does not exist'); };
  await withServer(svc, async (base) => {
    const res = await fetch(`${base}/api/me`, { headers: { 'x-admintools-email': 'alice@example.com' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lastChecked, null);
    assert.equal(body.user, 'alice@example.com');
  });
});
