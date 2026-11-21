// The model endpoint is shared by all users.
// One user's queued model calls must not hold up another user's call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';
import { cancelJob, getJob, startJob } from '../src/bulk.js';
import { takeTurn } from '../src/util.js';

test('takeTurn: callers take turns, and every call stays minMs apart', async () => {
  const order = [];
  const times = [];
  const calls = [];
  for (let i = 1; i <= 4; i++) calls.push(takeTurn('t1', 'a', 20).then(() => { order.push(`a${i}`); times.push(Date.now()); }));
  calls.push(takeTurn('t1', 'b', 20).then(() => { order.push('b1'); times.push(Date.now()); }));
  await Promise.all(calls);
  assert.deepEqual(order, ['a1', 'b1', 'a2', 'a3', 'a4']);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 15, `gap ${times[i] - times[i - 1]} ms`);
});

test('takeTurn: a call after a quiet period still waits for minMs since the last call', async () => {
  await takeTurn('t2', 'a', 40);
  const start = Date.now();
  await takeTurn('t2', 'b', 40);
  assert.ok(Date.now() - start >= 35);
});

test('chat: a second user is not queued behind all calls of the first user', async () => {
  const saved = { ...config.llm };
  const realFetch = globalThis.fetch;
  const sent = [];
  config.llm.endpoint = 'http://llm.invalid';
  config.llm.token = 'dummy';
  config.llm.minIntervalMs = 10;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
  };
  try {
    const ask = (who, text) => chat([{ role: 'user', content: text }], { who });
    const calls = ['a1', 'a2', 'a3', 'a4'].map((t) => ask('a@example.test', t));
    calls.push(ask('b@example.test', 'b1'));
    await Promise.all(calls);
    assert.deepEqual(sent, ['a1', 'b1', 'a2', 'a3', 'a4']);
  } finally {
    Object.assign(config.llm, saved);
    globalThis.fetch = realFetch;
  }
});

// A service with fresh caches for two users, so no Raindrop call is made to load bookmarks.
function fakeService(users) {
  const svc = { cache: new Map(), store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map(), profile: async () => [] } };
  const day = new Date().toISOString();
  for (const user of users) {
    svc.cache.set(user, {
      at: Date.now(),
      items: [1, 2].map((id) => ({ _id: id, title: `b${id}`, link: `https://example.com/${id}`, tags: [], collection: { $id: -1 }, created: day })),
      collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    });
  }
  return svc;
}

async function finished(svc, user, job) {
  for (let i = 0; i < 500; i++) {
    if (getJob(svc, user, job.id).status !== 'running') return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not finish');
}

test('suggest: one running suggest job for each user; the model call is made for that user', async () => {
  const svc = fakeService(['a', 'b']);
  const asked = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = async (batch, folders, vocab, opts) => {
    asked.push(opts.who);
    await gate;
    return new Map();
  };
  const call = async () => ({});
  const first = await startJob(svc, 'a', { action: 'suggest', ids: [1, 2] }, call, ask);

  await assert.rejects(startJob(svc, 'a', { action: 'suggest', ids: [1] }, call, ask), (err) => err.status === 409);
  // Another user, and other actions of the same user, are not blocked.
  const other = await startJob(svc, 'b', { action: 'suggest', ids: [1] }, call, ask);
  const move = await startJob(svc, 'a', { action: 'move', ids: [1], folderId: 10 }, call, ask);

  // A cancelled job no longer counts.
  cancelJob(svc, 'a', first.id);
  const second = await startJob(svc, 'a', { action: 'suggest', ids: [2] }, call, ask);

  release();
  for (const [user, job] of [['a', first], ['b', other], ['a', move], ['a', second]]) await finished(svc, user, job);
  assert.deepEqual([...new Set(asked)].sort(), ['a', 'b']);
});
