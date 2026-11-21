import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { fetchAllItems, fetchCollections, remoteCount } from '../src/raindrop-fetch.js';

// A fake call function that records each path and answers from a table.
function fakeCall(answer) {
  const paths = [];
  const call = async (_svc, _userId, method, path) => {
    assert.equal(method, 'GET');
    paths.push(path);
    return answer(path);
  };
  return { call, paths };
}

test('fetchCollections reads the root folders, then the child folders', async () => {
  const { call, paths } = fakeCall((path) =>
    path === '/collections' ? { items: [{ _id: 1 }, { _id: 2 }] } : { items: [{ _id: 3 }] },
  );
  const all = await fetchCollections({}, 'u', call);
  assert.deepEqual(all.map((c) => c._id), [1, 2, 3]);
  assert.deepEqual(paths, ['/collections', '/collections/childrens']);
});

test('remoteCount gives the count of _id 0, or null when it is missing or not valid', async () => {
  const count = (items) => remoteCount({}, 'u', fakeCall(() => ({ items })).call);
  assert.equal(await count([{ _id: -1, count: 5 }, { _id: 0, count: 7 }]), 7);
  assert.equal(await count([{ _id: -1, count: 5 }]), null);
  assert.equal(await count([{ _id: 0, count: -1 }]), null);
  assert.equal(await count(undefined), null);
});

test('fetchAllItems reads pages until a short page, and reports the count after each page', async () => {
  const size = config.pageSize;
  const pages = [size, size, 2];
  const { call, paths } = fakeCall((path) => {
    const page = Number(new URL(path, 'http://x').searchParams.get('page'));
    return { items: Array.from({ length: pages[page] }, (_, i) => ({ _id: page * size + i })) };
  });
  const seen = [];
  const items = await fetchAllItems({}, 'u', call, { onPage: (n) => seen.push(n) });
  assert.equal(items.length, 2 * size + 2);
  assert.deepEqual(seen, [size, 2 * size, 2 * size + 2]);
  assert.equal(paths.length, 3);
});

test('fetchAllItems stops before the next request when beforePage throws', async () => {
  const { call, paths } = fakeCall(() => ({ items: Array.from({ length: config.pageSize }, (_, i) => ({ _id: i })) }));
  let n = 0;
  const stop = () => {
    if (++n === 2) throw new Error('stop');
  };
  await assert.rejects(fetchAllItems({}, 'u', call, { beforePage: stop }), /stop/);
  assert.equal(paths.length, 1);
});
