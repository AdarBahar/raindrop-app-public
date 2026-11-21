// The stored copy of the bookmarks (migration 003). Needs the test database.
// The functions never take a queue. See docs/bookmark-store-plan.md, sections 3 and 4.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';
import { cleanTags } from '../src/util.js';

const sample = JSON.parse(await readFile(new URL('./fixtures/raindrop-sample.json', import.meta.url), 'utf8'));
const live = JSON.parse(await readFile(new URL('./fixtures/raindrop-live-sample.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

describe('bookmark store', { skip: SKIP_REASON }, () => {
  let store;
  let schema;

  before(async () => {
    schema = await createTestSchema();
    const { openStore } = await import('../src/store.js');
    store = openStore({ url: TEST_URL, schema });
  });

  after(async () => {
    await store.close();
    await dropTestSchema(schema);
  });

  const byId = (items) => new Map(items.map((i) => [i._id, i]));

  test('bookmarks and folders come back equal to what Raindrop returned', async () => {
    await store.upsertCollections(ALICE, clone(sample.collections));
    await store.upsertBookmarks(ALICE, clone(sample.bookmarks));

    const bookmarks = await store.loadBookmarks(ALICE);
    assert.equal(bookmarks.length, sample.bookmarks.length);
    for (const original of sample.bookmarks) {
      assert.deepEqual(byId(bookmarks).get(original._id), original);
    }
    const collections = await store.loadCollections(ALICE);
    assert.equal(collections.length, sample.collections.length);
    for (const original of sample.collections) {
      assert.deepEqual(byId(collections).get(original._id), original);
    }
  });

  test('objects that the live Raindrop API returned come back equal', async () => {
    const user = 'live@example.test';
    await store.upsertCollections(user, clone(live.collections));
    await store.upsertBookmarks(user, clone(live.bookmarks));
    const bookmarks = byId(await store.loadBookmarks(user));
    for (const original of live.bookmarks) assert.deepEqual(bookmarks.get(original._id), original);
    const collections = byId(await store.loadCollections(user));
    for (const original of live.collections) assert.deepEqual(collections.get(original._id), original);
    // Fields that the live API sends and the hand-made sample does not have.
    assert.equal(collections.get(live.collections[0]._id).parent, null);
    assert.equal(typeof bookmarks.get(live.bookmarks[0]._id).collectionId, 'number');
    const { rows } = await store.pool.query('SELECT collection_id FROM bookmarks WHERE user_id = $1 AND raindrop_id = $2', [user, live.bookmarks[0]._id]);
    assert.equal(Number(rows[0].collection_id), live.bookmarks[0].collection.$id);
  });

  test('loaded items keep the types that the callers expect', async () => {
    const item = byId(await store.loadBookmarks(ALICE)).get(900000001);
    assert.equal(typeof item._id, 'number');
    assert.equal(typeof item.collection.$id, 'number');
    assert.equal(typeof item.created, 'string');
    assert.equal(item.created, '2026-10-01T10:00:00.000Z');
    assert.equal(new Date(item.created).toISOString(), item.created);
    assert.deepEqual(item.tags, ['dev', 'Node.js']);
    const unsorted = byId(await store.loadBookmarks(ALICE)).get(900000002);
    assert.equal(unsorted.collection.$id, -1);
    assert.equal(typeof byId(await store.loadCollections(ALICE)).get(5001).count, 'number');
  });

  test('the typed columns come from the stored object', async () => {
    const { rows } = await store.pool.query(
      'SELECT raindrop_id, collection_id, created FROM bookmarks WHERE user_id = $1 ORDER BY raindrop_id',
      [ALICE],
    );
    assert.deepEqual(rows.map((r) => [Number(r.raindrop_id), Number(r.collection_id)]), [
      [900000001, 5001], [900000002, -1], [900000003, 5002],
    ]);
    assert.equal(rows[0].created.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  test('bookmarks load newest first', async () => {
    const ids = (await store.loadBookmarks(ALICE)).map((i) => i._id);
    assert.deepEqual(ids, [900000002, 900000001, 900000003]);
  });

  test('an upsert replaces the object and the typed columns together', async () => {
    const edited = clone(sample.bookmarks[0]);
    edited.title = 'Edited';
    edited.collection = { $ref: 'collections', $id: 5002, oid: 5002 };
    await store.upsertBookmark(ALICE, edited);
    assert.deepEqual(byId(await store.loadBookmarks(ALICE)).get(900000001), edited);
    const { rows } = await store.pool.query('SELECT collection_id FROM bookmarks WHERE user_id = $1 AND raindrop_id = 900000001', [ALICE]);
    assert.equal(Number(rows[0].collection_id), 5002);
    await store.upsertBookmark(ALICE, clone(sample.bookmarks[0]));
  });

  test('an upsert of an item with no valid _id is refused', async () => {
    await assert.rejects(store.upsertBookmarks(ALICE, [{ title: 'no id' }]), /no valid _id/);
    await assert.rejects(store.upsertBookmarks(ALICE, [{ _id: '12' }]), /no valid _id/);
    await assert.rejects(store.upsertCollections(ALICE, [{ title: 'no id' }]), /no valid _id/);
  });

  test('a large group is stored in several statements', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      _id: 800000000 + i, title: `Item ${i}`, tags: [], collection: { $id: 5001 }, created: '2026-01-01T00:00:00.000Z',
    }));
    await store.upsertBookmarks('big@example.test', many);
    assert.equal((await store.loadBookmarks('big@example.test')).length, 2500);
  });

  test('deleteBookmarksNotIn removes the rows that are missing from the snapshot', async () => {
    const copy = 'prune@example.test';
    await store.upsertBookmarks(copy, clone(sample.bookmarks));
    assert.equal(await store.deleteBookmarksNotIn(copy, [900000001, 900000003]), 1);
    assert.deepEqual((await store.loadBookmarks(copy)).map((i) => i._id).sort(), [900000001, 900000003]);
    assert.equal(await store.deleteBookmarksNotIn(copy, [900000001, 900000003]), 0);
    assert.equal(await store.deleteBookmarks(copy, [900000001]), 1);
    await store.upsertCollections(copy, clone(sample.collections));
    assert.equal(await store.deleteCollectionsNotIn(copy, [5001]), 1);
    assert.deepEqual((await store.loadCollections(copy)).map((c) => c._id), [5001]);
  });

  test('updateBookmarks changes only the listed bookmarks and gives the same result when it runs twice', async () => {
    const user = 'patch@example.test';
    await store.upsertBookmarks(user, clone(sample.bookmarks));
    const addTags = (raw) => {
      const merged = cleanTags([...(raw.tags ?? []), 'new', 'DEV']);
      return merged.length === (raw.tags ?? []).length ? null : { ...raw, tags: merged };
    };
    assert.equal(await store.updateBookmarks(user, [900000001, 900000002, 123], addTags), 2);
    assert.equal(await store.updateBookmarks(user, [900000001, 900000002, 123], addTags), 0);
    const items = byId(await store.loadBookmarks(user));
    assert.deepEqual(items.get(900000001).tags, ['dev', 'Node.js', 'new']);
    assert.deepEqual(items.get(900000002).tags, ['new', 'DEV']);
    assert.deepEqual(items.get(900000003).tags, ['watch']);

    const move = (raw) => (raw.collection?.$id === 5002 ? null : { ...raw, collection: { ...raw.collection, $id: 5002 } });
    assert.equal(await store.updateBookmarks(user, [900000001], move), 1);
    const moved = byId(await store.loadBookmarks(user)).get(900000001);
    assert.equal(moved.collection.$id, 5002);
    assert.equal(moved.collection.$ref, 'collections');
    const { rows } = await store.pool.query('SELECT collection_id FROM bookmarks WHERE user_id = $1 AND raindrop_id = 900000001', [user]);
    assert.equal(Number(rows[0].collection_id), 5002);
  });

  test('a patch that changes or removes the _id is refused and changes no row', async () => {
    const user = 'identity@example.test';
    await store.upsertBookmarks(user, clone(sample.bookmarks));
    const before = await store.loadBookmarks(user);

    // Bookmark 900000002 exists, so a wrong _id would change a bookmark that was not selected.
    await assert.rejects(
      store.updateBookmarks(user, [900000001], (raw) => ({ ...raw, _id: 900000002, title: 'Updated' })),
      /changed the _id of bookmark 900000001/,
    );
    // A new _id that does not exist would be counted as a change and do nothing.
    await assert.rejects(
      store.updateBookmarks(user, [900000001], (raw) => ({ ...raw, _id: 1, title: 'Updated' })),
      /changed the _id/,
    );
    await assert.rejects(
      store.updateBookmarks(user, [900000001], ({ _id, ...rest }) => ({ ...rest, title: 'Updated' })),
      /changed the _id/,
    );
    await assert.rejects(
      store.updateBookmarks(user, [900000001], (raw) => ({ ...raw, _id: String(raw._id) })),
      /changed the _id/,
    );
    assert.deepEqual(await store.loadBookmarks(user), before);
  });

  test('a refused patch changes no row of the same call, also the rows with a valid patch', async () => {
    const user = 'identity-2@example.test';
    await store.upsertBookmarks(user, clone(sample.bookmarks));
    const before = await store.loadBookmarks(user);
    await assert.rejects(
      store.updateBookmarks(user, [900000001, 900000002, 900000003], (raw) => (
        raw._id === 900000003 ? { ...raw, _id: 5 } : { ...raw, title: 'Updated' }
      )),
      /changed the _id/,
    );
    assert.deepEqual(await store.loadBookmarks(user), before);
  });

  test('a patch that returns null for every row changes nothing and counts zero', async () => {
    const user = 'identity-3@example.test';
    await store.upsertBookmarks(user, clone(sample.bookmarks));
    assert.equal(await store.updateBookmarks(user, [900000001, 900000002], () => null), 0);
  });

  test('two users with the same bookmark ID never see each other', async () => {
    const a = clone(sample.bookmarks[0]);
    const b = clone(sample.bookmarks[0]);
    b.title = 'Bob copy';
    await store.upsertBookmark('iso-a@example.test', a);
    await store.upsertBookmark('iso-b@example.test', b);
    assert.equal((await store.loadBookmarks('iso-a@example.test'))[0].title, a.title);
    assert.equal((await store.loadBookmarks('iso-b@example.test'))[0].title, 'Bob copy');

    await store.deleteBookmarksNotIn('iso-a@example.test', []);
    assert.equal((await store.loadBookmarks('iso-a@example.test')).length, 0);
    assert.equal((await store.loadBookmarks('iso-b@example.test')).length, 1);

    await store.updateBookmarks('iso-b@example.test', [a._id], (raw) => ({ ...raw, title: 'Changed' }));
    assert.equal((await store.loadBookmarks('iso-b@example.test'))[0].title, 'Changed');
    assert.equal((await store.loadBookmarks('iso-a@example.test')).length, 0);
    assert.equal((await store.loadBookmarks(BOB)).length, 0);
  });

  test('deleteBookmarkStore removes one user and keeps the other', async () => {
    for (const user of ['del-a@example.test', 'del-b@example.test']) {
      await store.upsertBookmarks(user, clone(sample.bookmarks));
      await store.upsertCollections(user, clone(sample.collections));
      await store.recordSyncSuccess(user, '2026-11-09T10:00:00.000Z');
    }
    await store.deleteBookmarkStore('del-a@example.test');
    assert.equal((await store.loadBookmarks('del-a@example.test')).length, 0);
    assert.equal((await store.loadCollections('del-a@example.test')).length, 0);
    assert.equal(await store.getSyncState('del-a@example.test'), null);
    assert.equal((await store.loadBookmarks('del-b@example.test')).length, 3);
    assert.notEqual(await store.getSyncState('del-b@example.test'), null);
  });

  test('deleteUserData removes the stored copy of that user only', async () => {
    for (const user of ['wipe-a@example.test', 'wipe-b@example.test']) {
      await store.ensureUser(user);
      await store.upsertBookmarks(user, clone(sample.bookmarks));
      await store.upsertCollections(user, clone(sample.collections));
      await store.recordSyncSuccess(user, '2026-11-09T10:00:00.000Z');
    }
    await store.deleteUserData('wipe-a@example.test');
    assert.equal((await store.loadBookmarks('wipe-a@example.test')).length, 0);
    assert.equal((await store.loadCollections('wipe-a@example.test')).length, 0);
    assert.equal(await store.getSyncState('wipe-a@example.test'), null);
    assert.equal((await store.loadBookmarks('wipe-b@example.test')).length, 3);
  });

  test('a transaction commits all changes, or none', async () => {
    const user = 'tx@example.test';
    await store.upsertBookmarks(user, clone(sample.bookmarks));
    await assert.rejects(store.transaction(async (tx) => {
      await tx.deleteBookmarksNotIn(user, []);
      await tx.recordSyncSuccess(user, '2026-11-09T10:00:00.000Z');
      throw new Error('stop');
    }), /stop/);
    assert.equal((await store.loadBookmarks(user)).length, 3);
    assert.equal(await store.getSyncState(user), null);

    const result = await store.transaction(async (tx) => {
      await tx.deleteBookmarksNotIn(user, [900000001]);
      await tx.upsertBookmark(user, { _id: 900000009, title: 'added', collection: { $id: 5001 }, created: '2026-11-01T00:00:00.000Z' });
      await tx.updateBookmarks(user, [900000001], (raw) => ({ ...raw, title: 'inside' }));
      await tx.recordSyncSuccess(user, '2026-11-09T10:00:00.000Z');
      return 'done';
    });
    assert.equal(result, 'done');
    const items = byId(await store.loadBookmarks(user));
    assert.deepEqual([...items.keys()].sort(), [900000001, 900000009]);
    assert.equal(items.get(900000001).title, 'inside');
  });

  describe('sync state', () => {
    const user = 'state@example.test';

    test('a user who never synced has no state', async () => {
      assert.equal(await store.getSyncState(user), null);
    });

    test('failures count up and a success clears them', async () => {
      await store.recordSyncFailure(user, '2026-11-09T10:00:00.000Z', 'first', '2026-11-09T11:00:00.000Z');
      await store.recordSyncFailure(user, '2026-11-09T11:00:00.000Z', 'second', '2026-11-09T13:00:00.000Z');
      assert.deepEqual(await store.getSyncState(user), {
        lastFullAt: null,
        lastAttemptAt: '2026-11-09T11:00:00.000Z',
        lastError: 'second',
        consecutiveFailures: 2,
        nextRetryAt: '2026-11-09T13:00:00.000Z',
      });
      await store.recordSyncSuccess(user, '2026-11-09T14:00:00.000Z');
      assert.deepEqual(await store.getSyncState(user), {
        lastFullAt: '2026-11-09T14:00:00.000Z',
        lastAttemptAt: '2026-11-09T14:00:00.000Z',
        lastError: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
      });
    });

    test('setRetry asks for a sync soon and does not count as a failure', async () => {
      await store.setRetry(user, 'database write failed', '2026-11-09T14:01:00.000Z');
      const state = await store.getSyncState(user);
      assert.equal(state.consecutiveFailures, 0);
      assert.equal(state.lastError, 'database write failed');
      assert.equal(state.nextRetryAt, '2026-11-09T14:01:00.000Z');
      assert.equal(state.lastFullAt, '2026-11-09T14:00:00.000Z');
    });

    test('a long error text is cut', async () => {
      await store.recordSyncFailure('long@example.test', '2026-11-09T10:00:00.000Z', 'x'.repeat(2000), null);
      assert.equal((await store.getSyncState('long@example.test')).lastError.length, 500);
    });

    test('an empty library that synced differs from a library that never synced', async () => {
      await store.recordSyncSuccess('empty@example.test', '2026-11-09T10:00:00.000Z');
      assert.equal((await store.loadBookmarks('empty@example.test')).length, 0);
      assert.notEqual((await store.getSyncState('empty@example.test')).lastFullAt, null);
      assert.equal(await store.getSyncState('never@example.test'), null);
    });
  });

  describe('runtime role rights', () => {
    test('the runtime role can read and write the new tables', async () => {
      for (const table of ['bookmarks', 'collections', 'sync_state']) {
        await store.pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
      }
      await store.pool.query("DELETE FROM sync_state WHERE user_id = 'nobody'");
    });

    test('the runtime role cannot create, change or drop tables', async () => {
      await assert.rejects(store.pool.query('CREATE TABLE evil (id INT)'), /permission denied/);
      await assert.rejects(store.pool.query('ALTER TABLE bookmarks ADD COLUMN evil INT'), /must be owner/);
      await assert.rejects(store.pool.query('DROP TABLE bookmarks'), /must be owner/);
      await assert.rejects(store.pool.query('TRUNCATE bookmarks'), /permission denied/);
    });
  });
});
