// The full sync (src/sync.js). Needs the test database. Raindrop is a fake that the test controls.
// The rules are in docs/bookmark-store-plan.md, sections 3, 5 and 6.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';
import { NotConnectedError } from '../src/oauth.js';
import { serialize } from '../src/util.js';
import { config } from '../src/config.js';
import {
  addTagsRaw, applyEffect, cancelSync, connectionGeneration, ensureSnapshot, moveRaw, recordEffect, retryDelayMs, storeVersion,
  beginConnectionChange, syncNow, syncProgress, updateRaw, writeThrough,
} from '../src/sync.js';

const live = JSON.parse(await readFile(new URL('./fixtures/raindrop-live-sample.json', import.meta.url), 'utf8'));
const USER = 'sync@example.test';
const NOW = new Date('2026-11-09T10:00:00.000Z');

const item = (id, over = {}) => ({
  _id: id, title: `Item ${id}`, link: `https://example.test/${id}`, tags: [],
  collection: { $ref: 'collections', $id: 10, oid: 10 }, collectionId: 10,
  created: new Date(Date.UTC(2026, 0, 1, 0, 0, id % 3600)).toISOString(), ...over,
});
const items = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i));
const folder = (id, title) => ({ _id: id, title, count: 0 });

// A fake Raindrop. world.items and world.collections are the answers. Hooks change the behavior.
function fakeRaindrop(world) {
  const calls = [];
  const call = async (_svc, _user, _method, path) => {
    calls.push(path);
    world.beforeCall?.(path, calls);
    if (world.failWhen?.(path, calls)) throw world.error ?? new Error('Raindrop failed');
    if (path === '/user/stats') {
      const index = calls.filter((p) => p === '/user/stats').length;
      return { items: [{ _id: 0, count: world.count?.(index) ?? world.items.length }] };
    }
    if (path === '/collections') return { items: world.collections };
    if (path === '/collections/childrens') return { items: [] };
    const match = path.match(/^\/raindrops\/0\?perpage=(\d+)&page=(\d+)$/);
    if (match) {
      const per = Number(match[1]);
      const page = Number(match[2]);
      await world.onPage?.(page);
      return { items: world.items.slice(page * per, (page + 1) * per) };
    }
    throw new Error(`Unexpected call: ${path}`);
  };
  return { call, calls };
}

describe('full sync', { skip: SKIP_REASON }, () => {
  let store;
  let schema;
  let svc;
  let world;
  let raindrop;
  let waits;
  const opts = () => ({ call: raindrop.call, wait: async (ms) => { waits.push(ms); }, now: () => NOW });
  const run = () => syncNow(svc, USER, opts());
  const stored = async () => new Map((await store.loadBookmarks(USER)).map((i) => [i._id, i]));
  const bump = () => svc.generations.set(USER, (svc.generations.get(USER) ?? 0) + 1);

  before(async () => {
    schema = await createTestSchema();
    const { openStore } = await import('../src/store.js');
    store = openStore({ url: TEST_URL, schema });
  });

  after(async () => {
    await store.close();
    await dropTestSchema(schema);
  });

  beforeEach(async () => {
    await store.deleteBookmarkStore(USER);
    svc = { store, generations: new Map(), syncs: new Map() };
    world = { items: items(1, 120), collections: [folder(10, 'Work'), folder(11, 'Home')] };
    raindrop = fakeRaindrop(world);
    waits = [];
  });

  describe('a good sync', () => {
    test('stores all pages and the folders, and records the success', async () => {
      assert.deepEqual(await run(), { bookmarks: 120, collections: 2 });
      assert.equal((await store.loadBookmarks(USER)).length, 120);
      assert.deepEqual((await store.loadCollections(USER)).map((c) => c.title).sort(), ['Home', 'Work']);
      assert.deepEqual(await store.getSyncState(USER), {
        lastFullAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString(), lastError: null, consecutiveFailures: 0, nextRetryAt: null,
      });
      assert.equal(svc.syncs.size, 0);
    });

    test('a second sync updates an edited bookmark and deletes a bookmark that Raindrop no longer has', async () => {
      await run();
      world.items = world.items.filter((i) => i._id !== 7).map((i) => (i._id === 8 ? { ...i, title: 'Edited' } : i));
      world.items.push(item(500));
      world.collections = [folder(10, 'Work')];
      await run();
      const rows = await stored();
      assert.equal(rows.size, 120);
      assert.equal(rows.has(7), false);
      assert.equal(rows.get(8).title, 'Edited');
      assert.equal(rows.has(500), true);
      assert.deepEqual((await store.loadCollections(USER)).map((c) => c._id), [10]);
    });

    test('stores the objects that the live Raindrop API returned, with no change', async () => {
      world.items = structuredClone(live.bookmarks);
      world.collections = structuredClone(live.collections);
      await run();
      const rows = await stored();
      for (const original of live.bookmarks) assert.deepEqual(rows.get(original._id), original);
      const collections = new Map((await store.loadCollections(USER)).map((c) => [c._id, c]));
      for (const original of live.collections) assert.deepEqual(collections.get(original._id), original);
    });

    test('a library of 0 bookmarks that synced is not a library that never synced', async () => {
      world.items = [];
      await run();
      assert.notEqual((await store.getSyncState(USER)).lastFullAt, null);
      assert.equal(waits.length, 0);
    });

    test('callers at the same time share one sync', async () => {
      const [a, b] = await Promise.all([run(), run()]);
      assert.deepEqual(a, b);
      assert.equal(raindrop.calls.filter((p) => p === '/collections').length, 1);
    });

    test('the progress shows the loaded and total bookmarks while the sync runs', async () => {
      const seen = [];
      world.onPage = async () => { seen.push(syncProgress(svc, USER)); };
      await run();
      assert.deepEqual(seen[0], { loaded: 0, total: 120 });
      assert.deepEqual(seen[2], { loaded: 100, total: 120 });
      assert.equal(syncProgress(svc, USER), null);
    });
  });

  describe('failures keep the old rows', () => {
    beforeEach(async () => {
      await run();
      raindrop.calls.length = 0; // the tests count the calls of their own sync
      waits.length = 0;
      world.items = items(1, 120).map((i) => ({ ...i, title: 'New title' }));
    });

    test('a failed page changes nothing and sets the retry time', async () => {
      world.failWhen = (path) => path.endsWith('page=1');
      await assert.rejects(run(), /Raindrop failed/);
      assert.equal((await stored()).get(1).title, 'Item 1');
      const state = await store.getSyncState(USER);
      assert.equal(state.consecutiveFailures, 1);
      assert.equal(state.lastError, 'Raindrop failed');
      assert.equal(state.nextRetryAt, '2026-11-09T11:00:00.000Z');
      assert.equal(state.lastFullAt, NOW.toISOString());
    });

    test('the retry time grows with each failure in a row, and a success clears it', async () => {
      world.failWhen = () => true;
      for (let i = 0; i < 5; i++) await assert.rejects(run(), /Raindrop failed/);
      const state = await store.getSyncState(USER);
      assert.equal(state.consecutiveFailures, 5);
      assert.equal(state.nextRetryAt, '2026-11-09T16:00:00.000Z');
      world.failWhen = null;
      await run();
      assert.deepEqual(
        [(await store.getSyncState(USER)).consecutiveFailures, (await store.getSyncState(USER)).nextRetryAt],
        [0, null],
      );
    });

    test('the delay is 1, 2, 4 and then 6 hours', () => {
      const hours = [1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n) / 3600000);
      assert.deepEqual(hours, [1, 2, 4, 6, 6, 6]);
    });

    test('a duplicate ID is retried and then refused', async () => {
      world.items = [...world.items.slice(0, 119), world.items[0]];
      await assert.rejects(run(), /failed a check after 3 tries: The snapshot has 1 duplicate/);
      assert.equal((await stored()).get(1).title, 'Item 1');
      assert.equal(raindrop.calls.filter((p) => p === '/collections').length, 3);
      assert.deepEqual(waits, [config.sync.retryWaitMs, config.sync.retryWaitMs]);
    });

    test('more fetched bookmarks than the count is refused', async () => {
      world.count = () => 119;
      await assert.rejects(run(), /The snapshot has 120 bookmarks. Raindrop reports 119/);
      assert.equal((await stored()).get(1).title, 'Item 1');
    });

    test('fewer fetched bookmarks than the count is refused, and no row is deleted', async () => {
      world.count = () => 125;
      await assert.rejects(run(), /The snapshot has 120 bookmarks. Raindrop reports 125/);
      assert.equal((await stored()).size, 120);
    });

    test('a missing count is refused', async () => {
      world.count = () => 'x';
      await assert.rejects(run(), /no count/);
    });

    test('a count that changes during the fetch is retried, and the next stable fetch is committed', async () => {
      // The first fetch reads 120 before and 121 after. The second fetch is stable.
      world.count = (index) => (index === 2 ? 121 : 120);
      assert.deepEqual(await run(), { bookmarks: 120, collections: 2 });
      assert.equal((await stored()).get(1).title, 'New title');
      assert.equal(waits.length, 1);
    });

    test('a bad row in a later batch rolls the whole commit back', async () => {
      // 1,200 bookmarks go to the database in two batches of 1,000 and 200. The second batch fails.
      world.items = items(1, 1200).map((i) => (i._id === 1100 ? { ...i, created: 'not a date' } : { ...i, title: 'New title' }));
      await assert.rejects(run(), /invalid input syntax|date\/time/);
      const rows = await stored();
      assert.equal(rows.size, 120);
      assert.equal(rows.get(1).title, 'Item 1');
      assert.equal(rows.has(1100), false);
      assert.equal((await store.getSyncState(USER)).consecutiveFailures, 1);
    });
  });

  describe('an empty answer for a populated library', () => {
    beforeEach(async () => {
      await run();
      world.items = [];
    });

    test('is checked again after a wait, and the delete happens only when both answers are empty', async () => {
      assert.deepEqual(await run(), { bookmarks: 0, collections: 2 });
      assert.deepEqual(waits, [config.sync.emptyRecheckMs]);
      assert.equal((await stored()).size, 0);
    });

    test('keeps the rows when the second answer has bookmarks', async () => {
      let fetches = 0;
      world.beforeCall = (path) => {
        if (path === '/collections') {
          fetches += 1;
          if (fetches === 2) world.items = items(1, 120);
        }
      };
      await assert.rejects(run(), /first returned an empty library/);
      assert.equal((await stored()).size, 120);
      assert.equal((await store.getSyncState(USER)).consecutiveFailures, 1);
    });

    test('keeps the rows when the count and the list disagree', async () => {
      world.count = () => 120;
      await assert.rejects(run(), /failed a check/);
      assert.equal((await stored()).size, 120);
    });
  });

  describe('changes during the fetch (the journal)', () => {
    // A write-through as the plan describes it: Raindrop accepted the change, then the journal and the
    // database write, inside a queue turn.
    const writeThrough = (effect) => serialize(USER, async () => {
      recordEffect(svc, USER, effect, 0);
      await applyEffect(store, USER, effect);
    });

    beforeEach(async () => {
      await run();
    });

    test('a save during the fetch is not lost', async () => {
      const saved = { ...item(5), title: 'Saved during the sync' };
      world.onPage = async (page) => { if (page === 1) await writeThrough({ type: 'upsert', item: saved }); };
      await run();
      assert.equal((await stored()).get(5).title, 'Saved during the sync');
    });

    test('two saves of one bookmark during the fetch: the last save is the final value', async () => {
      world.onPage = async (page) => {
        if (page === 1) {
          await writeThrough({ type: 'upsert', item: { ...item(5), title: 'First save' } });
          await writeThrough({ type: 'upsert', item: { ...item(5), title: 'Second save' } });
        }
      };
      await run();
      assert.equal((await stored()).get(5).title, 'Second save');
    });

    test('a bookmark that is deleted during the fetch stays deleted', async () => {
      world.onPage = async (page) => { if (page === 0) await writeThrough({ type: 'delete', ids: [5] }); };
      await run();
      assert.equal((await stored()).has(5), false);
    });

    test('an update followed by a delete leaves the bookmark deleted', async () => {
      world.onPage = async (page) => {
        if (page === 0) {
          await writeThrough({ type: 'upsert', item: { ...item(5), title: 'Changed' } });
          await writeThrough({ type: 'delete', ids: [5] });
        }
      };
      await run();
      assert.equal((await stored()).has(5), false);
    });

    test('a bulk move during the fetch keeps the new folder for all bookmarks', async () => {
      world.onPage = async (page) => { if (page === 2) await writeThrough({ type: 'move', ids: [1, 60, 110], collectionId: 11 }); };
      await run();
      const rows = await stored();
      for (const id of [1, 60, 110]) {
        assert.equal(rows.get(id).collection.$id, 11);
        assert.equal(rows.get(id).collectionId, 11);
      }
      assert.equal(rows.get(2).collection.$id, 10);
    });

    test('a bulk add of tags during the fetch adds each tag once', async () => {
      world.onPage = async (page) => { if (page === 0) await writeThrough({ type: 'addTags', ids: [1, 2], tags: ['new', 'NEW', 'x'] }); };
      await run();
      assert.deepEqual((await stored()).get(1).tags, ['new', 'x']);
    });

    test('a change whose database write failed is still applied by the commit', async () => {
      world.onPage = async (page) => {
        if (page === 1) await serialize(USER, async () => recordEffect(svc, USER, { type: 'upsert', item: { ...item(5), title: 'Journal only' } }, 0));
      };
      await run();
      assert.equal((await stored()).get(5).title, 'Journal only');
    });

    test('a change made in the queue while the commit waits is kept', async () => {
      let release;
      let held;
      const turn = new Promise((resolve) => { release = resolve; });
      // Hold the queue after the last page, so the commit has to wait.
      world.onPage = async (page) => {
        if (page === 2) held = serialize(USER, async () => { await turn; });
      };
      const sync = run();
      // Wait until the sync has fetched all pages and waits for the queue.
      while (!raindrop.calls.some((p) => p.endsWith('page=2'))) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));
      const write = serialize(USER, async () => {
        recordEffect(svc, USER, { type: 'upsert', item: { ...item(5), title: 'Written in the queue' } }, 0);
        await applyEffect(store, USER, { type: 'upsert', item: { ...item(5), title: 'Written in the queue' } });
      });
      release();
      await Promise.all([held, write, sync]);
      assert.equal((await stored()).get(5).title, 'Written in the queue');
    });

    test('a change after the commit is not kept in the journal of a finished sync', async () => {
      await run();
      recordEffect(svc, USER, { type: 'delete', ids: [5] }, 0);
      assert.equal(svc.syncs.size, 0);
    });
  });

  describe('disconnect and the connection generation', () => {
    test('a disconnect during the fetch discards the snapshot and writes no row and no state', async () => {
      world.onPage = async (page) => { if (page === 1) bump(); };
      await assert.rejects(run(), /connection changed/);
      assert.equal((await store.loadBookmarks(USER)).length, 0);
      assert.equal(await store.getSyncState(USER), null);
    });

    test('a disconnect while the commit waits for the queue discards the snapshot', async () => {
      let release;
      const turn = new Promise((resolve) => { release = resolve; });
      let held;
      world.onPage = async (page) => {
        if (page === 2) held = serialize(USER, async () => { await turn; bump(); });
      };
      const sync = run();
      const outcome = assert.rejects(sync, /connection changed/);
      await new Promise((r) => setTimeout(r, 80));
      release();
      await Promise.all([held, outcome]);
      assert.equal((await store.loadBookmarks(USER)).length, 0);
      assert.equal(await store.getSyncState(USER), null);
    });

    test('a failed old sync does not create a state row after a disconnect', async () => {
      world.failWhen = (path) => path.endsWith('page=1');
      world.onPage = async (page) => { if (page === 0) bump(); };
      await assert.rejects(run(), /Raindrop failed/);
      assert.equal(await store.getSyncState(USER), null);
    });

    test('a sync after a reconnect starts with the new generation and commits', async () => {
      bump();
      bump();
      await run();
      assert.equal((await store.loadBookmarks(USER)).length, 120);
    });

    test('a user who is not connected causes no state row', async () => {
      world.failWhen = () => true;
      world.error = new NotConnectedError('Connect Raindrop first.');
      await assert.rejects(run(), NotConnectedError);
      assert.equal(await store.getSyncState(USER), null);
    });

    test('a cancel stops the sync at its next page and keeps the old rows', async () => {
      await run();
      world.items = items(1, 120).map((i) => ({ ...i, title: 'Cancelled' }));
      world.onPage = async (page) => { if (page === 0) cancelSync(svc, USER); };
      await assert.rejects(run(), /cancelled/);
      assert.equal((await stored()).get(1).title, 'Item 1');
      assert.equal((await store.getSyncState(USER)).consecutiveFailures, 0);
    });
  });

  describe('the queue contract', () => {
    test('syncNow inside a queue turn of the same user fails and does not wait for ever', async () => {
      const outcome = await Promise.race([
        serialize(USER, () => run()).then(() => 'finished', (err) => err.message),
        new Promise((r) => setTimeout(() => r('deadlock'), 3000)),
      ]);
      assert.match(outcome, /inside a turn of the same key/);
      assert.equal((await store.loadBookmarks(USER)).length, 0);
    });

    test('a sync of one user does not block the queue of another user while it fetches', async () => {
      let ran = false;
      world.onPage = async (page) => {
        if (page === 1) await serialize(USER, async () => { ran = true; });
      };
      await run();
      assert.equal(ran, true);
    });
  });
});

describe('write-through', { skip: SKIP_REASON }, () => {
  let store;
  let schema;
  let svc;
  const user = 'wt@example.test';

  before(async () => {
    schema = await createTestSchema();
    const { openStore } = await import('../src/store.js');
    store = openStore({ url: TEST_URL, schema });
  });

  after(async () => {
    config.bookmarkStore = false;
    await store.close();
    await dropTestSchema(schema);
  });

  beforeEach(async () => {
    config.bookmarkStore = true;
    config.sync.writeRetryMs = 0;
    await store.deleteBookmarkStore(user);
    svc = { store, generations: new Map(), syncs: new Map() };
  });

  test('it writes the change, and a running sync gets the journal entry', async () => {
    let run;
    const waiting = new Promise((resolve) => { run = resolve; });
    const world = { items: items(1, 3), collections: [], onPage: async () => { await waiting; } };
    const fake = fakeRaindrop(world);
    const sync = syncNow(svc, user, { call: fake.call, wait: async () => {}, now: () => NOW });
    while (!fake.calls.some((p) => p.includes('/raindrops/0'))) await new Promise((r) => setTimeout(r, 2));
    await writeThrough(svc, user, 0, { type: 'upsert', item: { ...item(2), title: 'Written' } });
    assert.equal(svc.syncs.get(user).journal.length, 1);
    run();
    await sync;
    assert.equal((await store.loadBookmarks(user)).find((i) => i._id === 2).title, 'Written');
  });

  test('a changed generation skips the database write and the journal', async () => {
    await store.upsertBookmark(user, item(1));
    svc.syncs.set(user, { journal: [], closed: false, gen: 3 });
    svc.generations.set(user, 3);
    // The change of an older connection (generation 2): no database write, and no journal entry.
    await writeThrough(svc, user, 2, { type: 'upsert', item: { ...item(9), title: 'Too late' } });
    assert.equal((await store.loadBookmarks(user)).some((i) => i._id === 9), false);
    assert.equal(svc.syncs.get(user).journal.length, 0);
    // The change of the same connection: written and journaled.
    await writeThrough(svc, user, 3, { type: 'upsert', item: { ...item(9), title: 'In time' } });
    assert.equal((await store.loadBookmarks(user)).some((i) => i._id === 9), true);
    assert.equal(svc.syncs.get(user).journal.length, 1);
  });

  test('a change of an old connection does not enter the sync of the new connection', async () => {
    // Account A started a save. Then the user connected account B, and a sync of B started.
    // The answer for A arrives while the sync of B fetches.
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const fake = fakeRaindrop({ items: items(1, 3), collections: [], onPage: async () => { await waiting; } });
    svc.generations.set(user, 1);
    const sync = syncNow(svc, user, { call: fake.call, wait: async () => {}, now: () => NOW });
    while (!fake.calls.some((p) => p.includes('/raindrops/0'))) await new Promise((r) => setTimeout(r, 2));
    await writeThrough(svc, user, 0, { type: 'upsert', item: { ...item(101), title: 'From account A' } });
    assert.equal(svc.syncs.get(user).journal.length, 0);
    release();
    await sync;
    assert.deepEqual((await store.loadBookmarks(user)).map((i) => i._id).sort(), [1, 2, 3]);
  });

  test('a change of the same connection stays in the journal when the database write fails', async () => {
    svc.syncs.set(user, { journal: [], closed: false, gen: 0 });
    svc.store = { upsertBookmark: async () => { throw new Error('down'); }, setRetry: async () => {} };
    await writeThrough(svc, user, 0, { type: 'upsert', item: item(9) });
    assert.equal(svc.syncs.get(user).journal.length, 1);
  });

  test('it does nothing when the stored copy is off', async () => {
    config.bookmarkStore = false;
    await writeThrough(svc, user, 0, { type: 'upsert', item: item(9) });
    assert.equal((await store.loadBookmarks(user)).length, 0);
    assert.equal(connectionGeneration(svc, user), 0);
  });

  test('a write that fails every time sets the retry, marks the user, and does not throw', async () => {
    const broken = { ...store, upsertBookmark: async () => { throw new Error('down'); }, setRetry: store.setRetry };
    svc.store = broken;
    await writeThrough(svc, user, 0, { type: 'upsert', item: item(9) });
    assert.equal(svc.dirty.has(user), true);
    assert.match((await store.getSyncState(user)).lastError, /database write failed: down/);
  });

  test('a failure of the retry write too is logged and does not throw', async () => {
    const broken = {
      upsertBookmark: async () => { throw new Error('down'); },
      setRetry: async () => { throw new Error('also down'); },
    };
    svc.store = broken;
    await writeThrough(svc, user, 0, { type: 'upsert', item: item(9) });
    assert.equal(svc.dirty.has(user), true);
  });

  test('ensureSnapshot makes the copy once, and does nothing when the copy exists or the copy is off', async () => {
    const world = { items: items(1, 3), collections: [] };
    const fake = fakeRaindrop(world);
    const o = { call: fake.call, wait: async () => {}, now: () => NOW };
    await ensureSnapshot(svc, user, o);
    assert.equal((await store.loadBookmarks(user)).length, 3);
    const calls = fake.calls.length;
    await ensureSnapshot(svc, user, o);
    assert.equal(fake.calls.length, calls);
    await store.deleteBookmarkStore(user);
    config.bookmarkStore = false;
    await ensureSnapshot(svc, user, o);
    assert.equal((await store.loadBookmarks(user)).length, 0);
  });

  test('no sync starts while the connection changes, and a sync starts again after it', async () => {
    const fake = fakeRaindrop({ items: items(1, 2), collections: [] });
    const o = { call: fake.call, wait: async () => {}, now: () => NOW };
    const end = beginConnectionChange(svc, user);
    assert.throws(() => syncNow(svc, user, o), (err) => err.status === 409 && /connection is changing/.test(err.message));
    config.bookmarkStore = true;
    await assert.rejects(ensureSnapshot(svc, user, o), /connection is changing/);
    assert.equal(fake.calls.length, 0, 'no Raindrop call was made');
    assert.equal(svc.syncs.size, 0);
    end();
    assert.equal(svc.changing.has(user), false);
    await syncNow(svc, user, o);
    assert.equal((await store.loadBookmarks(user)).length, 2);
  });

  test('a sync that runs when the connection starts to change keeps its old generation and is discarded', async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const fake = fakeRaindrop({ items: items(1, 2), collections: [], onPage: async () => { await waiting; } });
    const sync = syncNow(svc, user, { call: fake.call, wait: async () => {}, now: () => NOW });
    while (!fake.calls.some((p) => p.includes('/raindrops/0'))) await new Promise((r) => setTimeout(r, 2));
    const end = beginConnectionChange(svc, user);
    svc.generations.set(user, 1); // connect() changes the generation
    const outcome = assert.rejects(sync, /connection changed/);
    release();
    await outcome;
    end();
    assert.equal((await store.loadBookmarks(user)).length, 0);
  });

  test('the store version rises after a sync commit', async () => {
    const fake = fakeRaindrop({ items: items(1, 2), collections: [] });
    const before = storeVersion(svc, user);
    await syncNow(svc, user, { call: fake.call, wait: async () => {}, now: () => NOW });
    assert.equal(storeVersion(svc, user), before + 1);
  });
});

describe('effects', () => {
  test('a move sets the folder, keeps the other fields, and reports no change when the folder is the same', () => {
    const raw = item(1);
    const moved = moveRaw(raw, 11);
    assert.equal(moved.collection.$id, 11);
    assert.equal(moved.collection.$ref, 'collections');
    assert.equal(moved.collectionId, 11);
    assert.equal(moveRaw(moved, 11), null);
    assert.equal(raw.collection.$id, 10);
  });

  test('a move does not add collectionId when the object has none', () => {
    const { collectionId, ...raw } = item(1);
    assert.equal('collectionId' in moveRaw(raw, 11), false);
  });

  test('add tags merges with the same rule as the bulk action, and a replay changes nothing', () => {
    const raw = item(1, { tags: ['Dev'] });
    const once = addTagsRaw(raw, ['dev', 'Node', 'node']);
    assert.deepEqual(once.tags, ['Dev', 'Node']);
    assert.equal(addTagsRaw(once, ['dev', 'Node', 'node']), null);
    assert.deepEqual(addTagsRaw({ _id: 1 }, ['a']).tags, ['a']);
  });

  test('an update sets the folder and replaces the tags, and a field that is not given stays', () => {
    const raw = item(1, { tags: ['a', 'b'] });
    assert.deepEqual(updateRaw(raw, { tags: ['c'] }).tags, ['c']);
    assert.equal(updateRaw(raw, { tags: ['c'] }).collection.$id, 10);
    assert.equal(updateRaw(raw, { collectionId: 11 }).collection.$id, 11);
    assert.deepEqual(updateRaw(raw, { collectionId: 11 }).tags, ['a', 'b']);
    const both = updateRaw(raw, { collectionId: 11, tags: [] });
    assert.deepEqual([both.collection.$id, both.tags], [11, []]);
    assert.equal(updateRaw(raw, { collectionId: 10, tags: ['a', 'b'] }), null);
    assert.equal(updateRaw(raw, {}), null);
    assert.equal(updateRaw({ _id: 1 }, { tags: [] }), null);
    // The note is set only when it is given and it differs.
    assert.equal(updateRaw(raw, { note: 'n' }).note, 'n');
    assert.deepEqual(updateRaw(raw, { note: 'n' }).tags, ['a', 'b']);
    assert.equal(updateRaw({ ...raw, note: 'n' }, { note: 'n' }), null);
    assert.equal(updateRaw({ ...raw, note: 'n' }, { note: '' }).note, '');
    assert.equal(updateRaw({ _id: 1 }, { note: '' }), null);
    assert.equal(updateRaw({ ...raw, note: 'n' }, { tags: ['c'] }).note, 'n');
  });

  test('an unknown effect type is refused', async () => {
    await assert.rejects(applyEffect({}, USER, { type: 'bogus' }), /Unknown effect type/);
  });
});
