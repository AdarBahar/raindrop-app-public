// No other site may show the app in a frame (#73).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('framing policy', () => {
  let app;
  let base;

  before(async () => {
    const { createApp } = await import('../src/server.js');
    app = createApp({ states: new Map() });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(() => app.close());

  function assertNoFraming(res) {
    assert.match(res.headers.get('content-security-policy'), /(^|; )frame-ancestors 'none'(;|$)/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  }

  test('the page refuses a frame, also when a frame on another site asks for it', async () => {
    const res = await fetch(`${base}/`, { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 200);
    assertNoFraming(res);
  });

  test('static files refuse a frame', async () => {
    const res = await fetch(`${base}/static/app.js`);
    assert.equal(res.status, 200);
    assertNoFraming(res);
  });

  test('JSON answers and refusals refuse a frame', async () => {
    assertNoFraming(await fetch(`${base}/api/me`));
    const refused = await fetch(`${base}/api/disconnect`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(refused.status, 403);
    assertNoFraming(refused);
  });

  test('redirects refuse a frame', async () => {
    const res = await fetch(`${base}/oauth/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assertNoFraming(res);
  });

  test('an error answer refuses a frame', async () => {
    // The fake service has no generations map, so the start fails inside the route.
    const res = await fetch(`${base}/oauth/start`, {
      headers: { 'x-admintools-email': 'user@example.com' },
      redirect: 'manual',
    });
    assert.equal(res.status, 500);
    assertNoFraming(res);
  });
});
