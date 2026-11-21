import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScript } from './helpers/frontend.js';

// Static checks of the page. They keep the accessibility fixes from being removed by mistake.
// A browser check with a keyboard and a screen reader is still needed.
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const js = pageScript();
const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');

test('the page has a skip link to the results, and a visible-to-screen-reader heading', () => {
  assert.match(html, /<a class="skip" href="#appMain">Skip to results<\/a>/);
  assert.match(html, /<main id="appMain" tabindex="-1"/);
  assert.match(html, /<h1 class="sr-only">Raindrop search<\/h1>/);
  assert.match(css, /\.skip \{[^}]*transform: translateY\(-200%\)/);
  assert.match(css, /\.sr-only \{/);
});

test('every label points to a control that exists', () => {
  const targets = [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 8);
  for (const id of targets) assert.match(html, new RegExp(`id="${id}"`), `no control with id ${id}`);
  for (const name of ['q', 'sort', 'statusFilter', 'visited', 'tags', 'from', 'to']) {
    assert.ok(targets.includes(name), `${name} has no visible label`);
  }
});

test('the count and status line announce their changes, and errors are alerts', () => {
  assert.match(html, /role="status" aria-live="polite"><strong id="count">/);
  assert.match(html, /id="connectErr" class="err" role="alert"/);
  assert.match(html, /id="newFolderErr" class="err" role="alert"/);
});

test('the preset and folder buttons say whether they are pressed', () => {
  const presets = [...html.matchAll(/data-preset="[^"]+"[^>]*>/g)].map((m) => m[0]);
  assert.equal(presets.length, 5);
  for (const b of presets) assert.match(b, /aria-pressed="(true|false)"/);
  assert.match(js, /function setOn\(b, on\)/);
  assert.match(js, /setOn\(b, b\.dataset\.preset === p\)/);
  assert.match(js, /setOn\(b, b\.dataset\.folder === folder\)/);
});

test('the create folder field links to its error, and marks it when invalid', () => {
  assert.match(html, /aria-describedby="newFolderErr"/);
  assert.match(js, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(js, /setAttribute\('aria-invalid', 'false'\)/);
});

test('each bookmark link says it opens in a new tab, and each tag button has a name', () => {
  assert.match(js, /aria-label="\$\{esc\(b\.title\)\}, opens in a new tab"/);
  assert.match(js, /aria-label="Remove tag \$\{esc\(t\)\}"/);
  assert.match(js, /aria-label="Add tag"/);
});

test('focus moves into the editor when it opens, and back out when it closes; Escape closes', () => {
  assert.match(js, /function focusEditor\(id\)/);
  assert.match(js, /function returnFocus\(id\)/);
  assert.match(js, /focusEditor\(id\);\n  \} else if \(act === 'usefolder'\)/);
  assert.match(js, /e\.key === 'Escape'/);
  assert.match(js, /if \(e\.key === 'Escape'\) \{ closeNewFolderBox\(\)/);
});

test('the suggest step announces that it is working', () => {
  assert.match(js, /\$\('status'\)\.textContent = 'Asking the model\.\.\.';/);
});

test('Escape does nothing while an editor is busy, so a running save can still show its result', () => {
  assert.match(js, /if \(editing\[id\]\.busy\) return;/);
});
