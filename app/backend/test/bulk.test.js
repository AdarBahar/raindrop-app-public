import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelJob, getJob, jobView, startJob } from '../src/bulk.js';
import { config } from '../src/config.js';
import { serialize } from '../src/util.js';

const USER = 'u';
const collections = [[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']];

// A service with a fresh cache, so no Raindrop call is made to load bookmarks.
function fakeService(items) {
  const svc = {
    cache: new Map(),
    log: [],
    removed: [],
    store: {
      removeNew: async (user, id) => svc.removed.push(id),
      profile: async () => [],
      addLog: async (user, entry) => svc.log.push(entry),
      keptDuplicates: () => [], newItems: () => new Set(),
      visits: () => new Map(),
    },
  };
  svc.cache.set(USER, {
    at: Date.now(),
    items,
    collections: new Map(collections),
    progress: { loaded: 0, total: 0 },
    loading: null,
  });
  return svc;
}

// A fake Raindrop call that records each request. Failures are given by id.
function fakeCall({ fail = [], beforeCall, live = {} } = {}) {
  const calls = []; // writes only
  const reads = []; // GET of one bookmark, by id
  const call = async (svc, user, method, path, body) => {
    if (method === 'GET') {
      const id = Number(path.split('/').pop());
      reads.push(id);
      if (live[id]) return { item: live[id] };
      const cached = svc.cache.get(user).items.find((i) => i._id === id);
      return { item: cached ? { ...cached } : undefined };
    }
    calls.push({ method, path, body });
    if (beforeCall) beforeCall(calls.length);
    if (body?.ids?.some((id) => fail.includes(id))) throw new Error('Raindrop refused the batch.');
    if (fail.includes(Number(path.split('/').pop()))) throw new Error('Raindrop refused the bookmark.');
    return {};
  };
  return { calls, reads, call };
}

// Wait until the job leaves the running state.
async function finished(svc, job) {
  for (let i = 0; i < 500; i++) {
    const current = getJob(svc, USER, job.id);
    if (current.status !== 'running') return current;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not finish');
}

const day = new Date().toISOString();
const item = (id, folder, tags, title = `bookmark ${id}`) => ({
  _id: id, title, link: `https://example.com/${id}`, domain: 'example.com', tags,
  collection: { $id: folder }, created: day, excerpt: '', note: '',
});

test('move: bookmarks already in the folder are not sent', async () => {
  const svc = fakeService([item(1, 10, []), item(2, 20, []), item(3, 20, [])]);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'move', ids: [1, 2, 3], folderId: 20 }, call);
  const done = await finished(svc, job);

  assert.equal(done.status, 'done');
  assert.equal(done.done, 3);
  assert.deepEqual(done.failed, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { ids: [1], collection: { $id: 20 } });
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(svc.log.length, 1);
  assert.deepEqual(svc.removed, [1]);
});

test('add tags: the bulk call appends, and a bookmark that has the tags is skipped', async () => {
  const svc = fakeService([item(1, 10, ['ai']), item(2, 10, ['ai', 'news'])]);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'addTags', ids: [1, 2], tags: ['news'] }, call);
  await finished(svc, job);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { ids: [1], tags: ['news'] });
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['ai', 'news']);
});

test('add tags: a bookmark that would pass the tag limit fails, the others go on', async () => {
  const full = Array.from({ length: config.limits.tagsPerBookmark }, (_, i) => `t${i}`);
  const svc = fakeService([item(1, 10, full), item(2, 10, [])]);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'addTags', ids: [1, 2], tags: ['extra'] }, call);
  const done = await finished(svc, job);

  assert.equal(done.status, 'done');
  assert.equal(done.failed.length, 1);
  assert.equal(done.failed[0].id, 1);
  assert.deepEqual(calls[0].body.ids, [2]);
});

test('remove tags: one single update for each bookmark that has the tag', async () => {
  const svc = fakeService([item(1, 10, ['a', 'b']), item(2, 10, ['c']), item(3, 10, ['A', 'd'])]);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'removeTags', ids: [1, 2, 3], tags: ['a'] }, call);
  await finished(svc, job);

  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['PUT', '/raindrop/1', { tags: ['b'] }],
    ['PUT', '/raindrop/3', { tags: ['d'] }],
  ]);
});

test('filter selection uses every match, not only the first page', async () => {
  const many = Array.from({ length: 120 }, (_, i) => item(i + 1, 10, ['ai'], `ai post ${i}`));
  many.push(item(999, 20, ['other'], 'business note'));
  const svc = fakeService(many);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'addTags', filter: { tags: 'ai' }, tags: ['seen'] }, call);
  const done = await finished(svc, job);

  assert.equal(done.total, 120);
  assert.equal(done.done, 120);
  assert.equal(calls.reduce((n, c) => n + c.body.ids.length, 0), 120);
  assert.equal(calls.length, 2); // batches of 100
});

test('filter selection keeps the kind of the status "needs"', async () => {
  // 1: no folder, no tags. 2: no folder, a tag. 3: a folder, no tags.
  const svc = fakeService([item(1, -1, []), item(2, -1, ['x']), item(3, 10, [])]);
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'addTags', filter: { status: 'needs', needs: 'both' }, tags: ['seen'] }, call);
  const done = await finished(svc, job);
  assert.equal(done.total, 1);
  assert.deepEqual(calls[0].body.ids, [1]);
});

test('a failed batch marks its bookmarks and the next batch still runs', async () => {
  const many = Array.from({ length: 150 }, (_, i) => item(i + 1, 10, []));
  const svc = fakeService(many);
  const { call } = fakeCall({ fail: [1] });
  const job = await startJob(svc, USER, { action: 'move', ids: many.map((m) => m._id), folderId: 20 }, call);
  const done = await finished(svc, job);

  assert.equal(done.status, 'done');
  assert.equal(done.failed.length, 100);
  assert.equal(done.done, 150);
});

test('cancel stops before the next batch; bookmarks already changed stay changed', async () => {
  const many = Array.from({ length: 250 }, (_, i) => item(i + 1, 10, []));
  const svc = fakeService(many);
  // Cancel the running job during its first Raindrop call.
  const { calls, call } = fakeCall({
    beforeCall: (n) => { if (n === 1) for (const j of svc.jobs.values()) cancelJob(svc, USER, j.id); },
  });
  const job = await startJob(svc, USER, { action: 'move', ids: many.map((m) => m._id), folderId: 20 }, call);
  const done = await finished(svc, job);

  assert.equal(done.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(done.done, 100);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(svc.cache.get(USER).items[150].collection.$id, 10);
});

test('a job belongs to one user', async () => {
  const svc = fakeService([item(1, 10, [])]);
  const { call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, call);
  await finished(svc, job);
  assert.equal(getJob(svc, 'someone-else', job.id), null);
  assert.equal(jobView(getJob(svc, USER, job.id)).status, 'done');
});

test('invalid requests are refused before any change', async () => {
  const svc = fakeService([item(1, 10, [])]);
  const { calls, call } = fakeCall();
  const refuse = (body, text) => assert.rejects(startJob(svc, USER, body, call), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, text);
    return true;
  });
  await refuse({ action: 'delete', ids: [1] }, /Unknown bulk action/);
  await refuse({ action: 'move', ids: [1], folderId: 999 }, /Unknown folder/);
  await refuse({ action: 'move', ids: [], folderId: 20 }, /No bookmarks/);
  await refuse({ action: 'move', ids: ['x'], folderId: 20 }, /whole numbers/);
  await refuse({ action: 'addTags', ids: [1], tags: [' '] }, /at least one tag/);
  await refuse({ action: 'addTags', ids: [1], tags: ['a,b'] }, /commas/);
  await refuse({ action: 'addTags', ids: [1], tags: ['x'.repeat(config.limits.tagLength + 1)] }, /characters/);
  await refuse({ action: 'move', folderId: 20 }, /Choose bookmarks/);
  const many = Array.from({ length: config.bulkMax + 1 }, (_, i) => i + 1);
  await refuse({ action: 'move', ids: many, folderId: 20 }, /at most 1000/);
  assert.equal(calls.length, 0);
});

// A fake Raindrop that keeps tag state. The bulk call appends tags. A single update replaces them.
function statefulRaindrop(tagsById) {
  const state = new Map(Object.entries(tagsById).map(([id, tags]) => [Number(id), [...tags]]));
  const call = async (svc, user, method, path, body) => {
    await new Promise((r) => setTimeout(r, 5)); // let two jobs overlap
    if (method === 'GET') {
      const id = Number(path.split('/').pop());
      return { item: { _id: id, tags: [...state.get(id)], collection: { $id: 10 } } };
    }
    if (path === '/raindrops/0' && body.tags) {
      for (const id of body.ids) state.set(id, [...new Set([...state.get(id), ...body.tags])]);
    } else if (path === '/raindrops/0') {
      for (const id of body.ids) state.set(id, state.get(id));
    } else {
      state.set(Number(path.split('/').pop()), [...body.tags]);
    }
    return {};
  };
  return { state, call };
}

test('overlapping jobs do not lose each other\'s tag changes', async () => {
  const svc = fakeService([item(1, 10, ['a', 'b'])]);
  const raindrop = statefulRaindrop({ 1: ['a', 'b'] });
  const adding = await startJob(svc, USER, { action: 'addTags', ids: [1], tags: ['c'] }, raindrop.call);
  const removing = await startJob(svc, USER, { action: 'removeTags', ids: [1], tags: ['a'] }, raindrop.call);
  await finished(svc, adding);
  await finished(svc, removing);

  assert.deepEqual(raindrop.state.get(1).sort(), ['b', 'c']);
  assert.deepEqual(svc.cache.get(USER).items[0].tags.sort(), ['b', 'c']);
});

test('a failed log write does not stop the batch or hide the changes', async () => {
  const svc = fakeService([item(1, 10, []), item(2, 10, [])]);
  svc.store.addLog = async () => { throw new Error('database is down'); };
  const { call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, call);
  const done = await finished(svc, job);

  assert.equal(done.status, 'done');
  assert.equal(done.done, 2);
  assert.deepEqual(done.failed, []);
  assert.equal(done.warnings.length, 2);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(svc.cache.get(USER).items[1].collection.$id, 20);
});

test('a job cancelled while it waits in the queue makes no Raindrop call', async () => {
  const svc = fakeService([item(1, 10, [])]);
  // Hold this user's queue, so the job has to wait behind it.
  let release;
  const held = serialize(USER, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 5));
  const { calls, call } = fakeCall();
  const job = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, call);
  cancelJob(svc, USER, job.id);
  release();
  await held;
  const done = await finished(svc, job);

  assert.equal(done.status, 'cancelled');
  assert.equal(calls.length, 0);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 10);
});
