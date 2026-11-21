// Review fixes: tag input is a list, a model reply entry that is not an object is skipped,
// the token key must be 32 bytes, missing static files are 404, and bulk writes read the live bookmark first.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tagList } from '../src/limits.js';
import { parseRepliesV2, ReplyError } from '../src/llm.js';
import { loadOrCreateKey } from '../src/crypto.js';
import { getJob, startJob } from '../src/bulk.js';

const USER = 'alice@example.com';
const collections = [[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']];

describe('tag input', () => {
  test('a list of text is accepted, and nothing is treated as no tags', () => {
    assert.deepEqual(tagList(['a', 'b']), ['a', 'b']);
    assert.deepEqual(tagList(undefined), []);
  });

  test('a string is refused, so it is not split into one-letter tags', () => {
    assert.throws(() => tagList('work'), { status: 400, message: 'Tags must be a list of text.' });
  });

  test('a list with a non-text item is refused', () => {
    assert.throws(() => tagList(['ok', { a: 1 }]), { status: 400 });
    assert.throws(() => tagList(5), { status: 400 });
  });

  describe('through the save route', () => {
    let app;
    let base;
    before(async () => {
      const { createApp } = await import('../src/server.js');
      const svc = {
        cache: new Map([[USER, {
          at: Date.now(),
          items: [{ _id: 1, title: 'one', link: 'https://example.com/1', tags: [], collection: { $id: 10 } }],
          collections: new Map(collections), progress: { loaded: 0, total: 0 }, loading: null,
        }]]),
        profiles: new Map(), states: new Map(), generations: new Map(), refreshing: new Map(),
        store: {
          ensureUser: async () => {},
          getTokens: async () => ({ access_enc: '', refresh_enc: '', expires_at: Date.now() + 60000 }),
          lastChecked: async () => null,
        },
      };
      app = createApp(svc);
      await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.address().port}`;
    });
    after(() => app.close());

    test('saving with tags as a string is a 400 and writes nothing', async () => {
      const res = await fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'x-admintools-email': USER, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ id: 1, folderId: 10, tags: 'work' }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'Tags must be a list of text.');
    });
  });
});

describe('model reply', () => {
  test('an entry that is not an object is skipped, and the rest is kept', () => {
    const reply = '[null, {"id": 7, "folder": {"action": "existing", "name": "AI"}, "tags": {"existing": [], "new": ["ml"]}, "status": "ready", "reason": "r"}]';
    const map = parseRepliesV2(reply, [7], ['AI'], []);
    assert.deepEqual([...map.keys()], [7]);
    assert.equal(map.get(7).folder.name, 'AI');
  });

  test('a reply that is not a JSON array is a reply error, so the caller retries', () => {
    assert.throws(() => parseRepliesV2('sorry, no', [7], ['AI'], []), ReplyError);
  });
});

describe('token key', () => {
  test('a key file with the wrong length is refused at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-test-'));
    const path = join(dir, '.key');
    writeFileSync(path, Buffer.from('too short').toString('base64'));
    assert.throws(() => loadOrCreateKey(path), /32-byte key/);
  });
});

describe('static files', () => {
  test('a missing static file is a 404, not a server error', async () => {
    const { createApp } = await import('../src/server.js');
    const app = createApp({});
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/static/missing.css`);
      assert.equal(res.status, 404);
    } finally {
      app.close();
    }
  });
});

// Bulk writes that replace tags read the bookmark from Raindrop first.
function service(items) {
  const svc = {
    cache: new Map([[USER, {
      at: Date.now(), items, collections: new Map(collections), progress: { loaded: 0, total: 0 }, loading: null,
    }]]),
    log: [],
    store: {
      profile: async () => [],
      removeNew: async () => {},
      addLog: async (u, entry) => svc.log.push(entry),
      keptDuplicates: () => [], newItems: () => new Set(),
      visits: () => new Map(),
    },
  };
  return svc;
}

function recordingRaindrop(live = {}) {
  const reads = [];
  const writes = [];
  const call = async (svc, user, method, path, body) => {
    if (method === 'GET') {
      const id = Number(path.split('/').pop());
      reads.push(id);
      if (live[id]) return { item: live[id] };
      const cached = svc.cache.get(user).items.find((i) => i._id === id);
      return { item: cached ? { ...cached } : undefined };
    }
    writes.push({ method, path, body });
    return {};
  };
  return { reads, writes, call };
}

async function finished(svc, job) {
  for (let i = 0; i < 500; i++) {
    const current = getJob(svc, USER, job.id);
    if (current.status !== 'running') return current;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not finish');
}

const item = (id, folder, tags) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, tags,
  collection: { $id: folder }, created: new Date().toISOString(), excerpt: '', note: '',
});

describe('bulk writes read the live bookmark first', () => {
  test('apply reads each bookmark before its write', async () => {
    const svc = service([item(1, 10, ['ml'])]);
    const raindrop = recordingRaindrop();
    const done = await finished(svc, await startJob(svc, USER, {
      action: 'apply', changes: [{ id: 1, folderId: 20, tags: ['ml', 'x'] }],
    }, raindrop.call));
    assert.equal(done.status, 'done');
    assert.deepEqual(raindrop.reads, [1]);
    assert.deepEqual(raindrop.writes.map((w) => w.path), ['/raindrop/1']);
  });

  test('apply does not overwrite a bookmark that Raindrop changed after the list was loaded', async () => {
    const svc = service([item(1, 10, ['ml'])]);
    // Someone added a tag in Raindrop after the cache was loaded.
    const raindrop = recordingRaindrop({ 1: { _id: 1, collection: { $id: 10 }, tags: ['ml', 'added-in-raindrop'] } });
    const done = await finished(svc, await startJob(svc, USER, {
      action: 'apply', changes: [{ id: 1, folderId: 20, tags: ['ml', 'x'] }],
    }, raindrop.call));
    assert.equal(done.status, 'done');
    assert.deepEqual(raindrop.writes, []);
    assert.deepEqual(done.failed.map((f) => [f.id, f.reason]), [[1, 'Changed in Raindrop after the list was loaded. Not updated.']]);
    assert.deepEqual(svc.cache.get(USER).items[0].tags, ['ml', 'added-in-raindrop']);
  });

  test('remove tags works on the live tags, so a tag added in Raindrop is kept', async () => {
    const svc = service([item(1, 10, ['a'])]);
    const raindrop = recordingRaindrop({ 1: { _id: 1, collection: { $id: 10 }, tags: ['a', 'keep-me'] } });
    const done = await finished(svc, await startJob(svc, USER, { action: 'removeTags', ids: [1], tags: ['a'] }, raindrop.call));
    assert.equal(done.status, 'done');
    assert.deepEqual(raindrop.reads, [1]);
    assert.deepEqual(raindrop.writes.map((w) => w.body), [{ tags: ['keep-me'] }]);
  });
});

describe('apply is checked against the reviewed state', () => {
  // A review of bookmark 1 (tags ml), made while the cache held ml.
  async function reviewed(svc) {
    const ask = async () => new Map([[1, {
      status: 'ready', reason: 'machine learning', folder: { action: 'existing', name: 'Business' },
      existingTags: [], newTags: [],
    }]]);
    const review = await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1] }, undefined, ask));
    assert.equal(review.status, 'done');
    return review;
  }

  test('an external tag added while the review is open is a conflict, even after the cache refreshed', async () => {
    const svc = service([item(1, 10, ['ml'])]);
    const review = await reviewed(svc);
    // Raindrop gets an external tag; the cache is refreshed and now holds it too.
    const raindrop = recordingRaindrop({ 1: { _id: 1, collection: { $id: 10 }, tags: ['ml', 'external'] } });
    svc.cache.get(USER).items[0].tags = ['ml', 'external'];
    const done = await finished(svc, await startJob(svc, USER, {
      action: 'apply', from: review.id, changes: [{ id: 1, folderId: 20, tags: ['ml', 'x'] }],
    }, raindrop.call));
    assert.deepEqual(raindrop.writes, []);
    assert.deepEqual(done.failed.map((f) => f.reason), ['Changed in Raindrop after the list was loaded. Not updated.']);
  });

  test('a review that was not made by this user is not used', async () => {
    const svc = service([item(1, 10, ['ml'])]);
    const review = await reviewed(svc);
    svc.cache.set('someone-else', { at: Date.now(), items: [item(9, 10, [])], collections: new Map(collections), progress: {}, loading: null });
    await assert.rejects(startJob(svc, 'someone-else', {
      action: 'apply', from: review.id, changes: [{ id: 1, folderId: 20, tags: ['ml'] }],
    }, fakeRaindrop().call), /no longer available/);
  });

  test('a bookmark that was not in the review is refused', async () => {
    const svc = service([item(1, 10, ['ml']), item(2, 10, ['ml'])]);
    const review = await reviewed(svc);
    const raindrop = recordingRaindrop();
    const done = await finished(svc, await startJob(svc, USER, {
      action: 'apply', from: review.id, changes: [{ id: 2, folderId: 20, tags: ['ml'] }],
    }, raindrop.call));
    assert.deepEqual(raindrop.writes, []);
    assert.deepEqual(done.failed.map((f) => [f.id, f.reason]), [[2, 'This bookmark was not in the review.']]);
  });
});

function fakeRaindrop() {
  return recordingRaindrop();
}
