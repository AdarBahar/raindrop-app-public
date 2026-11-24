// The app with the stored copy turned on (BOOKMARK_STORE=on). Real routes, real store, a fake Raindrop server.
// The rules are in docs/bookmark-store-plan.md, sections 3, 6, 7 and 8.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';

const EMAIL = (name) => `${name}@example.test`;
const userOf = (token) => (token?.startsWith('tok-alice') ? 'alice' : token?.startsWith('tok-bob') ? 'bob' : null);
const CODES = { 'code-alice': 'alice', 'code-bob': 'bob' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const day = Date.UTC(2026, 0, 1);
const makeItems = (n, prefix = '') => Array.from({ length: n }, (_, i) => ({
  _id: i + 1, title: `${prefix}Bookmark ${i + 1}`, link: `https://example.com/${i + 1}`, domain: 'example.com', excerpt: '', note: '',
  tags: i % 2 ? ['odd'] : [], collection: { $ref: 'collections', $id: i < 30 ? 10 : -1, oid: i < 30 ? 10 : -1 }, collectionId: i < 30 ? 10 : -1,
  created: new Date(day + i * 60000).toISOString(), lastUpdate: new Date(day + i * 60000).toISOString(),
}));

describe('the stored copy turned on', { skip: SKIP_REASON }, () => {
  let schema; let store; let svc; let app; let base; let fake;
  let world; // the fake Raindrop data of each user
  let calls; // the paths that the fake Raindrop received
  let hooks; // behavior that a test adds to the fake
  let config; let syncModule;

  const reset = () => {
    world = {
      alice: { items: makeItems(60), collections: [{ _id: 10, title: 'Work', count: 30 }, { _id: 11, title: 'Home', count: 0 }], nextId: 500 },
      bob: { items: makeItems(3, 'Bob '), collections: [{ _id: 20, title: 'Bob Folder', count: 0 }], nextId: 700 },
    };
    calls = [];
    hooks = {};
  };

  function startFake() {
    return createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fake');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};

      if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
        if (body.grant_type === 'authorization_code') {
          const user = CODES[body.code];
          if (!user) return send(400, { error: 'bad_authorization_code' });
          return send(200, { access_token: `tok-${user}`, refresh_token: `ref-${user}`, expires_in: 1209599, token_type: 'Bearer' });
        }
        return send(400, { error: 'unsupported' });
      }
      const user = userOf((req.headers.authorization ?? '').replace('Bearer ', ''));
      if (!user) return send(401, { error: 'unauthorized' });
      const w = world[user];
      const path = url.pathname.replace('/rest/v1', '');
      calls.push(`${req.method} ${path}${url.search}`);

      if (path === '/user') return send(200, { user: { fullName: `${user} Tester`, email: `${user}@fake.example` } });
      if (path === '/user/stats') return send(200, { items: [{ _id: 0, count: w.items.length }] });
      if (path === '/collections') return send(200, { items: w.collections });
      if (path === '/collections/childrens') return send(200, { items: [] });
      if (req.method === 'POST' && path === '/collection') {
        await hooks.beforeFolder?.();
        const created = { _id: w.nextId++, title: body.title, count: 0 };
        w.collections.push(created);
        return send(200, { item: created });
      }
      if (req.method === 'GET' && path === '/raindrops/0') {
        const per = Number(url.searchParams.get('perpage'));
        const page = Number(url.searchParams.get('page'));
        // The page is a copy made now. A change after this point is not in it.
        const items = JSON.parse(JSON.stringify(w.items.slice(page * per, (page + 1) * per)));
        // A hook answers 'fail' to give the error 400. Raindrop calls do not retry it.
        if ((await hooks.afterPage?.(user, page)) === 'fail') return send(400, { error: 'cut' });
        return send(200, { items });
      }
      if (req.method === 'PUT' && path === '/raindrops/0') {
        for (const id of body.ids) {
          const it = w.items.find((i) => i._id === id);
          if (body.collection) { it.collection = { ...it.collection, $id: body.collection.$id }; it.collectionId = body.collection.$id; }
          if (body.tags) it.tags = [...new Set([...it.tags, ...body.tags])];
        }
        return send(200, { result: true, matched: body.ids.length, modified: body.ids.length });
      }
      const single = path.match(/^\/raindrop\/(\d+)$/);
      if (single) {
        const it = w.items.find((i) => i._id === Number(single[1]));
        if (!it) return send(404, {});
        if (req.method === 'PUT') {
          if (body.tags) it.tags = [...body.tags];
          if (typeof body.note === 'string') it.note = body.note;
          if (body.collection) { it.collection = { ...it.collection, $id: body.collection.$id }; it.collectionId = body.collection.$id; }
          it.lastUpdate = new Date().toISOString();
        }
        return send(200, { item: it });
      }
      return send(404, { error: `unknown ${req.method} ${path}` });
    });
  }

  before(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rs-reads-'));
    schema = await createTestSchema();
    reset();
    fake = startFake();
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakePort = fake.address().port;
    // The environment is set before the app modules load, because config reads it on import.
    Object.assign(process.env, {
      BOOKMARK_STORE: 'on',
      DATA_DIR: dataDir,
      DATA_KEY_FILE: join(dataDir, 'key'),
      RAINDROP_API_BASE: `http://127.0.0.1:${fakePort}/rest/v1`,
      RAINDROP_OAUTH_BASE: `http://127.0.0.1:${fakePort}/oauth`,
      RAINDROP_CLIENT_ID: 'test-client',
      RAINDROP_CLIENT_SECRET: 'test-secret',
      RAINDROP_ENV_FILE: join(dataDir, 'none.env'),
    });
    ({ config } = await import('../src/config.js'));
    config.raindrop.minIntervalMs = 0;
    config.sync.retryWaitMs = 0;
    config.sync.emptyRecheckMs = 0;
    config.sync.writeRetryMs = 0;
    syncModule = await import('../src/sync.js');
    const { openStore } = await import('../src/store.js');
    const { loadOrCreateKey } = await import('../src/crypto.js');
    const { createApp } = await import('../src/server.js');
    store = openStore({ url: TEST_URL, schema });
    svc = {
      store, key: loadOrCreateKey(process.env.DATA_KEY_FILE),
      cache: new Map(), profiles: new Map(), states: new Map(), generations: new Map(), refreshing: new Map(), syncs: new Map(),
    };
    app = createApp(svc);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(async () => {
    app.closeAllConnections();
    app.close();
    fake.closeAllConnections();
    fake.close();
    await store.close();
    await dropTestSchema(schema);
  });

  async function call(method, path, { user = 'alice', body } = {}) {
    const headers = { 'x-admintools-email': EMAIL(user) };
    if (method === 'POST') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json };
  }

  // A connected user with tokens, and no stored copy. The memory of the app is empty.
  async function freshUser(name) {
    const { encrypt } = await import('../src/crypto.js');
    const id = EMAIL(name);
    await store.deleteUserData(id);
    await store.ensureUser(id);
    await store.saveTokens(id, encrypt(`tok-${name}`, svc.key), encrypt(`ref-${name}`, svc.key), Date.now() + 3600 * 1000);
    svc.cache.delete(id);
    svc.profiles.delete(id);
    svc.syncs.delete(id);
  }

  const pageCalls = () => calls.filter((c) => c.startsWith('GET /raindrops/0'));
  const stored = async (name = 'alice') => new Map((await store.loadBookmarks(EMAIL(name))).map((i) => [i._id, i]));

  async function waitJob(id, user = 'alice') {
    for (let i = 0; i < 400; i++) {
      const job = (await call('GET', `/api/bulk/${id}`, { user })).json;
      if (job.status !== 'running') return job;
      await sleep(10);
    }
    throw new Error('job did not finish');
  }

  beforeEach(async () => {
    reset();
    svc.dirty = new Set();
    await freshUser('alice');
    await freshUser('bob');
  });

  describe('reads', () => {
    test('the first request makes the copy, and later requests make no Raindrop call', async () => {
      const first = await call('GET', '/api/bookmarks?preset=all');
      assert.equal(first.status, 200);
      assert.equal(first.json.total, 60);
      assert.equal(pageCalls().length, 2);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 60);

      calls.length = 0;
      assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 60);
      assert.equal((await call('GET', '/api/meta')).status, 200);
      assert.deepEqual(calls, []);
    });

    test('a restart of the app reads the copy and makes no Raindrop call', async () => {
      await call('GET', '/api/bookmarks?preset=all');
      svc.cache.clear(); // the memory of a new process is empty
      calls.length = 0;
      const res = await call('GET', '/api/bookmarks?preset=all');
      assert.equal(res.json.total, 60);
      assert.deepEqual(calls, []);
    });

    test('the results have the same shape as before, and the Unsorted folder is there', async () => {
      const res = await call('GET', '/api/bookmarks?preset=all&pageSize=25');
      assert.equal(res.json.results.length, 25);
      assert.deepEqual(Object.keys(res.json.results[0]).sort(), [
        'collection', 'collection_id', 'created', 'domain', 'dupe_note', 'dupes', 'excerpt', 'id', 'is_new', 'last_visit', 'link',
        'loose_key', 'maybe_dupes', 'maybe_why', 'needs', 'note', 'period', 'tags', 'title', 'url_key', 'visits',
      ]);
      const meta = (await call('GET', '/api/meta')).json;
      const names = meta.collections.map((c) => c.name);
      assert.ok(names.includes('Unsorted') && names.includes('Work') && names.includes('Home'));
      assert.equal(meta.collections.find((c) => c.name === 'Unsorted').count, 30);
    });

    test('the first request of a user does not hold up the progress route', async () => {
      hooks.afterPage = async (_user, page) => { if (page === 0) await sleep(300); };
      const first = call('GET', '/api/meta');
      await sleep(120);
      const started = Date.now();
      const progress = await call('GET', '/api/progress');
      assert.equal(progress.status, 200);
      assert.ok(Date.now() - started < 200, 'the progress answer does not wait for the sync');
      assert.equal(progress.json.total, 60);
      assert.equal((await first).status, 200);
    });

    test('two requests at the same time share the first sync', async () => {
      const [a, b] = await Promise.all([call('GET', '/api/meta'), call('GET', '/api/bookmarks?preset=all')]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(pageCalls().length, 2);
    });

    test('a user is not synced until a request needs data, and /api/me reports the sync', async () => {
      const before = (await call('GET', '/api/me')).json;
      assert.equal(before.syncedAt, null);
      await call('GET', '/api/meta');
      const after = (await call('GET', '/api/me')).json;
      assert.match(after.syncedAt, /^\d{4}-\d\d-\d\dT/);
      assert.equal(after.syncError, null);
    });

    test('two users see only their own bookmarks', async () => {
      const a = await call('GET', '/api/bookmarks?preset=all', { user: 'alice' });
      const b = await call('GET', '/api/bookmarks?preset=all', { user: 'bob' });
      assert.equal(a.json.total, 60);
      assert.equal(b.json.total, 3);
      assert.ok(b.json.results.every((r) => r.title.startsWith('Bob ')));
    });

    test('inside a queue turn, a user with no copy gets the error 409 and the turn does not wait', async () => {
      const { serialize } = await import('../src/util.js');
      const { loadAll } = await import('../src/bookmarks.js');
      const outcome = await Promise.race([
        serialize(EMAIL('alice'), () => loadAll(svc, EMAIL('alice'))).then(() => 'loaded', (err) => `${err.status}`),
        sleep(2000).then(() => 'deadlock'),
      ]);
      assert.equal(outcome, '409');
    });

    test('a failed first sync gives an error, keeps no rows, and the next request tries again', async () => {
      hooks.afterPage = async () => 'fail';
      const bad = await call('GET', '/api/meta');
      assert.notEqual(bad.status, 200);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      hooks = {};
      assert.equal((await call('GET', '/api/meta')).status, 200);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 60);
    });
  });

  describe('write-through', () => {
    beforeEach(async () => {
      await call('GET', '/api/meta');
      calls.length = 0;
    });

    test('a save changes Raindrop and the stored copy, with no new list call', async () => {
      const res = await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x', 'y'] } });
      assert.equal(res.status, 200);
      assert.deepEqual(world.alice.items.find((i) => i._id === 5).tags, ['x', 'y']);
      const row = (await stored()).get(5);
      assert.deepEqual(row.tags, ['x', 'y']);
      assert.equal(row.collection.$id, 11);
      assert.equal(row.collection.$ref, 'collections'); // the object that Raindrop returned
      assert.deepEqual(pageCalls(), []);
      const list = await call('GET', '/api/bookmarks?preset=all&collection=11');
      assert.deepEqual(list.json.results.map((r) => r.id), [5]);
    });

    test('a save with a note stores the note, and a later save without a note keeps it', async () => {
      await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x'], note: 'line 1\nline 2' } });
      assert.equal(world.alice.items.find((i) => i._id === 5).note, 'line 1\nline 2');
      assert.equal((await stored()).get(5).note, 'line 1\nline 2');
      await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['y'] } });
      assert.equal((await stored()).get(5).note, 'line 1\nline 2');
      svc.cache.clear();
      assert.equal((await call('GET', '/api/bookmarks?preset=all&collection=11')).json.results[0].note, 'line 1\nline 2');
    });

    test('a save without a note takes the note that Raindrop returned', async () => {
      await call('GET', '/api/bookmarks?preset=all');
      // The note changed in a Raindrop app after the list was loaded.
      world.alice.items.find((i) => i._id === 5).note = 'changed in Raindrop';
      const res = await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x'] } });
      assert.equal(res.json.note, 'changed in Raindrop');
      assert.equal((await call('GET', '/api/bookmarks?preset=all&collection=11')).json.results[0].note, 'changed in Raindrop');
      assert.equal((await stored()).get(5).note, 'changed in Raindrop');
    });

    test('a save survives a restart and the next full sync', async () => {
      await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x'] } });
      svc.cache.clear();
      assert.deepEqual((await call('GET', '/api/bookmarks?preset=all&collection=11')).json.results.map((r) => r.id), [5]);
      assert.equal((await call('POST', '/api/pull')).status, 200);
      assert.deepEqual((await stored()).get(5).tags, ['x']);
    });

    test('a new folder is stored and shows in the folder list', async () => {
      const res = await call('POST', '/api/folder', { body: { name: 'Fresh' } });
      assert.equal(res.status, 200);
      const folders = await store.loadCollections(EMAIL('alice'));
      assert.ok(folders.some((f) => f.title === 'Fresh' && f._id === Number(res.json.id)));
      assert.ok((await call('GET', '/api/meta')).json.collections.some((c) => c.name === 'Fresh'));
    });

    test('a bulk move changes the stored copy of all selected bookmarks', async () => {
      const job = await call('POST', '/api/bulk', { body: { action: 'move', ids: [1, 2, 40], folderId: 11 } });
      assert.equal(job.status, 200);
      assert.equal((await waitJob(job.json.id)).status, 'done');
      const rows = await stored();
      for (const id of [1, 2, 40]) {
        assert.equal(rows.get(id).collection.$id, 11);
        assert.equal(rows.get(id).collectionId, 11);
        assert.equal(rows.get(id).collection.$ref, 'collections');
      }
      assert.equal(rows.get(3).collection.$id, 10);
    });

    test('a bulk add of tags appends, and the same job again adds no tag twice', async () => {
      for (let round = 0; round < 2; round++) {
        const job = await call('POST', '/api/bulk', { body: { action: 'addTags', ids: [1, 2], tags: ['new', 'NEW'] } });
        assert.equal((await waitJob(job.json.id)).status, 'done');
      }
      const rows = await stored();
      assert.deepEqual(rows.get(1).tags, ['new']);
      assert.deepEqual(rows.get(2).tags, ['odd', 'new']);
      assert.deepEqual(world.alice.items.find((i) => i._id === 2).tags, ['odd', 'new']);
    });

    test('removing a tag replaces the tags in the stored copy, with the object that Raindrop returned', async () => {
      const job = await call('POST', '/api/bulk', { body: { action: 'removeTags', ids: [2, 4], tags: ['odd'] } });
      assert.equal((await waitJob(job.json.id)).status, 'done');
      const rows = await stored();
      assert.deepEqual(rows.get(2).tags, []);
      assert.deepEqual(rows.get(4).tags, []);
      assert.deepEqual(rows.get(2), world.alice.items.find((i) => i._id === 2));
    });

    test('an undo restores the stored copy', async () => {
      const job = await call('POST', '/api/bulk', { body: { action: 'move', ids: [1, 2], folderId: 11 } });
      await waitJob(job.json.id);
      const undo = await call('POST', `/api/bulk/${job.json.id}/undo`);
      assert.equal(undo.status, 200);
      assert.equal((await waitJob(undo.json.id)).status, 'done');
      const rows = await stored();
      assert.equal(rows.get(1).collection.$id, 10);
      assert.equal(rows.get(2).collection.$id, 10);
    });

    test('a failed database write does not fail the save, and the user is marked for a sync soon', async () => {
      const real = store.updateBookmarks;
      const realUpsert = store.upsertBookmark;
      store.upsertBookmark = async () => { throw new Error('database is down'); };
      store.updateBookmarks = async () => { throw new Error('database is down'); };
      try {
        const res = await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x'] } });
        assert.equal(res.status, 200);
      } finally {
        store.upsertBookmark = realUpsert;
        store.updateBookmarks = real;
      }
      assert.deepEqual(world.alice.items.find((i) => i._id === 5).tags, ['x']);
      assert.equal(svc.dirty.has(EMAIL('alice')), true);
      const state = await store.getSyncState(EMAIL('alice'));
      assert.match(state.lastError, /database write failed/);
      assert.notEqual(state.nextRetryAt, null);
      assert.equal(state.consecutiveFailures, 0);
      assert.deepEqual((await stored()).get(5).tags, [], 'the stored row is old until the next sync');
    });

    test('a database write that fails once is tried again and succeeds', async () => {
      const realUpsert = store.upsertBookmark;
      let tries = 0;
      store.upsertBookmark = async (...args) => { tries += 1; if (tries === 1) throw new Error('blip'); return realUpsert.apply(store, args); };
      try {
        assert.equal((await call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['x'] } })).status, 200);
      } finally {
        store.upsertBookmark = realUpsert;
      }
      assert.equal(tries, 2);
      assert.deepEqual((await stored()).get(5).tags, ['x']);
      assert.equal(svc.dirty?.has(EMAIL('alice')) ?? false, false);
    });
  });

  describe('changes during a sync', () => {
    beforeEach(async () => {
      await call('GET', '/api/meta');
      calls.length = 0;
    });

    test('a save during the fetch of a full sync is not lost', async () => {
      // Page 0 is a copy from before the save. The save runs while the sync waits for page 1.
      let saved;
      hooks.afterPage = async (_user, page) => {
        if (page === 0) saved = call('POST', '/api/save', { body: { id: 5, folderId: 11, tags: ['during'] } });
        if (page === 0) await saved;
      };
      const pull = await call('POST', '/api/pull');
      assert.equal(pull.status, 200);
      assert.equal((await saved).status, 200);
      const row = (await stored()).get(5);
      assert.deepEqual(row.tags, ['during']);
      assert.equal(row.collection.$id, 11);
      svc.cache.clear();
      assert.deepEqual((await call('GET', '/api/bookmarks?preset=all&collection=11')).json.results.map((r) => r.id), [5]);
    });

    test('a bulk move during the fetch of a full sync is kept', async () => {
      let job;
      hooks.afterPage = async (_user, page) => {
        if (page === 0) {
          job = (await call('POST', '/api/bulk', { body: { action: 'move', ids: [1, 2], folderId: 11 } })).json;
          await waitJob(job.id);
        }
      };
      assert.equal((await call('POST', '/api/pull')).status, 200);
      const rows = await stored();
      assert.equal(rows.get(1).collection.$id, 11);
      assert.equal(rows.get(2).collection.$id, 11);
    });

    test('a bookmark that Raindrop gained or lost outside the app shows after the next full sync', async () => {
      world.alice.items.push({ ...makeItems(1)[0], _id: 61, title: 'Added elsewhere' });
      world.alice.items = world.alice.items.filter((i) => i._id !== 7);
      assert.equal((await call('POST', '/api/pull')).status, 200);
      const rows = await stored();
      assert.equal(rows.has(61), true);
      assert.equal(rows.has(7), false);
      assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 60);
    });
  });

  describe('check for new bookmarks', () => {
    test('the first check saves the baseline, a later check labels the new bookmarks, and no deadlock happens', async () => {
      const first = await call('POST', '/api/pull');
      assert.equal(first.status, 200);
      assert.match(first.json.message, /Baseline saved/);
      world.alice.items.push({ ...makeItems(1)[0], _id: 61, title: 'Brand new' });
      const second = await call('POST', '/api/pull');
      assert.equal(second.status, 200);
      assert.equal(second.json.new, 1);
      const list = await call('GET', '/api/bookmarks?preset=all&status=new');
      assert.deepEqual(list.json.results.map((r) => r.title), ['Brand new']);
      assert.notEqual((await call('GET', '/api/me')).json.lastChecked, null);
    });

    test('the check reads the new copy: a bookmark deleted in Raindrop is gone', async () => {
      await call('POST', '/api/pull');
      world.alice.items = world.alice.items.filter((i) => i._id !== 3);
      await call('POST', '/api/pull');
      assert.equal((await call('GET', '/api/bookmarks?q=Bookmark%203%20&preset=all')).json.results.some((r) => r.id === 3), false);
    });

    test('a failed sync fails the check, keeps the copy, and records the failure', async () => {
      await call('GET', '/api/meta');
      hooks.afterPage = async () => 'fail';
      const res = await call('POST', '/api/pull');
      assert.notEqual(res.status, 200);
      hooks = {};
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 60);
      const me = (await call('GET', '/api/me')).json;
      assert.notEqual(me.syncError, null);
      assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 60);
    });
  });

  describe('disconnect and delete', () => {
    beforeEach(async () => {
      await call('GET', '/api/meta');
    });

    test('a disconnect deletes the stored copy and the sync state', async () => {
      assert.equal((await call('POST', '/api/disconnect')).status, 200);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      assert.equal((await store.loadCollections(EMAIL('alice'))).length, 0);
      assert.equal(await store.getSyncState(EMAIL('alice')), null);
      assert.equal((await call('GET', '/api/meta')).status, 409);
      assert.equal((await store.loadBookmarks(EMAIL('bob'))).length, 0, 'bob never synced');
    });

    test('a disconnect does not delete the copy of another user', async () => {
      await call('GET', '/api/meta', { user: 'bob' });
      await call('POST', '/api/disconnect', { user: 'alice' });
      assert.equal((await store.loadBookmarks(EMAIL('bob'))).length, 3);
    });

    test('a disconnect cancels the bulk jobs of the user', async () => {
      const job = await call('POST', '/api/bulk', { body: { action: 'move', ids: Array.from({ length: 30 }, (_, i) => i + 1), folderId: 11 } });
      const bulk = await import('../src/bulk.js');
      assert.notEqual(bulk.getJob(svc, EMAIL('alice'), job.json.id), null);
      await call('POST', '/api/disconnect');
      assert.equal(bulk.getJob(svc, EMAIL('alice'), job.json.id), null);
    });

    test('a disconnect during the first sync leaves no row and no state', async () => {
      await freshUser('alice');
      hooks.afterPage = async (_user, page) => { if (page === 0) await sleep(200); };
      const first = call('GET', '/api/meta');
      await sleep(80);
      await call('POST', '/api/disconnect');
      await first;
      await sleep(50);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      assert.equal(await store.getSyncState(EMAIL('alice')), null);
    });

    test('a folder created while the user disconnects leaves no row', async () => {
      // Raindrop accepts the folder after the disconnect. The write to the stored copy must be skipped.
      hooks.beforeFolder = () => sleep(200);
      const folder = call('POST', '/api/folder', { body: { name: 'Late' } });
      await sleep(60);
      await call('POST', '/api/disconnect');
      assert.equal((await folder).status, 200);
      assert.ok(world.alice.collections.some((c) => c.title === 'Late'), 'Raindrop has the folder');
      assert.equal((await store.loadCollections(EMAIL('alice'))).length, 0);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      assert.equal(await store.getSyncState(EMAIL('alice')), null);
    });

    test('delete-my-data removes the stored copy and the state', async () => {
      assert.equal((await call('POST', '/api/delete-data')).status, 200);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      assert.equal(await store.getSyncState(EMAIL('alice')), null);
    });

    test('a new connection waits for the queue, and the old tokens and the old rows go away together', async () => {
      // The user has account A (alice data). A slow save holds the queue. The user connects account B (bob data).
      // The new tokens must not be visible while the rows of A still exist. Otherwise a read returns A's rows.
      const { serialize } = await import('../src/util.js');
      const { decrypt } = await import('../src/crypto.js');
      const id = EMAIL('alice');
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      const held = serialize(id, () => hold);
      // Look at the tokens at the moment the old rows are deleted. They must still be the tokens of A.
      const realDelete = store.deleteBookmarkStore;
      let tokensAtDelete = null;
      store.deleteBookmarkStore = async (user) => {
        tokensAtDelete = decrypt((await store.getTokens(user)).access_enc, svc.key);
        await sleep(60);
        return realDelete.call(store, user);
      };
      const start = await call('GET', '/oauth/start');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const back = call('GET', `/oauth/callback?code=code-bob&state=${state}`);
      await sleep(120);

      try {
        const during = await store.getTokens(id);
        assert.equal(decrypt(during.access_enc, svc.key), 'tok-alice', 'the old tokens stay while the queue is busy');
        assert.equal((await store.loadBookmarks(id)).length, 60);
        assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 60, 'a read shows account A with the tokens of A');
      } finally {
        release(); // a failed assertion must not leave the queue held for ever
      }
      await held;
      try {
        assert.equal((await back).status, 302);
      } finally {
        store.deleteBookmarkStore = realDelete;
      }
      assert.equal(tokensAtDelete, 'tok-alice', 'the rows are deleted before the new tokens are saved');
      assert.equal(decrypt((await store.getTokens(id)).access_enc, svc.key), 'tok-bob');
      assert.equal((await store.loadBookmarks(id)).length, 0);
      const after = await call('GET', '/api/bookmarks?preset=all');
      assert.equal(after.json.total, 3);
      assert.ok(after.json.results.every((r) => r.title.startsWith('Bob ')));
    });

    test('a disconnect while a new connection waits for the queue cancels the new connection', async () => {
      const { serialize } = await import('../src/util.js');
      const id = EMAIL('alice');
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      const held = serialize(id, () => hold);
      const start = await call('GET', '/oauth/start');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const back = call('GET', `/oauth/callback?code=code-bob&state=${state}`);
      await sleep(80);
      const disconnect = call('POST', '/api/disconnect');
      await sleep(40);
      release();
      await held;
      assert.equal((await back).status, 409);
      await disconnect;
      assert.equal(await store.getTokens(id), null, 'no new tokens were saved');
      assert.equal((await store.loadBookmarks(id)).length, 0);
    });

    test('a disconnect during the delete of a new connection cancels the connection', async () => {
      // The disconnect does not use the queue. It can come while the callback waits for the delete of the old rows.
      const id = EMAIL('alice');
      let atDelete;
      const reached = new Promise((resolve) => { atDelete = resolve; });
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const realDelete = store.deleteBookmarkStore;
      let first = true;
      store.deleteBookmarkStore = async (user) => {
        if (first) { first = false; atDelete(); await barrier; }
        return realDelete.call(store, user);
      };
      let back;
      let disconnect;
      try {
        const start = await call('GET', '/oauth/start');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        back = call('GET', `/oauth/callback?code=code-bob&state=${state}`);
        await reached;
        disconnect = call('POST', '/api/disconnect'); // takes the tokens away while the callback waits
        await sleep(100);
      } finally {
        release();
      }
      assert.equal((await back).status, 409, 'the callback does not connect after the disconnect');
      assert.equal((await disconnect).status, 200);
      store.deleteBookmarkStore = realDelete;
      assert.equal(await store.getTokens(id), null, 'the account stays disconnected');
      assert.equal((await store.loadBookmarks(id)).length, 0);
    });

    test('no sync starts while a new connection saves its tokens', async () => {
      // connect() changes the generation first and saves the tokens after. In that time the old tokens still work.
      // A sync that starts then would store the bookmarks of the old account for the new connection.
      const id = EMAIL('alice');
      const { decrypt } = await import('../src/crypto.js');
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      let atSave;
      const reached = new Promise((resolve) => { atSave = resolve; });
      const realSave = store.saveTokens;
      store.saveTokens = async (...args) => { atSave(); await barrier; return realSave.apply(store, args); };
      let back;
      let read;
      let outcome;
      try {
        const start = await call('GET', '/oauth/start');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        back = call('GET', `/oauth/callback?code=code-bob&state=${state}`);
        await reached;
        read = call('GET', '/api/bookmarks?preset=all');
        outcome = await Promise.race([read.then((r) => r.status), sleep(400).then(() => 'waiting')]);
      } finally {
        release();
        store.saveTokens = realSave;
      }
      assert.equal(outcome, 409, 'the read is refused while the connection changes');
      assert.equal((await back).status, 302);
      assert.equal((await store.loadBookmarks(id)).length, 0, 'no bookmark of the old account was stored');
      assert.equal(decrypt((await store.getTokens(id)).access_enc, svc.key), 'tok-bob');
      const after = await call('GET', '/api/bookmarks?preset=all');
      assert.equal(after.json.total, 3);
      assert.equal(svc.changing.has(id), false, 'the change ended');
    });

    test('a new connection starts with an empty stored copy', async () => {
      // Rows of an earlier connection stay behind, as after a revoked authorization (the revoke path of PR 4 removes them, and the test below leaves them in place on purpose).
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 60);
      const start = await call('GET', '/oauth/start', { user: 'alice' });
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const back = await call('GET', `/oauth/callback?code=code-alice&state=${state}`, { user: 'alice' });
      assert.equal(back.status, 302);
      assert.equal((await store.loadBookmarks(EMAIL('alice'))).length, 0);
      assert.equal(await store.getSyncState(EMAIL('alice')), null);
      assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 60, 'the first request makes a new copy');
    });
  });

  describe('the memory cache', () => {
    test('a full sync makes the memory cache valid again for the new copy only', async () => {
      await call('GET', '/api/bookmarks?preset=all');
      const before = syncModule.storeVersion(svc, EMAIL('alice'));
      world.alice.items.push({ ...makeItems(1)[0], _id: 61, title: 'After the sync' });
      await call('POST', '/api/pull');
      assert.ok(syncModule.storeVersion(svc, EMAIL('alice')) > before);
      calls.length = 0;
      assert.equal((await call('GET', '/api/bookmarks?preset=all')).json.total, 61);
      assert.deepEqual(calls, []);
    });
  });
});
