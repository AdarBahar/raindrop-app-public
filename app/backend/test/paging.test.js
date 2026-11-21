import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/bookmarks.js';
import { RequestError } from '../src/util.js';

const USER = 'u';

// A cache that is always fresh, so no Raindrop call is made.
function fakeService(count) {
  const items = Array.from({ length: count }, (_, i) => ({
    _id: i + 1,
    title: `bookmark ${i + 1}`,
    link: `https://example.com/${i + 1}`,
    domain: 'example.com',
    tags: [],
    collection: { $id: 10 },
    created: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
  }));
  return {
    cache: new Map([[USER, {
      at: Date.now(),
      items,
      collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    }]]),
    store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() },
  };
}

test('the first page holds 50 bookmarks by default, with the page count', async () => {
  const result = await search(fakeService(120), USER, {});
  assert.equal(result.results.length, 50);
  assert.equal(result.total, 120);
  assert.equal(result.matched, 120);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.pages, 3);
});

test('the last page holds the rest', async () => {
  const result = await search(fakeService(120), USER, { page: '3' });
  assert.equal(result.results.length, 20);
  assert.equal(result.page, 3);
});

test('a page past the end is empty, and the page count is still correct', async () => {
  const result = await search(fakeService(120), USER, { page: '4' });
  assert.equal(result.results.length, 0);
  assert.equal(result.pages, 3);
  assert.equal(result.matched, 120);
});

test('the pages join up to the full list, in order', async () => {
  const svc = fakeService(120);
  const everything = (await search(svc, USER, { pageSize: '100' })).results.concat(
    (await search(svc, USER, { pageSize: '100', page: '2' })).results,
  );
  const paged = [];
  for (let page = 1; page <= 5; page++) {
    paged.push(...(await search(svc, USER, { pageSize: '25', page: String(page) })).results);
  }
  assert.deepEqual(paged.map((r) => r.id), everything.map((r) => r.id));
  assert.equal(paged.length, 120);
});

test('the list has no cap: every bookmark can be reached', async () => {
  const result = await search(fakeService(600), USER, { pageSize: '100', page: '6' });
  assert.equal(result.results.length, 100);
  assert.equal(result.matched, 600);
  assert.equal(result.pages, 6);
});

test('no bookmark matches: one empty page', async () => {
  const result = await search(fakeService(10), USER, { q: 'nothing like this' });
  assert.equal(result.results.length, 0);
  assert.equal(result.pages, 1);
  assert.equal(result.page, 1);
});

test('the allowed page sizes work, and other sizes are refused', async () => {
  for (const size of ['25', '50', '100']) {
    assert.equal((await search(fakeService(120), USER, { pageSize: size })).pageSize, Number(size));
  }
  await assert.rejects(search(fakeService(10), USER, { pageSize: '30' }), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.status, 400);
    assert.match(err.message, /25, 50, 100/);
    return true;
  });
});

test('a page that is not a whole number from 1 is refused', async () => {
  for (const page of ['0', '-1', '1.5', 'abc']) {
    await assert.rejects(search(fakeService(10), USER, { page }), (err) => {
      assert.ok(err instanceof RequestError);
      assert.equal(err.status, 400);
      return true;
    });
  }
});
