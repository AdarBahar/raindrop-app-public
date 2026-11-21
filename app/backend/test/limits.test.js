import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFolder, save, search } from '../src/bookmarks.js';
import { getJob, startJob } from '../src/bulk.js';
import { config } from '../src/config.js';
import { checkFolderName, checkSearchText, checkTagFilter, checkTags } from '../src/limits.js';
import { RequestError } from '../src/util.js';

const { limits } = config;
const USER = 'u';

// A cache that is always fresh, so no Raindrop call is made to load bookmarks.
function fakeService() {
  const svc = {
    cache: new Map(),
    store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() },
  };
  svc.cache.set(USER, {
    at: Date.now(),
    items: [{ _id: 1, title: 'one', link: 'https://example.com/1', tags: [], collection: { $id: 10 }, created: new Date().toISOString() }],
    collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
    progress: { loaded: 0, total: 0 },
    loading: null,
  });
  return svc;
}

// Assert that a call fails with a 400 whose message matches.
async function refused(promise, text) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof RequestError, `expected RequestError, got ${err}`);
    assert.equal(err.status, 400);
    assert.match(err.message, text);
    return true;
  });
}

test('search text: 200 characters is allowed, 201 is refused', () => {
  checkSearchText('x'.repeat(limits.searchLength));
  assert.throws(() => checkSearchText('x'.repeat(limits.searchLength + 1)), /at most 200 characters/);
});

test('tag filter: 10 tags is allowed, 11 is refused', () => {
  checkTagFilter(Array.from({ length: limits.tagsPerFilter }, (_, i) => `t${i}`));
  assert.throws(() => checkTagFilter(Array.from({ length: limits.tagsPerFilter + 1 }, (_, i) => `t${i}`)), /at most 10 tags/);
});

test('tags: length, commas and count are checked at the limit', () => {
  checkTags(['x'.repeat(limits.tagLength)]);
  assert.throws(() => checkTags(['x'.repeat(limits.tagLength + 1)]), /at most 50 characters/);
  assert.throws(() => checkTags(['a,b']), /cannot contain commas/);
  checkTags(Array.from({ length: limits.tagsPerBookmark }, (_, i) => `t${i}`));
  assert.throws(() => checkTags(Array.from({ length: limits.tagsPerBookmark + 1 }, (_, i) => `t${i}`)), /at most 20 tags/);
});

test('folder name: empty is refused, 100 characters is allowed, 101 is refused', () => {
  assert.throws(() => checkFolderName(''), /folder name is empty/);
  checkFolderName('x'.repeat(limits.folderName));
  assert.throws(() => checkFolderName('x'.repeat(limits.folderName + 1)), /at most 100 characters/);
});

test('a long search text is refused by the search', async () => {
  await refused(search(fakeService(), USER, { q: 'x'.repeat(201) }), /at most 200 characters/);
});

test('a save with too many tags is refused before any Raindrop call', async () => {
  const tags = Array.from({ length: limits.tagsPerBookmark + 1 }, (_, i) => `t${i}`);
  // No Raindrop call is possible in this service. A call would fail with a different error.
  await refused(save(fakeService(), USER, 1, 10, tags), /at most 20 tags/);
});

test('a folder name that is too long is refused before any Raindrop call', async () => {
  await refused(createFolder(fakeService(), USER, 'x'.repeat(101)), /at most 100 characters/);
  await refused(createFolder(fakeService(), USER, '   '), /folder name is empty/);
});

// A service with no cache. If a bookmark load starts, it fails with a different error.
function coldService() {
  return { cache: new Map(), store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() } };
}

test('bad input is refused before the bookmarks load', async () => {
  await refused(search(coldService(), USER, { q: 'x'.repeat(201) }), /at most 200 characters/);
  await refused(search(coldService(), USER, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') }), /at most 10 tags/);
  await refused(save(coldService(), USER, 1, 10, ['a,b']), /cannot contain commas/);
  await refused(createFolder(coldService(), USER, 'x'.repeat(101)), /at most 100 characters/);
  await refused(startJob(coldService(), USER, { action: 'addTags', ids: [1], tags: ['x'.repeat(51)] }), /at most 50 characters/);
  await refused(startJob(coldService(), USER, { action: 'removeTags', ids: [1], tags: ['a,b'] }), /cannot contain commas/);
});

test('removing many distinct tags is allowed when each bookmark keeps the limit', async () => {
  const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
  const svc = fakeService();
  svc.cache.get(USER).items = tags.map((tag, i) => ({
    _id: i + 1, title: `bookmark ${i + 1}`, link: 'https://example.com/x', tags: [tag],
    collection: { $id: 10 }, created: new Date().toISOString(),
  }));
  const calls = [];
  const call = async (s, u, method, path) => {
    if (method === 'GET') return { item: { ...s.cache.get(u).items.find((x) => x._id === Number(path.split('/').pop())) } };
    calls.push(path);
    return {};
  };
  const job = await startJob(svc, USER, { action: 'removeTags', ids: svc.cache.get(USER).items.map((i) => i._id), tags }, call);
  let done = getJob(svc, USER, job.id);
  for (let i = 0; i < 500 && done.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 2));
    done = getJob(svc, USER, job.id);
  }

  assert.equal(done.status, 'done');
  assert.equal(done.done, 21);
  assert.deepEqual(done.failed, []);
  assert.equal(calls.length, 21);
});

test('a bulk filter is checked before the bookmarks load', async () => {
  await refused(startJob(coldService(), USER, { action: 'move', folderId: 10, filter: { q: 'x'.repeat(201) } }), /at most 200 characters/);
  await refused(startJob(coldService(), USER, { action: 'move', folderId: 10, filter: { tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') } }), /at most 10 tags/);
  await refused(startJob(coldService(), USER, { action: 'move', folderId: 10, ids: ['x'] }), /whole numbers/);
});

test('a bulk filter still selects the matching bookmarks', async () => {
  const svc = fakeService();
  svc.cache.get(USER).items = [
    { _id: 1, title: 'alpha', link: 'https://example.com/1', tags: ['keep'], collection: { $id: 10 }, created: new Date().toISOString() },
    { _id: 2, title: 'beta', link: 'https://example.com/2', tags: [], collection: { $id: 10 }, created: new Date().toISOString() },
  ];
  const calls = [];
  const call = async (s, u, method, path) => { calls.push(path); return {}; };
  const job = await startJob(svc, USER, { action: 'addTags', filter: { tags: 'keep' }, tags: ['seen'] }, call);
  let done = getJob(svc, USER, job.id);
  for (let i = 0; i < 500 && done.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 2));
    done = getJob(svc, USER, job.id);
  }
  assert.equal(done.total, 1);
  assert.equal(done.status, 'done');
});
