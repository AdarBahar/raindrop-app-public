import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changes, forgetChanges, QUICK_SIZE } from '../src/bookmarks.js';
import { pageScript } from './helpers/frontend.js';

// A fresh cache, so the check reads no bookmarks from Raindrop. Only the quick call goes to the fake.
function fakeService(ids) {
  const svc = { cache: new Map(), store: {} };
  svc.cache.set('u', { at: Date.now(), items: ids.map((id) => ({ _id: id })), collections: new Map(), progress: { loaded: 0, total: 0 }, loading: null });
  return svc;
}
function fakeCall(newest) {
  const calls = [];
  const call = async (svc, userId, method, path) => {
    calls.push(`${method} ${path}`);
    return { items: newest.map((id) => ({ _id: id })) };
  };
  return { call, calls };
}

test('quick check: counts the newest bookmarks that are not in memory, with one call', async () => {
  const svc = fakeService([1, 2, 3]);
  const { call, calls } = fakeCall([5, 4, 3, 2]);
  assert.deepEqual(await changes(svc, 'u', call), { added: 2, more: false });
  assert.deepEqual(calls, [`GET /raindrops/0?perpage=${QUICK_SIZE}&sort=-created`]);
});

test('quick check: no new bookmark gives 0, and a full page of new bookmarks gives "more"', async () => {
  assert.deepEqual(await changes(fakeService([1, 2]), 'u', fakeCall([2, 1]).call), { added: 0, more: false });
  const all = Array.from({ length: QUICK_SIZE }, (_, i) => 100 + i);
  assert.deepEqual(await changes(fakeService([1]), 'u', fakeCall(all).call), { added: QUICK_SIZE, more: true });
});

test('quick check: an empty library that loaded is not loaded again, so its first new bookmark counts', async () => {
  // The cache is loaded and empty. A reload would call Raindrop outside the fake and fail the test.
  const svc = fakeService([]);
  svc.cache.get('u').at = Date.now() - 10 * 60 * 1000; // older than the cache time: loadAll would reload it
  const { call, calls } = fakeCall([7]);
  assert.deepEqual(await changes(svc, 'u', call), { added: 1, more: false });
  assert.equal(calls.length, 1);
  assert.equal(svc.cache.get('u').items.length, 0, 'the memory does not change');
});

test('quick check: the answer is kept for 60 seconds, and a full check clears it', async () => {
  const svc = fakeService([1]);
  const { call, calls } = fakeCall([2, 1]);
  await changes(svc, 'u', call);
  await changes(svc, 'u', call);
  assert.equal(calls.length, 1);
  forgetChanges(svc, 'u');
  await changes(svc, 'u', call);
  assert.equal(calls.length, 2);
});

test('quick check: the route takes no queue turn, and the full check clears the kept answer', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /if \(method === 'GET' && path === '\/api\/changes'\) return sendJson\(res, 200, await bookmarks\.changes\(svc, userId\)\);/);
  assert.match(server, /const found = await bookmarks\.pull\(svc, userId\);\n\s*bookmarks\.forgetChanges\(svc, userId\);/);
});

test('quick check page: the load imports by itself; in the session, only a label every 3 minutes', () => {
  const js = pageScript();
  // Page load: the quick check, then the full check before the list when there are new bookmarks.
  assert.match(js, /const d = await quickCheck\(\);\n\s*if \(d\?\.added && await pullNow\(\)\) return;\n\s*await refreshMeta\(\{followDefault: true\}\);\n\s*await run\(\);/);
  // Session: only when the tab shows and the browser is online, at most every 3 minutes, and never a load.
  assert.match(js, /const QUICK_MS = 3 \* 60 \* 1000;/);
  assert.match(js, /if \(!loaded \|\| !me\?\.connected \|\| pulling \|\| document\.hidden \|\| !navigator\.onLine\) return;/);
  assert.match(js, /showPullLabel\(await quickCheck\(\)\);/);
  assert.match(js, /document\.addEventListener\('visibilitychange', quickTick\);/);
  assert.match(js, /window\.addEventListener\('online', quickTick\);/);
  const tick = /async function quickTick\(\) \{[\s\S]*?\n\}/.exec(js)[0];
  assert.doesNotMatch(tick, /pullNow|run\(/);
  assert.match(js, /Check for new bookmarks <span class="badge new pull-new">\$\{n\} new<\/span>/);
  assert.match(js, /\$\('pull'\)\.onclick = \(\) => pullNow\(\)/);
});
