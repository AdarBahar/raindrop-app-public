import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));

// Load the config module in a child process, so the environment variable is read fresh.
function logoutUrlWith(value) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { config } from './src/config.js'; process.stdout.write(JSON.stringify(config.adminLogoutUrl));"], {
    cwd: BACKEND,
    env: { ...process.env, ADMINTOOLS_LOGOUT_URL: value, RAINDROP_ENV_FILE: '/nonexistent' },
  });
  return JSON.parse(out.toString());
}

test('the logout address must be an https address; anything else is ignored', () => {
  assert.equal(logoutUrlWith('https://auth.example.com/logout'), 'https://auth.example.com/logout');
  assert.equal(logoutUrlWith('javascript:alert(1)'), '');
  assert.equal(logoutUrlWith('http://auth.example.com/logout'), '');
  assert.equal(logoutUrlWith(''), '');
});

test('/api/me returns logoutUrl and version, for a signed-out and a signed-in user', async () => {
  const svc = {
    cache: new Map(),
    store: {
      ensureUser: async () => {},
      getTokens: async () => null,
      lastChecked: async () => null,
    },
    key: Buffer.alloc(32),
    profiles: new Map(),
    generations: new Map(),
    states: new Map(),
    refreshing: new Map(),
  };
  const server = createApp(svc);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymous = await (await fetch(`${base}/api/me`)).json();
    assert.equal(anonymous.user, null);
    assert.ok('logoutUrl' in anonymous);
    assert.equal(typeof anonymous.version, 'string');

    const signedIn = await (await fetch(`${base}/api/me`, { headers: { 'x-admintools-email': 'alice@example.com' } })).json();
    assert.equal(signedIn.user, 'alice@example.com');
    assert.equal(signedIn.connected, false);
    assert.ok('logoutUrl' in signedIn);
    assert.equal(signedIn.version, anonymous.version);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
