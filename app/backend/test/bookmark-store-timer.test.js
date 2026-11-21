// The timer, the orphan sweep and the revoke path of the stored copy (PR 4).
// The rules are in docs/bookmark-store-plan.md, section 7. Needs the test database.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { getAccessToken, NotConnectedError } from '../src/oauth.js';
import { createApp } from '../src/server.js';
import { serialize } from '../src/util.js';
import { isDue, logStats, startSyncTimer, sweepOrphans, syncDueUsers } from '../src/sync-timer.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const hoursAhead = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();
const key = Buffer.alloc(32, 7);

const item = (id) => ({
  _id: id, title: `Item ${id}`, link: `https://example.test/${id}`, tags: [],
  collection: { $ref: 'collections', $id: 10, oid: 10 }, collectionId: 10, created: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
});

describe('isDue', () => {
  const user = (over) => ({ userId: 'u', lastFullAt: null, nextRetryAt: null, consecutiveFailures: 0, ...over });
  test('decides by the dirty flag, the retry time and the age of the copy', () => {
    assert.equal(isDue(user({ lastFullAt: hoursAgo(1) }), NOW, true), true, 'a dirty user is due');
    assert.equal(isDue(user({ lastFullAt: hoursAgo(1) }), NOW), false, 'a fresh copy is not due');
    assert.equal(isDue(user({ lastFullAt: hoursAgo(19) }), NOW), false, 'under 20 hours');
    assert.equal(isDue(user({ lastFullAt: hoursAgo(20) }), NOW), true, 'at 20 hours');
    assert.equal(isDue(user({ lastFullAt: hoursAgo(30), nextRetryAt: hoursAhead(1) }), NOW), false, 'a failed user waits for the retry time');
    assert.equal(isDue(user({ lastFullAt: hoursAgo(1), nextRetryAt: hoursAgo(0.1) }), NOW), true, 'the retry time has passed');
    assert.equal(isDue(user({}), NOW), false, 'a user without a copy waits for the first visit');
    assert.equal(isDue(user({ nextRetryAt: hoursAgo(1) }), NOW), true, 'a first sync that failed is tried again');
  });
});

describe('the timer and the sweep', { skip: SKIP_REASON }, () => {
  let store;
  let schema;
  let svc;
  let called;
  const realFlag = config.bookmarkStore;
  const realSpread = config.sync.spreadMs;
  const call = async (_svc, userId, _method, path) => {
    called.push(userId);
    if (path === '/user/stats') return { items: [{ _id: 0, count: 2 }] };
    if (path === '/collections') return { items: [{ _id: 10, title: 'Work', count: 2 }] };
    if (path === '/collections/childrens') return { items: [] };
    return { items: [item(1), item(2)] };
  };
  const opts = () => ({ call, wait: async () => {}, now: () => NOW, pause: async () => {} });
  const connect = async (id) => {
    await store.ensureUser(id);
    await store.saveTokens(id, encrypt('a', key), encrypt('r', key), Date.now() + 3600000);
  };
  const synced = () => [...new Set(called)].sort();

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
    config.bookmarkStore = true;
    config.sync.spreadMs = 0;
    svc = { store, key, cache: new Map(), profiles: new Map(), generations: new Map(), refreshing: new Map(), syncs: new Map() };
    called = [];
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) await store.deleteUserData(id);
  });
  afterEach(() => {
    config.bookmarkStore = realFlag;
    config.sync.spreadMs = realSpread;
  });

  async function seed() {
    for (const id of ['alice', 'bob', 'carol', 'dave', 'erin']) await connect(id);
    await store.recordSyncSuccess('alice', hoursAgo(25)); // old copy
    await store.recordSyncSuccess('bob', hoursAgo(2)); // fresh copy
    await store.recordSyncSuccess('carol', hoursAgo(30));
    await store.recordSyncFailure('carol', hoursAgo(1), 'boom', hoursAhead(1)); // failed, waits for the retry time
    await store.recordSyncSuccess('dave', hoursAgo(5));
    await store.setRetry('dave', 'The database write failed', hoursAgo(0.5)); // retry time has passed
    // erin has tokens and no copy: the first visit makes the first sync
  }

  test('syncs only the connected users who are due', async () => {
    await seed();
    const result = await syncDueUsers(svc, opts());
    assert.deepEqual(synced(), ['alice', 'dave']);
    assert.deepEqual(result, { due: 2, ok: 2, failed: 0 });
    assert.equal((await store.loadBookmarks('alice')).length, 2);
    assert.equal((await store.loadBookmarks('bob')).length, 0);
    assert.equal((await store.getSyncState('dave')).nextRetryAt, null, 'a good sync clears the retry time');
  });

  test('a restart keeps the failure count and the retry time: a new service reads them from the database', async () => {
    await seed();
    await store.recordSyncFailure('carol', hoursAgo(0.9), 'boom again', hoursAhead(2));
    const fresh = { store, key, generations: new Map(), refreshing: new Map(), syncs: new Map() };
    assert.equal((await store.getSyncState('carol')).consecutiveFailures, 2);
    await syncDueUsers(fresh, opts());
    assert.equal(called.includes('carol'), false);
    // The retry time passes, and the same state makes carol due.
    await store.recordSyncFailure('carol', hoursAgo(0.9), 'boom 3', hoursAgo(0.1));
    called = [];
    await syncDueUsers(fresh, opts());
    assert.equal(called.includes('carol'), true);
  });

  test('a user with a dirty flag is synced, and the flag is cleared', async () => {
    await seed();
    svc.dirty = new Set(['bob']);
    await syncDueUsers(svc, opts());
    assert.ok(synced().includes('bob'));
    assert.equal(svc.dirty.has('bob'), false);
  });

  test('a dirty user is synced when the database cannot list the users', async () => {
    await connect('frank');
    svc.dirty = new Set(['frank']);
    const real = store.listSyncUsers;
    store.listSyncUsers = async () => { throw new Error('database down'); };
    const log = console.error;
    console.error = () => {};
    try {
      await syncDueUsers(svc, opts());
    } finally {
      store.listSyncUsers = real;
      console.error = log;
    }
    assert.deepEqual(synced(), ['frank']);
  });

  test('a sync that fails does not stop the timer run, and the next user is synced', async () => {
    await seed();
    const failing = async (s, userId, m, path) => {
      if (userId === 'alice') throw new Error('Raindrop failed');
      return call(s, userId, m, path);
    };
    const result = await syncDueUsers(svc, { ...opts(), call: failing, wait: async () => {} });
    assert.deepEqual(result, { due: 2, ok: 1, failed: 1 });
    const state = await store.getSyncState('alice');
    assert.equal(state.consecutiveFailures, 1);
    assert.ok(state.nextRetryAt, 'the failure sets the retry time');
    assert.equal((await store.loadBookmarks('dave')).length, 2);
  });

  test('a user whose connection changes is skipped', async () => {
    await seed();
    svc.changing = new Set(['alice']);
    await syncDueUsers(svc, opts());
    assert.deepEqual(synced(), ['dave']);
  });

  test('the timer does nothing when the flag is off', async () => {
    await seed();
    config.bookmarkStore = false;
    assert.deepEqual(await syncDueUsers(svc, opts()), { due: 0, ok: 0, failed: 0 });
    assert.equal(await sweepOrphans(svc), 0);
    assert.equal(typeof startSyncTimer(svc, opts()), 'function');
    assert.deepEqual(called, []);
  });

  test('the third failure in a row goes to the error log', async () => {
    await connect('alice');
    await store.recordSyncFailure('alice', hoursAgo(5), 'x', hoursAgo(4));
    await store.recordSyncFailure('alice', hoursAgo(3), 'x', hoursAgo(2));
    const lines = [];
    const log = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try {
      await syncDueUsers(svc, { ...opts(), call: async () => { throw new Error('Raindrop failed'); } });
    } finally {
      console.error = log;
    }
    assert.ok(lines.some((l) => l.includes('alice') && l.includes('3 times in a row')), lines.join('\n'));
  });

  test('the summary has the number of users, the age of the oldest copy and the failing users', async () => {
    await seed();
    await store.recordSyncFailure('carol', hoursAgo(1), 'b', hoursAhead(1));
    await store.recordSyncFailure('carol', hoursAgo(1), 'b', hoursAhead(1)); // 3 in a row now
    const out = [];
    const log = console.log;
    console.log = (...a) => out.push(a.join(' '));
    let stats;
    try {
      stats = await logStats(svc, NOW);
    } finally {
      console.log = log;
    }
    assert.deepEqual(stats, { connected: 5, oldestHours: 30, failing: 1 });
    assert.ok(out[0].startsWith('sync-stats connected=5 oldest_sync_hours=30 users_failing=1'));
  });

  test('the timer syncs at start, and stops', async () => {
    await seed();
    const stop = startSyncTimer(svc, opts());
    try {
      for (let i = 0; i < 100 && synced().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(synced(), ['alice', 'dave']);
    } finally {
      stop();
    }
  });

  describe('the orphan sweep', () => {
    test('deletes the rows of a user who has no tokens, and keeps the rows of a connected user', async () => {
      await connect('alice');
      await store.ensureUser('bob');
      for (const id of ['alice', 'bob']) {
        await store.upsertBookmark(id, item(1));
        await store.upsertCollections(id, [{ _id: 10, title: 'Work' }]);
        await store.recordSyncSuccess(id, hoursAgo(1));
      }
      assert.deepEqual(await store.listStoreOrphans(), ['bob']);
      assert.equal(await sweepOrphans(svc), 1);
      assert.equal((await store.loadBookmarks('bob')).length, 0);
      assert.equal((await store.loadCollections('bob')).length, 0);
      assert.equal(await store.getSyncState('bob'), null);
      assert.equal((await store.loadBookmarks('alice')).length, 1);
    });

    test('keeps the rows when the user connects between the list and the turn', async () => {
      await store.ensureUser('bob');
      await store.upsertBookmark('bob', item(1));
      const real = store.listStoreOrphans;
      store.listStoreOrphans = async () => {
        const list = await real.call(store);
        await connect('bob'); // the user connects after the list was made
        return list;
      };
      try {
        assert.equal(await sweepOrphans(svc), 0);
      } finally {
        store.listStoreOrphans = real;
      }
      assert.equal((await store.loadBookmarks('bob')).length, 1);
    });

    test('skips a user whose connection is changing', async () => {
      await store.ensureUser('bob');
      await store.upsertBookmark('bob', item(1));
      svc.changing = new Set(['bob']);
      assert.equal(await sweepOrphans(svc), 0);
      assert.equal((await store.loadBookmarks('bob')).length, 1);
    });
  });

  describe('a revoked authorization', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });
    const revokeAnswer = (status) => { globalThis.fetch = async () => new Response('revoked', { status }); };
    const expire = async (id) => store.saveTokens(id, encrypt('a', key), encrypt('r', key), Date.now() - 1000);
    const settle = async (check) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };

    async function withRows(id) {
      await connect(id);
      await store.upsertBookmark(id, item(1));
      await store.recordSyncSuccess(id, hoursAgo(1));
      await expire(id);
      createApp(svc); // sets svc.onRevoked
    }

    test('deletes the tokens and then the stored rows', async () => {
      await withRows('alice');
      revokeAnswer(400);
      await assert.rejects(getAccessToken(svc, 'alice'), NotConnectedError);
      assert.equal(await store.getTokens('alice'), null);
      assert.ok(await settle(async () => (await store.loadBookmarks('alice')).length === 0), 'the rows are deleted');
      assert.equal(await store.getSyncState('alice'), null);
    });

    test('a refresh error 5xx is not a revoke: the rows stay', async () => {
      await withRows('alice');
      revokeAnswer(503);
      await assert.rejects(getAccessToken(svc, 'alice'));
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await store.loadBookmarks('alice')).length, 1);
      assert.ok(await store.getTokens('alice'));
    });

    test('the revoke inside a queue turn of the user does not deadlock and does not wait for itself', async () => {
      await withRows('alice');
      revokeAnswer(401);
      const outcome = await Promise.race([
        serialize('alice', async () => {
          await assert.rejects(getAccessToken(svc, 'alice'), NotConnectedError);
          return 'turn ended';
        }),
        new Promise((r) => setTimeout(() => r('deadlock'), 3000)),
      ]);
      assert.equal(outcome, 'turn ended');
      assert.ok(await settle(async () => (await store.loadBookmarks('alice')).length === 0), 'the rows go after the turn');
    });

    test('keeps the rows when the user connects again before the delete turn runs', async () => {
      await withRows('alice');
      revokeAnswer(400);
      await serialize('alice', async () => {
        await assert.rejects(getAccessToken(svc, 'alice'), NotConnectedError);
        await connect('alice'); // the new connection comes while the delete waits for the turn
      });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await store.loadBookmarks('alice')).length, 1);
    });

    test('cancels a running sync of the user', async () => {
      await withRows('alice');
      revokeAnswer(400);
      const run = { cancelled: false };
      svc.syncs.set('alice', run);
      await assert.rejects(getAccessToken(svc, 'alice'), NotConnectedError);
      assert.equal(run.cancelled, true);
    });

    test('does nothing to the rows when the flag is off', async () => {
      await withRows('alice');
      config.bookmarkStore = false;
      revokeAnswer(400);
      await assert.rejects(getAccessToken(svc, 'alice'), NotConnectedError);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await store.loadBookmarks('alice')).length, 1);
    });
  });
});
