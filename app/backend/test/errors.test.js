// Error responses. An unexpected error hides its text behind a reference. A known error keeps its text.
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const USER = 'alice@example.com';
const headers = { 'x-admintools-email': USER, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

// A service with one connected user and a fresh cache, so no Raindrop call is made.
function service(store = {}) {
  return {
    cache: new Map([[USER, {
      at: Date.now(),
      items: [{ _id: 1, title: 'one', link: 'https://example.com/1', tags: [], collection: { $id: 10 } }],
      collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    }]]),
    profiles: new Map(),
    states: new Map(),
    generations: new Map(),
    refreshing: new Map(),
    store: {
      ensureUser: async () => {},
      getTokens: async () => ({ access_enc: '', refresh_enc: '', expires_at: Date.now() + 60000 }),
      lastChecked: async () => null,
      ...store,
    },
  };
}

describe('error responses', () => {
  let createApp;
  const apps = [];

  before(async () => {
    ({ createApp } = await import('../src/server.js'));
  });

  after(() => { for (const app of apps) app.close(); });

  async function start(svc) {
    const app = createApp(svc);
    apps.push(app);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.address().port}`;
  }

  test('an unexpected error gives a generic message with a reference, and the full error is logged', async () => {
    const base = await start(service({ ensureUser: async () => { throw new Error('password=secret in pg'); } }));
    const log = mock.method(console, 'error', () => {});
    try {
      const res = await fetch(`${base}/api/me`, { headers });
      const body = await res.json();
      assert.equal(res.status, 500);
      assert.match(body.error, /^Something went wrong\. Reference: [0-9a-f]{8}\.$/);
      assert.doesNotMatch(body.error, /secret/);
      const ref = body.error.match(/[0-9a-f]{8}/)[0];
      assert.equal(log.mock.callCount(), 1);
      assert.match(log.mock.calls[0].arguments[0], new RegExp(`^\\[${ref}\\] GET /api/me`));
      assert.match(log.mock.calls[0].arguments[1].message, /secret/);
    } finally {
      log.mock.restore();
    }
  });

  test('a folder name that already exists is refused with its message', async () => {
    const base = await start(service());
    const res = await fetch(`${base}/api/folder`, { method: 'POST', headers, body: JSON.stringify({ name: 'ai' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /A folder named ai already exists/);
  });

  test('a save with an unknown folder is refused with its message', async () => {
    const base = await start(service());
    const res = await fetch(`${base}/api/save`, { method: 'POST', headers, body: JSON.stringify({ id: 1, folderId: 99, tags: [] }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown folder: 99/);
  });

  test('a body that is not JSON is refused with 400', async () => {
    const base = await start(service());
    const res = await fetch(`${base}/api/folder`, { method: 'POST', headers, body: '{bad' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not valid JSON/);
  });
});
