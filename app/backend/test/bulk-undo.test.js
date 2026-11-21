import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJob, jobView, startJob, startUndo } from '../src/bulk.js';
import { RequestError } from '../src/util.js';

const USER = 'u';

// A cache that is always fresh, so no Raindrop call is made to load bookmarks.
function fakeService(items) {
  const svc = {
    cache: new Map([[USER, {
      at: Date.now(),
      items,
      collections: new Map([[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    }]]),
    log: [],
    store: {
      removeNew: async () => {},
      addLog: async (user, entry) => svc.log.push(entry),
      keptDuplicates: () => [], newItems: () => new Set(),
      visits: () => new Map(),
    },
  };
  return svc;
}

const item = (id, folder, tags) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, domain: 'example.com',
  tags, collection: { $id: folder }, created: new Date().toISOString(), excerpt: '', note: '',
});

// A fake Raindrop with its own copy of each bookmark, separate from the cache. A single update
// replaces the folder and the tags. A bulk update sets the folder, or appends the tags. A single
// read returns the copy. `remote` lets a test change a bookmark in Raindrop behind the cache.
function fakeRaindrop(svc) {
  const calls = [];
  const remote = new Map(svc.cache.get(USER).items.map((i) => [i._id, structuredClone(i)]));
  const call = async (s, user, method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/raindrops/0') {
      for (const id of body.ids) {
        const found = remote.get(id);
        if (!found) continue;
        if (body.collection) found.collection = { $id: body.collection.$id };
        if (body.tags) found.tags = [...new Set([...found.tags, ...body.tags])];
      }
      return {};
    }
    const found = remote.get(Number(path.split('/').pop()));
    if (method === 'GET') return found ? { item: structuredClone(found) } : {};
    if (found) {
      if (body.collection) found.collection = { $id: body.collection.$id };
      if (body.tags) found.tags = [...body.tags];
    }
    return {};
  };
  return { calls, call, remote };
}

async function finished(svc, job) {
  let current = getJob(svc, USER, job.id);
  for (let i = 0; i < 500 && current.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 2));
    current = getJob(svc, USER, job.id);
  }
  return current;
}

test('undo restores the folder and the tags that a move changed', async () => {
  const svc = fakeService([item(1, 10, ['a']), item(2, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, raindrop.call);
  await finished(svc, move);
  assert.equal(jobView(move).undoable, true);

  const undo = await startUndo(svc, USER, move.id, raindrop.call);
  const done = await finished(svc, undo);
  assert.equal(done.status, 'done');
  assert.equal(done.done, 2);
  assert.equal(jobView(getJob(svc, USER, move.id)).undoable, false);
  const items = svc.cache.get(USER).items;
  assert.equal(items[0].collection.$id, 10);
  assert.deepEqual(items[0].tags, ['a']);
  assert.equal(items[1].collection.$id, 10);
});

test('undo restores the exact tags after a tag removal', async () => {
  const svc = fakeService([item(1, 10, ['a', 'b', 'c'])]);
  const raindrop = fakeRaindrop(svc);
  const removal = await startJob(svc, USER, { action: 'removeTags', ids: [1], tags: ['a', 'c'] }, raindrop.call);
  await finished(svc, removal);
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['b']);

  const undo = await startUndo(svc, USER, removal.id, raindrop.call);
  await finished(svc, undo);
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['a', 'b', 'c']);
});

test('undo skips a bookmark that moved to another folder after the job', async () => {
  const svc = fakeService([item(1, 10, ['a']), item(2, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, raindrop.call);
  await finished(svc, move);
  // The user moves bookmark 1 again in this app, after the job. Raindrop and the cache both change.
  raindrop.remote.get(1).collection = { $id: 30 };
  svc.cache.get(USER).items[0].collection = { $id: 30 };

  const undo = await startUndo(svc, USER, move.id, raindrop.call);
  const done = await finished(svc, undo);
  assert.equal(done.status, 'done');
  assert.equal(done.done, 2);
  assert.equal(done.failed.length, 1);
  assert.equal(done.failed[0].id, 1);
  assert.match(done.failed[0].reason, /Changed after the update/);
  assert.deepEqual(raindrop.calls.filter((c) => c.path === '/raindrop/1' && c.method === 'PUT'), []);
  const items = svc.cache.get(USER).items;
  assert.equal(items[0].collection.$id, 30); // the newer move stays
  assert.equal(raindrop.remote.get(1).collection.$id, 30);
  assert.equal(items[1].collection.$id, 10); // the other bookmark is restored
  assert.equal(raindrop.remote.get(2).collection.$id, 10);
  // The skipped bookmark is finished. The job cannot be undone again.
  assert.equal(jobView(getJob(svc, USER, move.id)).undoable, false);
});

test('undo skips a bookmark whose tags changed after the job', async () => {
  const svc = fakeService([item(1, 10, ['a'])]);
  const raindrop = fakeRaindrop(svc);
  const add = await startJob(svc, USER, { action: 'addTags', ids: [1], tags: ['b'] }, raindrop.call);
  await finished(svc, add);
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['a', 'b']);
  // The user edits the tags in this app, after the job.
  raindrop.remote.get(1).tags = ['a', 'b', 'c'];
  svc.cache.get(USER).items[0].tags = ['a', 'b', 'c'];

  const undo = await startUndo(svc, USER, add.id, raindrop.call);
  const done = await finished(svc, undo);
  assert.equal(done.failed.length, 1);
  assert.match(done.failed[0].reason, /Changed after the update/);
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['a', 'b', 'c']);
  assert.deepEqual(raindrop.remote.get(1).tags, ['a', 'b', 'c']);
});

test('undo reads the live bookmark, so an edit made in Raindrop itself is kept too', async () => {
  const svc = fakeService([item(1, 10, ['a']), item(2, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, raindrop.call);
  await finished(svc, move);
  // The user edits bookmark 1 in Raindrop, not in this app. The cache still shows the state after the job.
  raindrop.remote.get(1).tags = ['a', 'z'];
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['a']);

  const undo = await startUndo(svc, USER, move.id, raindrop.call);
  const done = await finished(svc, undo);
  assert.equal(done.status, 'done');
  assert.equal(done.failed.length, 1);
  assert.equal(done.failed[0].id, 1);
  assert.match(done.failed[0].reason, /Changed after the update/);
  assert.deepEqual(raindrop.calls.filter((c) => c.path === '/raindrop/1' && c.method === 'PUT'), []);
  // Raindrop keeps the edit. The cache now shows it. The other bookmark is restored.
  assert.deepEqual(raindrop.remote.get(1).tags, ['a', 'z']);
  assert.equal(raindrop.remote.get(1).collection.$id, 20);
  assert.deepEqual(svc.cache.get(USER).items[0].tags, ['a', 'z']);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(raindrop.remote.get(2).collection.$id, 10);
  assert.equal(svc.cache.get(USER).items[1].collection.$id, 10);
});

test('undo reports a bookmark that Raindrop no longer has', async () => {
  const svc = fakeService([item(1, 10, ['a'])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, raindrop.call);
  await finished(svc, move);
  raindrop.remote.delete(1);

  const done = await finished(svc, await startUndo(svc, USER, move.id, raindrop.call));
  assert.equal(done.failed.length, 1);
  assert.match(done.failed[0].reason, /Bookmark not found/);
});

test('a job can be undone only once', async () => {
  const svc = fakeService([item(1, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, raindrop.call);
  await finished(svc, move);
  await finished(svc, await startUndo(svc, USER, move.id, raindrop.call));
  await assert.rejects(startUndo(svc, USER, move.id, raindrop.call), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.status, 409);
    assert.match(err.message, /already undone/);
    return true;
  });
});

test('a running job cannot be undone yet', async () => {
  const svc = fakeService([item(1, 10, []), item(2, 10, [])]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return {}; };
  const move = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, slow);
  await assert.rejects(startUndo(svc, USER, move.id, slow), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /still running/);
    return true;
  });
  release();
  await finished(svc, move);
});

test('an unknown job cannot be undone, and a job with no changes has nothing to undo', async () => {
  const svc = fakeService([item(1, 20, [])]);
  const raindrop = fakeRaindrop(svc);
  await assert.rejects(startUndo(svc, USER, '00000000-0000-4000-8000-000000000000', raindrop.call), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  // Moving a bookmark into the folder it is already in changes nothing.
  const noop = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, raindrop.call);
  await finished(svc, noop);
  assert.equal(jobView(noop).undoable, false);
  await assert.rejects(startUndo(svc, USER, noop.id, raindrop.call), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /Nothing to undo/);
    return true;
  });
});

test('a failed undo can be retried, and only the unfinished bookmarks are restored again', async () => {
  const svc = fakeService([item(1, 10, []), item(2, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1, 2], folderId: 20 }, raindrop.call);
  await finished(svc, move);

  // The first undo fails for bookmark 1 only, once.
  let failOnce = true;
  const flaky = async (s, u, method, path, body) => {
    if (path === '/raindrop/1' && failOnce) { failOnce = false; throw new Error('temporary'); }
    return raindrop.call(s, u, method, path, body);
  };
  const first = await startUndo(svc, USER, move.id, flaky);
  const firstDone = await finished(svc, first);
  assert.equal(firstDone.failed.length, 1);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(jobView(getJob(svc, USER, move.id)).undoable, true);

  const retry = await startUndo(svc, USER, move.id, raindrop.call);
  const retryDone = await finished(svc, retry);
  assert.equal(retryDone.status, 'done');
  assert.equal(retryDone.total, 1);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 10);
  assert.equal(jobView(getJob(svc, USER, move.id)).undoable, false);
});

test('an undo cancelled while it waits in the queue changes nothing', async () => {
  const svc = fakeService([item(1, 10, [])]);
  const raindrop = fakeRaindrop(svc);
  const move = await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, raindrop.call);
  await finished(svc, move);

  // Hold this user's queue, so the undo has to wait behind it.
  const { serialize } = await import('../src/util.js');
  let release;
  const held = serialize(USER, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 5));
  const undo = await startUndo(svc, USER, move.id, raindrop.call);
  const { cancelJob } = await import('../src/bulk.js');
  cancelJob(svc, USER, undo.id);
  release();
  await held;
  const done = await finished(svc, undo);

  assert.equal(done.status, 'cancelled');
  assert.equal(done.done, 0);
  assert.equal(svc.cache.get(USER).items[0].collection.$id, 20);
  assert.equal(jobView(getJob(svc, USER, move.id)).undoable, true);
});
