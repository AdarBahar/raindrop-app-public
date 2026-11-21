// What the app keeps about a user: the delete-my-data action, and the change-log retention time.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retentionCutoff } from '../src/store.js';
import { forgetJobs, startJob } from '../src/bulk.js';
import { SKIP_REASON, TEST_URL, createTestSchema, dropTestSchema } from './helpers/db.js';
import { pageScript } from './helpers/frontend.js';

const USER = 'alice@example.com';
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const js = pageScript();

describe('retention', () => {
  test('the cutoff is the retention time before now, as ISO text', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    assert.equal(retentionCutoff(90, now), '2026-08-04T12:00:00.000Z');
    assert.equal(retentionCutoff(0, now), '2026-11-02T12:00:00.000Z');
  });
});

describe('delete my data', () => {
  test('the sidebar has the button, and the dialog asks before anything is deleted', () => {
    assert.match(html, /<button id="deleteBtn"[^>]*>Delete my data<\/button>/);
    assert.match(html, /<dialog id="deleteDlg"/);
    assert.match(html, /Your bookmarks in Raindrop are not changed\./);
    // Nothing is sent until the confirm button is pressed.
    assert.match(js, /\$\('deleteOk'\)\.onclick = async \(\) => \{\n\s+\$\('deleteOk'\)\.disabled = true;\n\s+try \{\n\s+await postJson\('\/api\/delete-data'\);/);
  });

  test('the route answers without a Raindrop connection and deletes the user data', async () => {
    const { createApp } = await import('../src/server.js');
    const calls = [];
    const svc = {
      cache: new Map(), profiles: new Map(), generations: new Map(), states: new Map(), refreshing: new Map(),
      store: {
        getTokens: async () => null,
        deleteTokens: async () => calls.push('deleteTokens'),
        deleteUserData: async (id) => calls.push(`deleteUserData:${id}`),
      },
    };
    const app = createApp(svc);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      svc.jobs = new Map([
        ['mine', { id: 'mine', userId: USER, action: 'suggest', status: 'done', suggestions: [{ title: 'secret' }], changes: [] }],
        ['theirs', { id: 'theirs', userId: 'bob@example.com', action: 'move', status: 'done', changes: [] }],
      ]);
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/delete-data`, {
        method: 'POST',
        headers: { 'x-admintools-email': USER, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(calls.filter((c) => c.startsWith('deleteUserData')), [`deleteUserData:${USER}`]);
      // The user's jobs, with their titles and suggestions, are gone. Another user's job stays.
      assert.deepEqual([...svc.jobs.keys()], ['theirs']);
    } finally {
      app.close();
    }
  });
});

describe('store: delete and prune', { skip: SKIP_REASON }, () => {
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

  test('deleting one user removes only that user, and the change log is pruned by time', async () => {
    for (const user of [USER, 'bob@example.com']) {
      await store.ensureUser(user);
      await store.recordVisit(user, 1, '2026-01-01T00:00:00.000Z');
      await store.addLog(user, { time: '2026-01-01T00:00:00.000Z', id: 1, title: 'old' });
      await store.addLog(user, { time: '2026-11-01T00:00:00.000Z', id: 2, title: 'new' });
    }
    assert.equal(await store.pruneLog('2026-06-01T00:00:00.000Z'), 2);

    await store.keepDuplicates(USER, 'h1', [1, 2]);
    await store.keepDuplicates(USER, 'h1', [1, 2, 3]); // a second keep replaces the IDs
    await store.keepDuplicates('bob@example.com', 'h1', [7, 8]);
    assert.deepEqual(await store.keptDuplicates(USER), [{ hash: 'h1', ids: [1, 2, 3] }]);
    await store.unkeepDuplicates('bob@example.com', 'h1');
    assert.deepEqual(await store.keptDuplicates('bob@example.com'), []);
    await store.keepDuplicates('bob@example.com', 'h2', [9]);

    await store.deleteUserData(USER);
    assert.equal((await store.visits(USER)).size, 0);
    assert.deepEqual(await store.keptDuplicates(USER), []);
    assert.equal((await store.keptDuplicates('bob@example.com')).length, 1);
    assert.equal(await store.hasBaseline(USER), false);
    assert.equal((await store.visits('bob@example.com')).size, 1);
  });
});

describe('suggestions say what is sent', () => {
  test('the suggest dialog and the suggest button name the data that leaves the app', () => {
    assert.match(html, /<p class="muted" id="suggestNotice">Suggesting sends the title, link, note and excerpt/);
    assert.match(js, /title="Sends the title, link, note, excerpt, current folder and tags of this bookmark, your folder names, your known tags and the active entries of My context to the language model"/);
  });
});

describe('a job running during delete writes no log row', () => {
  test('the change is not logged after the user data was deleted', async () => {
    const svc = {
      cache: new Map(),
      log: [],
      store: {
        removeNew: async () => {},
        addLog: async (u, entry) => svc.log.push(entry),
        keptDuplicates: () => [], newItems: () => new Set(),
        visits: () => new Map(),
      },
    };
    svc.cache.set(USER, {
      at: Date.now(),
      items: [{ _id: 1, title: 't', tags: [], collection: { $id: 10 }, created: new Date().toISOString() }],
      collections: new Map([[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']]),
      progress: {}, loading: null,
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const call = async () => { await gate; return {}; }; // Raindrop answers only after the delete
    await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, call);
    forgetJobs(svc, USER);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(svc.log, []);
  });
});

describe('delete-my-data waits for writes in progress', () => {
  test('a log write in progress finishes before the deletion, and nothing is written after it', async () => {
    const { createApp } = await import('../src/server.js');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let writeStarted = false;
    let deletedAt = null;
    const svc = {
      cache: new Map(), profiles: new Map(), generations: new Map(), states: new Map(), refreshing: new Map(),
      log: [],
      store: {
        deleteTokens: async () => {},
        removeNew: async () => { writeStarted = true; await gate; }, // the write is in progress
        addLog: async (u, entry) => { svc.log.push(entry); },
        keptDuplicates: () => [], newItems: () => new Set(),
        visits: () => new Map(),
        deleteUserData: async () => { deletedAt = svc.log.length; },
      },
    };
    svc.cache.set(USER, {
      at: Date.now(),
      items: [{ _id: 1, title: 'secret title', tags: [], collection: { $id: 10 }, created: new Date().toISOString() }],
      collections: new Map([[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']]),
      progress: {}, loading: null,
    });
    await startJob(svc, USER, { action: 'move', ids: [1], folderId: 20 }, async () => ({}));
    for (let i = 0; i < 100 && !writeStarted; i++) await new Promise((r) => setTimeout(r, 2));
    assert.ok(writeStarted);

    const app = createApp(svc);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const pending = fetch(`http://127.0.0.1:${app.address().port}/api/delete-data`, {
        method: 'POST',
        headers: { 'x-admintools-email': USER, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(deletedAt, null, 'the deletion waits for the write in progress');
      release();
      assert.equal((await pending).status, 200);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(deletedAt, 1, 'the write finished before the deletion');
      assert.equal(svc.log.length, deletedAt, 'no change-log row is written after the deletion');
    } finally {
      app.close();
    }
  });
});
