// The profile of a user: validation, the store, the routes, and the tag check (docs/profile-plan.md, PR 1).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';
import { blockOf, budgetUsed, entryId, parseEntry, promptKey, setsNewTag } from '../src/profile.js';
import { config } from '../src/config.js';

const entry = (over = {}) => ({ kind: 'project', name: 'raindrop-app', description: 'A bookmark tool.', ...over });

describe('profile entry validation', () => {
  test('a project gets trimmed text, no tag, and is active', () => {
    assert.deepEqual(parseEntry(entry({ name: '  raindrop-app ', description: ' A bookmark tool. ' })), {
      id: null, kind: 'project', name: 'raindrop-app', description: 'A bookmark tool.', tag: null, active: true,
    });
  });

  test('the kind, the name and the description are checked', () => {
    assert.throws(() => parseEntry(entry({ kind: 'rule' })), /kind must be/);
    assert.throws(() => parseEntry(null), /kind must be/);
    assert.throws(() => parseEntry(entry({ name: '   ' })), /name is empty/);
    assert.throws(() => parseEntry(entry({ name: 'x'.repeat(config.limits.profileName + 1) })), /at most 60/);
    assert.throws(() => parseEntry(entry({ description: '' })), /description is empty/);
    assert.throws(() => parseEntry(entry({ description: 'x'.repeat(config.limits.profileDescription + 1) })), /at most 300/);
    assert.throws(() => parseEntry(entry({ active: 'yes' })), /true or false/);
  });

  test('the text about the user has no name and no tag, and a longer limit', () => {
    const about = parseEntry({ kind: 'about', name: 'ignored', description: 'x'.repeat(config.limits.profileAbout) });
    assert.equal(about.name, '');
    assert.throws(() => parseEntry({ kind: 'about', description: 'x'.repeat(config.limits.profileAbout + 1) }), /at most 600/);
    assert.throws(() => parseEntry({ kind: 'about', description: 'Me.', tag: 'me' }), /cannot have a tag/);
  });

  test('a tag is trimmed, and a blank or bad tag is refused', () => {
    assert.equal(parseEntry(entry({ tag: '  proj:raindrop-app ' })).tag, 'proj:raindrop-app');
    assert.equal(parseEntry(entry({ tag: null })).tag, null);
    assert.throws(() => parseEntry(entry({ tag: '   ' })), /tag is empty/);
    assert.throws(() => parseEntry(entry({ tag: '' })), /tag is empty/);
    assert.throws(() => parseEntry(entry({ tag: 'a,b' })), /commas/);
    assert.throws(() => parseEntry(entry({ tag: 'x'.repeat(config.limits.tagLength + 1) })), /at most 50/);
    assert.throws(() => parseEntry(entry({ tag: 7 })), /must be text/);
  });

  test('an entry ID is decimal text and is never a number', () => {
    assert.equal(entryId('9223372036854775807'.slice(0, 18)), '922337203685477580');
    for (const bad of [17, '17a', '0', '', ' 17', '1e3', null, undefined, '1234567890123456789']) {
      assert.throws(() => entryId(bad), /not valid/);
    }
    assert.equal(parseEntry(entry({ id: '17' })).id, '17');
    assert.throws(() => parseEntry(entry({ id: 17 })), /not valid/);
  });

  test('a new tag is a tag that the stored entry does not have, without letter case', () => {
    assert.equal(setsNewTag({ tag: 'proj:a' }, null), true);
    assert.equal(setsNewTag({ tag: 'Proj:A' }, { tag: 'proj:a' }), false);
    assert.equal(setsNewTag({ tag: 'proj:b' }, { tag: 'proj:a' }), true);
    assert.equal(setsNewTag({ tag: null }, { tag: 'proj:a' }), false);
  });
});

describe('profile block for the model', () => {
  const entries = [
    { id: '3', kind: 'about', name: '', description: 'I play drums.', tag: null, active: true },
    { id: '17', kind: 'project', name: 'raindrop-app', description: 'A bookmark tool.', tag: 'proj:raindrop-app', active: true },
    { id: '18', kind: 'interest', name: 'woodworking', description: 'Furniture.', tag: null, active: true },
    { id: '19', kind: 'project', name: 'old', description: 'Not used now.', tag: 'proj:old', active: false },
  ];

  test('only active entries are sent, with keys that are not numbers', () => {
    assert.deepEqual(blockOf(entries), {
      about: 'I play drums.',
      entries: [
        { id: 'p17', name: 'raindrop-app', description: 'A bookmark tool.', tag: 'proj:raindrop-app' },
        { id: 'p18', name: 'woodworking', description: 'Furniture.', tag: null },
      ],
    });
    assert.equal(promptKey('17'), 'p17');
  });

  test('no active entry gives no block and a budget of zero', () => {
    assert.equal(blockOf(entries.filter((e) => !e.active)), null);
    assert.equal(budgetUsed([]), 0);
  });

  test('the budget is the length of the JSON text that is sent', () => {
    assert.equal(budgetUsed(entries), JSON.stringify(blockOf(entries)).length);
  });
});

// A small fake Raindrop. Access tokens look like tok-<user>. `fail` makes every bookmark read fail.
function fakeRaindrop(state) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
      const user = JSON.parse(raw).code?.replace('code-', '');
      return send(200, { access_token: `tok-${user}`, refresh_token: `ref-${user}`, expires_in: 1209599, token_type: 'Bearer' });
    }
    const user = (req.headers.authorization ?? '').replace('Bearer tok-', '');
    if (url.pathname === '/rest/v1/user') return send(200, { result: true, user: { _id: 1, email: `${user}@fake.example`, fullName: user } });
    if (state.fail) return send(400, { error: 'down' });
    if (url.pathname === '/rest/v1/collections') return send(200, { result: true, items: [{ _id: 10, title: 'Folder', count: 1 }] });
    if (url.pathname === '/rest/v1/collections/childrens') return send(200, { result: true, items: [] });
    if (url.pathname === '/rest/v1/user/stats') return send(200, { result: true, items: [{ _id: 0, count: 1 }, { _id: -1, count: 0 }, { _id: -99, count: 0 }] });
    if (url.pathname === '/rest/v1/raindrops/0') {
      const item = { _id: 101, title: 'One', link: 'https://example.test/1', domain: 'example.test', tags: ['Claude'], collection: { $id: 10 }, created: new Date().toISOString(), excerpt: '', note: '' };
      return send(200, { result: true, items: Number(url.searchParams.get('page') ?? 0) === 0 ? [item] : [] });
    }
    return send(404, { error: 'not found' });
  });
}

describe('profile store and routes', { skip: SKIP_REASON }, () => {
  const state = { fail: false };
  let fake;
  let app;
  let base;
  let store;
  let schema;
  let svc;
  let bookmarks;

  before(async () => {
    fake = fakeRaindrop(state);
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakePort = fake.address().port;
    const dataDir = mkdtempSync(join(tmpdir(), 'rs-profile-'));
    schema = await createTestSchema();
    // config is already loaded by the import at the top, so the Raindrop addresses are set on it directly.
    config.raindrop.apiBase = `http://127.0.0.1:${fakePort}/rest/v1`;
    config.raindrop.oauthBase = `http://127.0.0.1:${fakePort}/oauth`;
    config.raindrop.clientId = 'test-client';
    config.raindrop.clientSecret = 'test-secret';
    config.raindrop.minIntervalMs = 0;
    const { openStore } = await import('../src/store.js');
    const { loadOrCreateKey } = await import('../src/crypto.js');
    const { createApp } = await import('../src/server.js');
    bookmarks = await import('../src/bookmarks.js');
    store = openStore({ url: TEST_URL, schema });
    svc = { store, key: loadOrCreateKey(join(dataDir, 'key')), cache: new Map(), profiles: new Map(), states: new Map(), generations: new Map(), refreshing: new Map() };
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

  const EMAIL = (name) => `${name}@example.test`;
  async function call(method, path, { user, body } = {}) {
    const headers = {};
    if (user) headers['x-admintools-email'] = EMAIL(user);
    if (method === 'POST') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json };
  }
  async function connect(user) {
    const start = await call('GET', '/oauth/start', { user });
    const key = new URL(start.headers.get('location')).searchParams.get('state');
    assert.equal((await call('GET', `/oauth/callback?code=code-${user}&state=${key}`, { user })).status, 302);
  }
  const save = (user, body) => call('POST', '/api/profile/entry', { user, body });

  test('the store returns the ID as text, and refuses a second text about the user', async () => {
    const saved = await store.saveEntry('store@example.test', { kind: 'about', name: '', description: 'Me.', tag: null, active: true });
    assert.equal(typeof saved.id, 'string');
    assert.match(saved.id, /^[1-9][0-9]*$/);
    assert.deepEqual({ ...saved, id: 0, updatedAt: 0 }, { id: 0, kind: 'about', name: '', description: 'Me.', tag: null, active: true, source: 'manual', sourceRef: null, updatedAt: 0 });
    await assert.rejects(store.saveEntry('store@example.test', { kind: 'about', name: '', description: 'Me again.', tag: null, active: true }), { code: '23505', constraint: 'profile_entries_one_about' });
  });

  test('the store refuses the same tag in a different letter case, and the same source item', async () => {
    const user = 'store2@example.test';
    await store.saveEntry(user, { ...entry(), tag: 'proj:Tools', active: true, source: 'github', sourceRef: '555' });
    await assert.rejects(store.saveEntry(user, { ...entry({ name: 'b' }), tag: 'PROJ:tools', active: true }), { code: '23505', constraint: 'profile_entries_tag' });
    await assert.rejects(store.saveEntry(user, { ...entry({ name: 'c' }), tag: null, active: true, source: 'github', sourceRef: '555' }), { code: '23505', constraint: 'profile_entries_source' });
    // A different user can have the same tag.
    await store.saveEntry('store3@example.test', { ...entry(), tag: 'proj:tools', active: true });
  });

  test('the profile routes need a sign-in', async () => {
    assert.equal((await call('GET', '/api/profile')).status, 401);
    assert.equal((await save(null, entry())).status, 401);
  });

  test('the write guard covers the profile routes: a cross-site POST and a POST without JSON are refused', async () => {
    const post = (path, headers, body) => fetch(base + path, { method: 'POST', headers: { 'x-admintools-email': EMAIL('mallory'), ...headers }, body });
    const body = JSON.stringify(entry());
    for (const path of ['/api/profile/entry', '/api/profile/entry/delete']) {
      assert.equal((await post(path, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body)).status, 403);
      assert.equal((await post(path, { 'content-type': 'text/plain' }, body)).status, 403);
    }
    assert.deepEqual((await call('GET', '/api/profile', { user: 'mallory' })).json.entries, []);
  });

  test('a user without a Raindrop connection can keep a profile, and a tag is not checked', async () => {
    const res = await save('alice', entry({ tag: 'claude' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.entry.tag, 'claude');
    assert.equal(typeof res.json.entry.id, 'string');
    const view = await call('GET', '/api/profile', { user: 'alice' });
    assert.equal(view.status, 200);
    assert.equal(view.json.entries.length, 1);
    assert.deepEqual(view.json.budget, { used: budgetUsed(view.json.entries), max: config.limits.profileBudget });
    assert.equal(view.json.limits.entries, config.limits.profileEntries);
  });

  test('a user cannot read, change or delete the entry of another user through its ID', async () => {
    const id = (await call('GET', '/api/profile', { user: 'alice' })).json.entries[0].id;
    assert.deepEqual((await call('GET', '/api/profile', { user: 'bob' })).json.entries, []);
    assert.equal((await save('bob', entry({ id, name: 'stolen' }))).status, 404);
    assert.equal((await call('POST', '/api/profile/entry/delete', { user: 'bob', body: { id } })).status, 404);
    assert.equal((await call('GET', '/api/profile', { user: 'alice' })).json.entries[0].name, 'raindrop-app');
  });

  test('bad input is refused before anything is saved', async () => {
    assert.equal((await save('bob', entry({ tag: '  ' }))).status, 400);
    assert.equal((await save('bob', entry({ id: 5 }))).status, 400);
    assert.equal((await call('POST', '/api/profile/entry/delete', { user: 'bob', body: { id: 5 } })).status, 400);
    assert.deepEqual((await call('GET', '/api/profile', { user: 'bob' })).json.entries, []);
  });

  test('a second entry with the same tag, and a second text about the user, get a clear message', async () => {
    const dup = await save('alice', entry({ name: 'other', tag: 'CLAUDE' }));
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /Another entry already has this tag/);
    assert.equal((await save('alice', { kind: 'about', description: 'Me.' })).status, 200);
    const again = await save('alice', { kind: 'about', description: 'Me again.' });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /already has a text about you/);
  });

  test('the budget and the number of entries are limited', async () => {
    const long = 'x'.repeat(config.limits.profileDescription);
    let status = 200;
    let made = 0;
    while (status === 200 && made < 60) {
      status = (await save('carol', entry({ name: `p${made}`, description: long }))).status;
      if (status === 200) made += 1;
    }
    // Entries of full length reach the budget before the entry limit.
    assert.equal(status, 400);
    assert.ok(made < config.limits.profileEntries);
    const view = (await call('GET', '/api/profile', { user: 'carol' })).json;
    assert.ok(view.budget.used <= view.budget.max);
    // An inactive entry is not sent, so it does not use the budget.
    assert.equal((await save('carol', entry({ name: 'idle', description: long, active: false }))).status, 200);
    // Short inactive entries reach the entry limit.
    let last = 200;
    for (let i = made + 1; i <= config.limits.profileEntries && last === 200; i++) {
      last = (await save('carol', entry({ name: `q${i}`, description: 'x', active: false }))).status;
    }
    assert.equal(last, 400);
    assert.equal((await call('GET', '/api/profile', { user: 'carol' })).json.entries.length, config.limits.profileEntries);
  });

  test('with a connection, a tag that is a Raindrop tag needs a confirmation', async () => {
    await connect('dave');
    const res = await save('dave', entry({ tag: 'claude' }));
    assert.equal(res.status, 409);
    assert.equal(res.json.tagExists, true);
    assert.deepEqual((await call('GET', '/api/profile', { user: 'dave' })).json.entries, []);
    const free = await save('dave', entry({ tag: 'proj:raindrop-app' }));
    assert.equal(free.status, 200);
    const reuse = await save('dave', { ...entry({ name: 'claude tools', tag: 'claude' }), reuseTag: true });
    assert.equal(reuse.status, 200);
    // An unchanged tag is not checked again, also in a different letter case.
    assert.equal((await save('dave', entry({ id: reuse.json.entry.id, name: 'claude tools 2', tag: 'Claude' }))).status, 200);
  });

  test('when the Raindrop tags cannot be read, a new tag is refused and other saves work', async () => {
    await connect('erin');
    state.fail = true;
    try {
      const res = await save('erin', entry({ tag: 'proj:x' }));
      assert.equal(res.status, 503);
      assert.match(res.json.error, /cannot be checked now/);
      assert.equal((await save('erin', entry())).status, 200);
    } finally {
      state.fail = false;
    }
    assert.equal((await call('GET', '/api/profile', { user: 'erin' })).json.entries.length, 1);
  });

  test('with the stored copy and no complete sync, a new tag is refused and never passes silently', async () => {
    await connect('frank');
    const real = config.bookmarkStore;
    config.bookmarkStore = true;
    state.fail = true;
    try {
      assert.equal((await save('frank', entry({ tag: 'claude' }))).status, 503);
    } finally {
      state.fail = false;
      config.bookmarkStore = real;
    }
    assert.deepEqual((await call('GET', '/api/profile', { user: 'frank' })).json.entries, []);
  });

  test('a disconnect keeps the profile, and delete-my-data removes it', async () => {
    assert.equal((await call('POST', '/api/disconnect', { user: 'dave' })).status, 200);
    assert.equal((await call('GET', '/api/profile', { user: 'dave' })).json.entries.length, 2);
    assert.equal((await call('POST', '/api/delete-data', { user: 'dave' })).status, 200);
    assert.deepEqual((await call('GET', '/api/profile', { user: 'dave' })).json.entries, []);
    // The entries of the other users stay.
    assert.equal((await call('GET', '/api/profile', { user: 'alice' })).json.entries.length, 2);
    bookmarks.forget(svc, EMAIL('dave'));
  });

  test('an entry can be deleted by its owner', async () => {
    const id = (await call('GET', '/api/profile', { user: 'erin' })).json.entries[0].id;
    assert.equal((await call('POST', '/api/profile/entry/delete', { user: 'erin', body: { id } })).status, 200);
    assert.equal((await call('POST', '/api/profile/entry/delete', { user: 'erin', body: { id } })).status, 404);
  });
});
