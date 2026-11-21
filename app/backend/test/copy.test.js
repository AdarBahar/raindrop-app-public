import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScript } from './helpers/frontend.js';

// The page must not name server files or tables. Users cannot open them.
const app = pageScript();

test('the save warning gives the user a clear message', () => {
  // The text starts with "Saved." (or "Moved to Archive.") and then gives the warning.
  assert.ok(app.includes("const done = act === 'archive' ? `Moved to ${ARCHIVE}.` : 'Saved.';"));
  assert.ok(app.includes("done + ' Raindrop stored different tags than you chose. Review the tags on this bookmark.'"));
});

test('no server file name appears in the page script', () => {
  assert.doesNotMatch(app, /\.jsonl|classify[-_]log|classify_log/);
});
