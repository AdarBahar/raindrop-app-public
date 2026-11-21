import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { loadAll, progress } from '../src/bookmarks.js';

// A service with one connected user and an empty cache. The token is valid, so no refresh is made.
function fakeService() {
  const key = randomBytes(32);
  return {
    key,
    cache: new Map(),
    profiles: new Map(),
    generations: new Map(),
    refreshing: new Map(),
    store: {
      getTokens: async () => ({ access_enc: encrypt('tok', key), refresh_enc: encrypt('ref', key), expires_at: Date.now() + 60000 }),
    },
  };
}

// A Raindrop account with two named folders and some unsorted bookmarks.
// The named folders hold 3 bookmarks. Unsorted holds 2. /raindrops/0 returns all 5.
const COLLECTIONS = [{ _id: 10, title: 'Work', count: 2 }, { _id: 11, title: 'Home', count: 1 }];
const ITEMS = [
  { _id: 1, title: 'a', link: 'https://a.example', collection: { $id: 10 } },
  { _id: 2, title: 'b', link: 'https://b.example', collection: { $id: 10 } },
  { _id: 3, title: 'c', link: 'https://c.example', collection: { $id: 11 } },
  { _id: 4, title: 'd', link: 'https://d.example', collection: { $id: -1 } },
  { _id: 5, title: 'e', link: 'https://e.example', collection: { $id: -1 } },
];

// Replace fetch with a fake Raindrop API. `stats` is the answer to /user/stats, or a status code to fail with.
function fakeRaindrop(stats) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/collections')) return json({ result: true, items: COLLECTIONS });
    if (u.pathname.endsWith('/collections/childrens')) return json({ result: true, items: [] });
    if (u.pathname.endsWith('/user/stats')) {
      if (typeof stats === 'number') return new Response('error', { status: stats });
      return json(stats);
    }
    if (u.pathname.endsWith('/raindrops/0')) {
      const page = Number(u.searchParams.get('page') ?? 0);
      return json({ result: true, items: page === 0 ? ITEMS : [] });
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.beforeEach(() => { config.raindrop.minIntervalMs = 0; });
test.afterEach(() => { globalThis.fetch = realFetch; });

test('the loading total counts the unsorted bookmarks too', async () => {
  const svc = fakeService();
  const calls = fakeRaindrop({ result: true, items: [{ _id: 0, count: 5 }, { _id: -1, count: 2 }, { _id: -99, count: 9 }] });
  const c = await loadAll(svc, 'u');
  assert.equal(c.items.length, 5);
  assert.deepEqual(progress(svc, 'u'), { loaded: 5, total: 5 });
  assert.ok(calls.some((p) => p.endsWith('/user/stats')), 'the system collection counts are read');
});

test('the loading total falls back to the folder sum when the system counts fail', async () => {
  const svc = fakeService();
  fakeRaindrop(404);
  const c = await loadAll(svc, 'u');
  assert.equal(c.items.length, 5, 'the load itself still works');
  assert.deepEqual(progress(svc, 'u'), { loaded: 5, total: 3 });
});

test('the loading total falls back to the folder sum when the all count is missing', async () => {
  const svc = fakeService();
  fakeRaindrop({ result: true, items: [{ _id: -1, count: 2 }] });
  await loadAll(svc, 'u');
  assert.deepEqual(progress(svc, 'u'), { loaded: 5, total: 3 });
});
