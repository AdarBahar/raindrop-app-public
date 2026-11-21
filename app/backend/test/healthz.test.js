// The health check answers without a session and reports only up or down.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('GET /healthz', () => {
  let app;
  let base;
  let dbUp = true;

  before(async () => {
    const { createApp } = await import('../src/server.js');
    const svc = {
      store: {
        ping: async () => {
          if (!dbUp) throw new Error('connection refused');
        },
      },
    };
    app = createApp(svc);
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  });

  after(() => app.close());

  test('answers 200 without a sign-in when the database is up', async () => {
    dbUp = true;
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('answers 503 without details when the database is down', async () => {
    dbUp = false;
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
    dbUp = true;
  });

  test('a stalled database gives 503 at the deadline, not a hang', async () => {
    const { createApp } = await import('../src/server.js');
    const stalled = createApp({ store: { ping: () => new Promise(() => {}) } });
    await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now();
      const res = await fetch(`http://127.0.0.1:${stalled.address().port}/healthz`);
      assert.equal(res.status, 503);
      assert.ok(Date.now() - start < 5000, 'the check must end soon after its deadline');
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  });

  test('does not accept other methods', async () => {
    const res = await fetch(`${base}/healthz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  });
});
