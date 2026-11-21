import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every file that the page loads must be in the release package. A missing file gives a 500 in production.
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const release = readFileSync(new URL('../../../deploy/build-release.sh', import.meta.url), 'utf8');

test('every /static file that the page loads is copied into the release', () => {
  const files = [...html.matchAll(/(?:src|href)="\/static\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 3, 'the page should load its scripts and stylesheet');
  for (const file of files) {
    assert.ok(release.includes(`app/frontend/${file}`), `deploy/build-release.sh does not copy app/frontend/${file}`);
  }
});

test('the release package records its release id as VERSION', () => {
  const release = readFileSync(new URL('../../../deploy/build-release.sh', import.meta.url), 'utf8');
  assert.match(release, /printf '%s\\n' "\$ID" > "\$R\/VERSION"/);
});
