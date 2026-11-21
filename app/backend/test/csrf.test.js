// Writes from another site, or without JSON, are refused before any work starts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('writes from another site', () => {
  let app;
  let base;

  before(async () => {
    const { createApp } = await import('../src/server.js');
    app = createApp({});
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(() => app.close());

  const signedIn = { 'x-admintools-email': 'user@example.com' };

  test('a cross-site POST is refused', async () => {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { ...signedIn, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });

  test('a POST without JSON is refused, even from this site', async () => {
    const res = await fetch(`${base}/api/disconnect`, {
      method: 'POST',
      headers: { ...signedIn, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
      body: 'name=x',
    });
    assert.equal(res.status, 403);
  });

  test('a same-site JSON POST is not refused by this check', async () => {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { ...signedIn, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(res.status, 403);
  });
});
