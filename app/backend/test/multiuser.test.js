// Two users, one app, one fake Raindrop. Each user must see only their own data.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSchema, dropTestSchema, SKIP_REASON, TEST_URL } from './helpers/db.js';

const now = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Fake Raindrop data. Access tokens look like tok-<user>, so the fake can tell the users apart.
function freshData() {
  return {
    alice: {
      collections: [{ _id: 10, title: 'Alice Folder', count: 2 }, { _id: 11, title: 'Alice Folder', count: 0 }],
      items: [
        { _id: 101, title: 'Alice bookmark one', link: 'https://alice.example/1', domain: 'alice.example', tags: ['a'], collection: { $id: 10 }, created: new Date(now - HOUR).toISOString(), excerpt: '', note: '' },
        { _id: 102, title: 'Alice bookmark two', link: 'https://alice.example/2', domain: 'alice.example', tags: [], collection: { $id: 10 }, created: new Date(now - 2 * DAY).toISOString(), excerpt: '', note: '' },
      ],
    },
    bob: {
      collections: [{ _id: 20, title: 'Bob Folder', count: 1 }],
      items: [
        { _id: 201, title: 'Bob bookmark', link: 'https://bob.example/1', domain: 'bob.example', tags: ['b'], collection: { $id: 20 }, created: new Date(now - HOUR).toISOString(), excerpt: '', note: '' },
      ],
    },
  };
}

// Admintools sends the signed-in email. The test maps each short name to one email.
const EMAIL = (name) => `${name}@example.test`;

const CODES = { 'code-alice': 'alice', 'code-bob': 'bob', 'code-slow': 'alice' };
const REFRESH = { 'ref-alice': 'alice', 'ref-bob': 'bob' };
const userOf = (token) => (token?.startsWith('tok-alice') ? 'alice' : token?.startsWith('tok-bob') ? 'bob' : null);

function fakeRaindrop(data) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;

    if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
      const body = JSON.parse(raw);
      if (body.client_id !== 'test-client' || body.client_secret !== 'test-secret') return send(401, { error: 'bad client' });
      if (body.grant_type === 'authorization_code') {
        const user = CODES[body.code];
        if (!user) return send(400, { error: 'bad_authorization_code' });
        // The slow code keeps the exchange open, so a test can disconnect in the middle.
        if (body.code === 'code-slow') await new Promise((resolve) => setTimeout(resolve, 300));
        return send(200, { access_token: `tok-${user}`, refresh_token: `ref-${user}`, expires_in: 1209599, token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token') {
        const user = REFRESH[body.refresh_token];
        if (!user) return send(400, { error: 'invalid_grant' });
        // No new refresh token here, so the app must keep the old one.
        return send(200, { access_token: `tok-${user}-2`, expires_in: 1209599, token_type: 'Bearer' });
      }
      return send(400, { error: 'unsupported grant' });
    }

    const user = userOf((req.headers.authorization ?? '').replace('Bearer ', ''));
    if (!user) return send(401, { error: 'unauthorized' });
    const mine = data[user];

    if (req.method === 'GET' && url.pathname === '/rest/v1/user') {
      return send(200, { result: true, user: { _id: 1, email: `${user}@fake.example`, fullName: `${user} Tester` } });
    }
    if (req.method === 'GET' && url.pathname === '/rest/v1/collections') return send(200, { result: true, items: mine.collections });
    if (req.method === 'GET' && url.pathname === '/rest/v1/collections/childrens') return send(200, { result: true, items: [] });
    if (req.method === 'GET' && url.pathname === '/rest/v1/user/stats') {
      return send(200, { result: true, items: [{ _id: 0, count: mine.items.length }, { _id: -1, count: 0 }, { _id: -99, count: 0 }] });
    }
    if (req.method === 'GET' && url.pathname === '/rest/v1/raindrops/0') {
      const page = Number(url.searchParams.get('page') ?? 0);
      return send(200, { result: true, items: page === 0 ? mine.items : [] });
    }
    if (req.method === 'POST' && url.pathname === '/rest/v1/collection') {
      const body = JSON.parse(raw);
      const id = 900 + mine.collections.length;
      mine.collections.push({ _id: id, title: body.title, count: 0 });
      return send(200, { result: true, item: { _id: id, title: body.title } });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/rest/v1/raindrop/')) {
      const id = Number(url.pathname.split('/').pop());
      const body = JSON.parse(raw);
      const item = mine.items.find((i) => i._id === id);
      if (!item) return send(404, { result: false });
      item.collection = body.collection;
      item.tags = body.tags;
      return send(200, { result: true, item });
    }
    return send(404, { error: 'not found' });
  });
}

describe('one app, several users', { skip: SKIP_REASON }, () => {
  let fake;
  let app;
  let base;
  let store;
  let schema;
  let svc;
  let decryptFn;
  let getAccessToken;
  let disconnectFn;

  before(async () => {
    const data = freshData();
    fake = fakeRaindrop(data);
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakePort = fake.address().port;

    const dataDir = mkdtempSync(join(tmpdir(), 'rs-multi-'));
    schema = await createTestSchema();
    // Set the environment before the app modules load, because config reads it on import.
    Object.assign(process.env, {
      DATA_DIR: dataDir,
      DATA_KEY_FILE: join(dataDir, 'key'),
      RAINDROP_API_BASE: `http://127.0.0.1:${fakePort}/rest/v1`,
      RAINDROP_OAUTH_BASE: `http://127.0.0.1:${fakePort}/oauth`,
      RAINDROP_CLIENT_ID: 'test-client',
      RAINDROP_CLIENT_SECRET: 'test-secret',
      RAINDROP_ENV_FILE: join(dataDir, 'none.env'),
    });

    const { openStore } = await import('../src/store.js');
    const { loadOrCreateKey, decrypt } = await import('../src/crypto.js');
    const { createApp } = await import('../src/server.js');
    ({ getAccessToken, disconnect: disconnectFn } = await import('../src/oauth.js'));
    decryptFn = decrypt;

    store = openStore({ url: TEST_URL, schema });
    svc = {
      store,
      key: loadOrCreateKey(process.env.DATA_KEY_FILE),
      cache: new Map(),
      profiles: new Map(),
      states: new Map(),
      generations: new Map(),
      refreshing: new Map(),
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

  async function call(method, path, { user, body } = {}) {
    const headers = {};
    if (user) headers['x-admintools-email'] = EMAIL(user);
    if (body !== undefined || method === 'POST') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json };
  }

  // Run the OAuth steps for one user. The fake approves with the given code.
  async function connect(user, code) {
    const start = await call('GET', '/oauth/start', { user });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const back = await call('GET', `/oauth/callback?code=${code}&state=${state}`, { user });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/');
  }

  const titles = (res) => res.json.results.map((r) => r.title);

  test('requests without a sign-in are refused', async () => {
    assert.equal((await call('GET', '/api/meta')).status, 401);
  });

  test('a signed-in user without a Raindrop connection is told to connect', async () => {
    const me = await call('GET', '/api/me', { user: 'alice' });
    // logoutUrl, version and lastChecked are checked in their own tests. Here only the account part is compared.
    const { logoutUrl, version, lastChecked, ...account } = me.json;
    assert.deepEqual(account, { user: EMAIL('alice'), connected: false, raindrop: null });
    assert.equal(typeof version, 'string');
    assert.equal((await call('GET', '/api/meta', { user: 'alice' })).status, 409);
  });

  test('alice connects and sees only her bookmarks', async () => {
    await connect('alice', 'code-alice');
    const res = await call('GET', '/api/bookmarks?preset=all', { user: 'alice' });
    assert.deepEqual(titles(res), ['Alice bookmark one', 'Alice bookmark two']);
  });

  test('the connected Raindrop account name and email are reported', async () => {
    const me = await call('GET', '/api/me', { user: 'alice' });
    assert.equal(me.json.connected, true);
    assert.deepEqual(me.json.raindrop, { name: 'alice Tester', email: 'alice@fake.example' });
  });

  test('bob connects and sees only his bookmarks, and alice still sees hers', async () => {
    await connect('bob', 'code-bob');
    assert.deepEqual(titles(await call('GET', '/api/bookmarks', { user: 'bob' })), ['Bob bookmark']);
    assert.deepEqual(titles(await call('GET', '/api/bookmarks', { user: 'alice' })), ['Alice bookmark one', 'Alice bookmark two']);
  });

  test('tokens are stored encrypted and each user has their own row', async () => {
    const row = await store.getTokens(EMAIL('alice'));
    assert.notEqual(row.access_enc, 'tok-alice');
    assert.equal(decryptFn(row.access_enc, svc.key), 'tok-alice');
    assert.equal(decryptFn((await store.getTokens(EMAIL('bob'))).refresh_enc, svc.key), 'ref-bob');
  });

  test('visits are kept per user', async () => {
    const go = await call('GET', '/go/101', { user: 'alice' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), 'https://alice.example/1');
    assert.deepEqual(titles(await call('GET', '/api/bookmarks?visited=yes', { user: 'alice' })), ['Alice bookmark one']);
    assert.equal((await call('GET', '/api/bookmarks?visited=yes', { user: 'bob' })).json.matched, 0);
  });

  test('a new folder and a save affect only the user who made them', async () => {
    const created = await call('POST', '/api/folder', { user: 'alice', body: { name: 'Alice New' } });
    assert.equal(created.status, 200);
    const aliceMeta = await call('GET', '/api/meta', { user: 'alice' });
    const bobMeta = await call('GET', '/api/meta', { user: 'bob' });
    assert.ok(aliceMeta.json.collections.some((c) => c.name === 'Alice New'));
    assert.ok(!bobMeta.json.collections.some((c) => c.name === 'Alice New'));

    const newId = created.json.id;
    const saved = await call('POST', '/api/save', { user: 'alice', body: { id: 101, folderId: Number(newId), tags: ['saved'] } });
    assert.equal(saved.json.tags_match, true);
    assert.equal(saved.json.folderId, Number(newId));
    const bobItem = (await call('GET', '/api/bookmarks', { user: 'bob' })).json.results[0];
    assert.equal(bobItem.collection, 'Bob Folder');
    assert.deepEqual(bobItem.tags, ['b']);
  });

  test('an expired access token is refreshed and the refresh token is kept', async () => {
    await getAccessToken(svc, EMAIL('alice'), { force: true });
    assert.equal(decryptFn((await store.getTokens(EMAIL('alice'))).access_enc, svc.key), 'tok-alice-2');
    assert.equal(decryptFn((await store.getTokens(EMAIL('alice'))).refresh_enc, svc.key), 'ref-alice');
    assert.equal((await call('GET', '/api/meta', { user: 'alice' })).status, 200);
  });

  test('disconnecting bob does not affect alice', async () => {
    assert.equal((await call('POST', '/api/disconnect', { user: 'bob' })).status, 200);
    assert.equal((await call('GET', '/api/meta', { user: 'bob' })).status, 409);
    assert.equal((await call('GET', '/api/meta', { user: 'alice' })).status, 200);
  });

  test('two folders with the same name are told apart by ID', async () => {
    const meta = (await call('GET', '/api/meta', { user: 'alice' })).json;
    const labels = meta.collections.filter((c) => c.name === 'Alice Folder').map((c) => c.label).sort();
    assert.deepEqual(labels, ['Alice Folder (#10)', 'Alice Folder (#11)']);
    // Moving bookmark 101 into folder 11 must not touch folder 10.
    const saved = await call('POST', '/api/save', { user: 'alice', body: { id: 101, folderId: 11, tags: ['a'] } });
    assert.equal(saved.json.folderId, 11);
    const item = (await call('GET', '/api/bookmarks?q=bookmark%20one', { user: 'alice' })).json.results[0];
    assert.equal(item.collection_id, 11);
  });

  test('a save with an unknown folder ID is refused', async () => {
    const res = await call('POST', '/api/save', { user: 'alice', body: { id: 101, folderId: 999999, tags: [] } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Unknown folder/);
  });

  test('an approval started by one session cannot finish in another', async () => {
    const start = await call('GET', '/oauth/start', { user: 'alice' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const other = await call('GET', `/oauth/callback?code=code-bob&state=${state}`, { user: 'bob' });
    assert.equal(other.status, 403);
    assert.equal(await store.getTokens(EMAIL('bob')), null, 'the refused approval must not connect bob');
    assert.notEqual(await store.getTokens(EMAIL('alice')), null, 'alice stays connected');
  });

  test('a refresh that finishes after a disconnect does not restore the connection', async () => {
    const pending = getAccessToken(svc, EMAIL('alice'), { force: true });
    disconnectFn(svc, EMAIL('alice'));
    await assert.rejects(pending, /changed|connect/i);
    assert.equal(await store.getTokens(EMAIL('alice')), null);
    assert.equal((await call('GET', '/api/meta', { user: 'alice' })).status, 409);
  });

  test('a disconnect during the code exchange cancels the approval', async () => {
    await connect('alice', 'code-alice');
    const start = await call('GET', '/oauth/start', { user: 'alice' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = call('GET', `/oauth/callback?code=code-slow&state=${state}`, { user: 'alice' });
    assert.equal((await call('POST', '/api/disconnect', { user: 'alice' })).status, 200);
    const late = await callback;
    assert.equal(late.status, 409);
    assert.equal(await store.getTokens(EMAIL('alice')), null, 'the late approval must not reconnect alice');
  });

  test('an unknown OAuth state is refused', async () => {
    assert.equal((await call('GET', '/oauth/callback?code=x&state=unknown', { user: 'alice' })).status, 400);
  });

  test('an expired connection is reported as not connected', async () => {
    const { encrypt } = await import('../src/crypto.js');
    await connect('bob', 'code-bob');
    // The access token is old and the refresh token is one the fake Raindrop rejects.
    await store.saveTokens(EMAIL('bob'), encrypt('tok-old', svc.key), encrypt('ref-gone', svc.key), Date.now() - 1000);
    const me = await call('GET', '/api/me', { user: 'bob' });
    assert.equal(me.json.connected, false, 'the reply must not say connected after the connection was removed');
    assert.equal(me.json.raindrop, null);
    assert.equal(await store.getTokens(EMAIL('bob')), null);
  });
});
