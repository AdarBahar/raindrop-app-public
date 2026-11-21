import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const EMAIL = 'alice@example.com';

// A running server with one signed-in user, a fresh cache, and no Raindrop calls.
async function start() {
  const svc = {
    cache: new Map([[EMAIL, {
      at: Date.now(),
      items: [{ _id: 1, title: 'one', link: 'https://example.com/1', tags: [], collection: { $id: 10 }, created: new Date().toISOString() }],
      collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    }]]),
    store: {
      ensureUser: async () => {},
      getTokens: async () => ({ access_enc: 'x', refresh_enc: 'x', expires_at: Date.now() + 1e9 }),
      keptDuplicates: () => [], newItems: () => new Set(),
      visits: () => new Map(),
    },
    key: Buffer.alloc(32),
    profiles: new Map(),
    generations: new Map(),
    states: new Map(),
    refreshing: new Map(),
  };
  const server = createApp(svc);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-admintools-email': EMAIL, 'content-type': 'application/json' };
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    post: (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }),
    get: (path) => fetch(base + path, { headers }),
  };
}

test('a bulk request with a bad action returns 400 with a clear message', async () => {
  const app = await start();
  try {
    const res = await app.post('/api/bulk', { action: 'delete', ids: [1] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown bulk action/);
  } finally {
    await app.close();
  }
});

test('an unknown job returns 404, for get and for cancel', async () => {
  const app = await start();
  try {
    const id = '00000000-0000-4000-8000-000000000000';
    assert.equal((await app.get(`/api/bulk/${id}`)).status, 404);
    assert.equal((await app.post(`/api/bulk/${id}/cancel`, {})).status, 404);
  } finally {
    await app.close();
  }
});

test('a bulk request without a signed-in user is refused', async () => {
  const app = await start();
  try {
    const res = await fetch(app.base + '/api/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'move', ids: [1], folderId: 10 }),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});
