import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_URL = pathToFileURL(join(BACKEND, 'src', 'config.js')).href;

// Load the config in a new process. Only RAINDROP_ENV_FILE is set, so this test's
// environment cannot leak into the result.
function loadConfig(envFileText) {
  const file = join(mkdtempSync(join(tmpdir(), 'rs-config-')), 'custom.env');
  writeFileSync(file, envFileText);
  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(CONFIG_URL)}).then(m => console.log(JSON.stringify(m.config)))`], {
    env: { PATH: process.env.PATH, RAINDROP_ENV_FILE: file },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('RAINDROP_ENV_FILE selects the env file that is read', () => {
  const config = loadConfig('RAINDROP_CLIENT_ID=from-custom-file\n');
  assert.equal(config.raindrop.clientId, 'from-custom-file');
});

test('storage settings are read from the env file', () => {
  const config = loadConfig('DATA_DIR=/srv/rs/data\nDATA_KEY_FILE=/srv/rs/key\n');
  assert.equal(config.dataDir, '/srv/rs/data');
  assert.equal(config.keyFile, '/srv/rs/key');
});

test('the redirect URL follows the port when none is set', () => {
  const config = loadConfig('PORT=9123\n');
  assert.equal(config.port, 9123);
  assert.equal(config.raindrop.redirectUri, 'http://127.0.0.1:9123/oauth/callback');
});
