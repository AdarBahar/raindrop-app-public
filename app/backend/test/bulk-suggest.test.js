import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJob, jobView, startJob } from '../src/bulk.js';

const USER = 'u';
const collections = [[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']];

// A service with a fresh cache, so no Raindrop call is made to load bookmarks.
function fakeService(items) {
  const svc = {
    cache: new Map(),
    log: [],
    store: {
      removeNew: async () => {},
      profile: async () => svc.profile ?? [],
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

// A fake Raindrop call. Creating a folder returns the next ID, starting at 500.
function fakeCall({ failCreate = false, live = {} } = {}) {
  const calls = []; // writes only
  const reads = []; // GET of one bookmark, by id
  let nextId = 500;
  const call = async (svc, user, method, path, body) => {
    if (method === 'GET') {
      const id = Number(path.split('/').pop());
      reads.push(id);
      if (live[id]) return { item: live[id] };
      const cached = svc.cache.get(user).items.find((i) => i._id === id);
      return { item: cached ? { ...cached } : undefined };
    }
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/collection') {
      if (failCreate) throw new Error('Raindrop refused the folder.');
      const id = nextId++;
      return { item: { _id: id, title: body.title } };
    }
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
const item = (id, folder, tags) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, domain: 'example.com', tags,
  collection: { $id: folder }, created: day, excerpt: '', note: '',
});

// A reply entry, already read by the parser.
const entry = (folder, extra = {}) => ({
  status: 'ready',
  folder,
  existingTags: [],
  newTags: [],
  reason: 'A reason.',
  ...extra,
});

test('suggest: rows keep the folder decision, the tags and the reason; Raindrop is not called', async () => {
  const svc = fakeService([item(1, -1, ['x']), item(2, 10, [])]);
  const { calls, call } = fakeCall();
  const ask = async () => new Map([
    [1, entry({ action: 'existing', name: 'Business' }, { existingTags: ['money'], newTags: ['fintech'] })],
    [2, entry({ action: 'propose', name: 'Developer Tools' }, { existingTags: ['ml'] })],
  ]);
  const view = jobView(await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1, 2] }, call, ask)));
  assert.equal(view.status, 'done');
  assert.deepEqual(calls, []);
  const [a, b] = view.suggestions;
  assert.equal(a.status, 'ready');
  assert.deepEqual(a.folder, { action: 'existing', name: 'Business', folderId: 20 });
  assert.deepEqual(a.tags, ['x', 'money']);
  assert.deepEqual(a.new_tags, ['fintech']);
  assert.equal(a.current_folder, 'Unsorted');
  assert.deepEqual(b.folder, { action: 'propose', name: 'Developer Tools', folderId: null });
  assert.equal(view.undoable, false);
});

test('suggest: the suggested tags keep the bookmark at 20 tags or fewer, the known tags first', async () => {
  const current = Array.from({ length: 18 }, (_, k) => `t${k}`);
  const svc = fakeService([item(1, 10, current), item(2, 10, [...current, 't18', 't19'])]);
  const { call } = fakeCall();
  const ask = async () => new Map([
    [1, entry({ action: 'existing', name: 'AI' }, { existingTags: ['T0', 'ml'], newTags: ['n1', 'n2'] })],
    [2, entry({ action: 'existing', name: 'AI' }, { existingTags: ['ml'], newTags: ['n1'] })],
  ]);
  const view = jobView(await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1, 2] }, call, ask)));
  const [a, b] = view.suggestions;
  // "T0" is already on the bookmark. "ml" and "n1" fill the two free places.
  assert.deepEqual(a.tags, [...current, 'ml']);
  assert.deepEqual(a.new_tags, ['n1']);
  assert.equal(a.tags.length + a.new_tags.length, 20);
  assert.equal(b.tags.length, 20);
  assert.deepEqual(b.new_tags, []);
  // The card says why the suggested tags are not there.
  assert.match(b.reason, /2 suggested tags were left out: a bookmark can have at most 20 tags\./);
  assert.equal(b.status, 'ready');
});

test('suggest: a bookmark whose current tags break a limit needs review, so "Apply all" does not take it', async () => {
  const many = Array.from({ length: 21 }, (_, k) => `t${k}`);
  const svc = fakeService([item(1, 10, many), item(2, 10, ['y'.repeat(51)])]);
  const { call } = fakeCall();
  const ask = async () => new Map([
    [1, entry({ action: 'existing', name: 'AI' })],
    [2, entry({ action: 'existing', name: 'AI' })],
  ]);
  const view = jobView(await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1, 2] }, call, ask)));
  const [a, b] = view.suggestions;
  assert.equal(a.status, 'needs_review');
  assert.match(a.reason, /^A bookmark can have at most 20 tags\. Edit the tags, then apply\. A reason\.$/);
  assert.equal(b.status, 'needs_review');
  assert.match(b.reason, /^A tag can have at most 50 characters\./);
});

test('suggest: a bookmark with no answer, or a folder decision "none", needs review and is not moved to Misc', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, [])]);
  const { call } = fakeCall();
  const ask = async () => new Map([[2, entry({ action: 'none', name: null }, { status: 'ready' })]]);
  const view = jobView(await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1, 2] }, call, ask)));
  assert.equal(view.failed.length, 0);
  const [missing, none] = view.suggestions;
  assert.equal(missing.status, 'needs_review');
  assert.equal(missing.folder.action, 'none');
  assert.equal(none.status, 'needs_review');
  assert.equal(none.folder.name, null);
});

test('suggest: a failed model request marks its bookmarks as failed', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, [])]);
  const { call } = fakeCall();
  const ask = async () => { throw new Error('the model is down'); };
  const view = jobView(await finished(svc, await startJob(svc, USER, { action: 'suggest', ids: [1, 2] }, call, ask)));
  assert.equal(view.status, 'done');
  assert.deepEqual(view.suggestions, []);
  assert.deepEqual(view.failed.map((f) => f.reason), ['the model is down', 'the model is down']);
});

test('apply: each bookmark gets one single update with its own folder and tags', async () => {
  const svc = fakeService([item(1, -1, ['x']), item(2, 10, ['ml'])]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, folderId: 20, tags: ['x', 'money'] },
      { id: 2, folderId: 10, tags: ['ml', 'extra'] },
    ],
  }, call));
  assert.equal(done.status, 'done');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['PUT', '/raindrop/1', { collection: { $id: 20 }, tags: ['x', 'money'] }],
    ['PUT', '/raindrop/2', { tags: ['ml', 'extra'] }],
  ]);
  assert.equal(done.done, 2);
  assert.equal(svc.log.length, 2);
  assert.equal(jobView(done).unchanged, 0);
  assert.equal(jobView(done).undoable, true);
});

test('apply: a bookmark that already has the target folder and tags is not sent', async () => {
  const svc = fakeService([item(1, 10, ['ml'])]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [{ id: 1, folderId: 10, tags: ['ml'] }],
  }, call));
  assert.equal(done.status, 'done');
  assert.deepEqual(calls, []);
  assert.equal(done.done, 1);
  // The browser sees that this bookmark did not change.
  assert.equal(jobView(done).unchanged, 1);
});

test('apply: an image or video link gets its Raindrop type in the same single update', async () => {
  const photo = { ...item(1, -1, ['x']), link: 'https://x.com/ExodusPgame/status/1942217547396391079/photo/1' };
  const clip = { ...item(2, -1, ['y']), link: 'https://www.youtube.com/watch?v=XPM1o9QKw1Q' };
  const svc = fakeService([photo, clip]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, folderId: 10, tags: ['x'] },
      { id: 2, folderId: 10, tags: ['y'] },
    ],
  }, call));
  assert.equal(done.status, 'done');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['PUT', '/raindrop/1', { collection: { $id: 10 }, type: 'image' }],
    ['PUT', '/raindrop/2', { collection: { $id: 10 }, type: 'video' }],
  ]);
});

test('apply: a bookmark that already has the type from its link is not sent again for the type', async () => {
  const photo = { ...item(1, 10, ['x']), link: 'https://x.com/ExodusPgame/status/1942217547396391079/photo/1', type: 'image' };
  const svc = fakeService([photo]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [{ id: 1, folderId: 10, tags: ['x'] }],
  }, call));
  assert.equal(done.status, 'done');
  assert.deepEqual(calls, []);
  assert.equal(jobView(done).unchanged, 1);
});

test('apply: a row with an unknown folder or a bad tag is refused alone; the other rows go on', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, []), item(3, -1, [])]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, folderId: 999, tags: [] },
      { id: 2, folderId: 20, tags: ['a,b'] },
      { id: 3, folderId: 20, tags: ['ok'] },
    ],
  }, call));
  assert.deepEqual(done.failed.map((f) => [f.id, f.reason]), [
    [1, 'Choose a folder that exists.'],
    [2, 'Tags cannot contain commas.'],
  ]);
  assert.deepEqual(calls.map((c) => c.path), ['/raindrop/3']);
  assert.equal(done.done, 3);
});

test('apply: a new folder is created once for every row that proposes it, ignoring case', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, []), item(3, -1, [])]);
  const { calls, call } = fakeCall();
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, newFolder: 'Developer Tools', tags: ['dev'] },
      { id: 2, newFolder: 'developer tools', tags: ['dev'] },
      { id: 3, folderId: 20, tags: [] },
    ],
  }, call));
  assert.equal(done.status, 'done');
  const creates = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(creates.map((c) => c.body), [{ title: 'Developer Tools' }]);
  const moves = calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body.collection]);
  assert.deepEqual(moves, [
    ['/raindrop/1', { $id: 500 }],
    ['/raindrop/2', { $id: 500 }],
    ['/raindrop/3', { $id: 20 }],
  ]);
});

test('apply: a proposed folder that matches an existing folder, ignoring case, is not created', async () => {
  const svc = fakeService([item(1, -1, [])]);
  const { calls, call } = fakeCall();
  await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [{ id: 1, newFolder: 'business', tags: [] }],
  }, call));
  assert.deepEqual(calls.filter((c) => c.method === 'POST'), []);
  assert.deepEqual(calls.map((c) => [c.path, c.body.collection]), [['/raindrop/1', { $id: 20 }]]);
});

test('apply: when a folder cannot be created, its rows fail and are not moved; other rows go on', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, [])]);
  const { calls, call } = fakeCall({ failCreate: true });
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, newFolder: 'Developer Tools', tags: [] },
      { id: 2, folderId: 20, tags: [] },
    ],
  }, call));
  assert.equal(done.failed.length, 1);
  assert.match(done.failed[0].reason, /could not be created/);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').map((c) => c.path), ['/raindrop/2']);
});

test('a cancel during folder creation stops the next folder, and its rows are not moved', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, [])]);
  const { calls, call } = fakeCall();
  // The first folder request cancels the job, as a user cancel during the request would.
  const cancelling = async (...args) => {
    if (args[3] === '/collection' && args[4].title === 'A') [...svc.jobs.values()][0].cancelled = true;
    return call(...args);
  };
  const job = await startJob(svc, USER, {
    action: 'apply',
    changes: [
      { id: 1, newFolder: 'A', tags: [] },
      { id: 2, newFolder: 'B', tags: [] },
    ],
  }, cancelling);
  await finished(svc, job);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.title), ['A']);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT'), []);
});

test('two apply jobs that propose the same new folder create it once', async () => {
  const svc = fakeService([item(1, -1, []), item(2, -1, [])]);
  const { calls, call } = fakeCall();
  const first = await startJob(svc, USER, { action: 'apply', changes: [{ id: 1, newFolder: 'Tools', tags: [] }] }, call);
  const second = await startJob(svc, USER, { action: 'apply', changes: [{ id: 2, newFolder: 'tools', tags: [] }] }, call);
  await finished(svc, first);
  await finished(svc, second);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

// Review round 1 of PR #145: the type follows the live link, not an old cached link.
test('apply: the type comes from the live link, so a stale cached link does not set it', async () => {
  const cached = { ...item(1, -1, ['x']), link: 'https://www.youtube.com/watch?v=1', type: 'link' };
  const live = { ...item(1, -1, ['x']), link: 'https://example.com/article', type: 'link' };
  const svc = fakeService([cached]);
  const { calls, call } = fakeCall({ live: { 1: live } });
  const done = await finished(svc, await startJob(svc, USER, {
    action: 'apply',
    changes: [{ id: 1, folderId: 20, tags: ['x'] }],
  }, call));
  assert.equal(done.status, 'done');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [
    ['PUT', '/raindrop/1', { collection: { $id: 20 } }],
  ]);
});
