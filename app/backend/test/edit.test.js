import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageScript, pageScriptFiles } from './helpers/frontend.js';

// The browser scripts. rules.js defines tagProblem(). The page script (core.js ... app.js) is checked as text.
const rulesSource = readFileSync(new URL('../../frontend/rules.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(`${rulesSource}\nthis.tagProblem = tagProblem;`, sandbox);
const { tagProblem } = sandbox;
const app = pageScript();
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

test('a tag that fits is allowed, and a tag already in the list is not a problem', () => {
  assert.equal(tagProblem('news', ['ai']), '');
  assert.equal(tagProblem('AI', ['ai']), '');
});

test('the tag length, the commas and the count follow the server limits', () => {
  assert.equal(tagProblem('x'.repeat(50), []), '');
  assert.equal(tagProblem('x'.repeat(51), []), 'A tag can have at most 50 characters.');
  assert.equal(tagProblem('a,b', []), 'Tags cannot contain commas.');
  const nineteen = Array.from({ length: 19 }, (_, i) => `t${i}`);
  assert.equal(tagProblem('new', nineteen), '');
  const twenty = [...nineteen, 't19'];
  assert.equal(tagProblem('new', twenty), 'A bookmark can have at most 20 tags.');
});

test('every card has an Edit button, and Edit opens the editor with the current folder and tags', () => {
  assert.match(app, /data-act="edit" data-id="\$\{b\.id\}" \$\{pending \? 'disabled' : ''\}>Edit<\/button>/);
  assert.match(app, /act === 'edit'\) \{[\s\S]*?editing\[id\] = \{folderId: String\(item\.collection_id\), tags: \[\.\.\.item\.tags\], \.\.\.noteStart\(item\)\};/);
});

test('the suggest button stays on new cards and on cards with no folder or tags only', () => {
  assert.match(app, /const suggest = b\.is_new \|\| b\.needs/);
});

test('the tag rules load before the page script', () => {
  assert.ok(html.indexOf('/static/rules.js') > -1);
  for (const part of pageScriptFiles()) {
    assert.ok(html.indexOf('/static/rules.js') < html.indexOf(`/static/${part}`), `rules.js loads before ${part}`);
  }
});

test('Edit is ignored while a suggestion is pending, so a late answer cannot replace a manual edit', () => {
  assert.match(app, /const suggesting = new Set\(\);/);
  assert.match(app, /suggesting\.add\(id\);/);
  assert.match(app, /suggesting\.delete\(id\);/);
  assert.match(app, /if \(suggesting\.has\(id\)\) return;/);
});

test('a second suggestion for the same bookmark is ignored, and a redrawn card keeps its disabled state', () => {
  assert.equal((app.match(/if \(suggesting\.has\(id\)\) return;/g) || []).length, 2);
  assert.match(app, /const pending = suggesting\.has\(b\.id\);/);
  assert.match(app, /data-act="suggest" data-id="\$\{b\.id\}" \$\{pending \? 'disabled' : ''\}/);
  assert.match(app, /data-act="edit" data-id="\$\{b\.id\}" \$\{pending \? 'disabled' : ''\}/);
});

test('the editor has an Archive button: a save with the folder Archive, created on first use', () => {
  assert.match(app, /data-act="archive" data-id="\$\{b\.id\}" \$\{ed\.busy \? 'disabled' : ''\}[^>]*>Archive<\/button>/);
  assert.match(app, /\} else if \(act === 'save' \|\| act === 'archive'\) \{/);
  // The editor keeps its own folder, so a failed Archive does not change a later Save.
  assert.match(app, /folderId = \(await ensureArchive\(\)\)\.id;/);
  assert.doesNotMatch(app, /ed\.folderId = String\(folder\.id\)/);
  assert.match(app, /const done = act === 'archive' \? `Moved to \$\{ARCHIVE\}\.` : 'Saved\.';/);
});

test('the editor has a note box with a label and the server limit, and its text is escaped', () => {
  assert.match(app, /<label for="note-\$\{b\.id\}">Note<\/label><textarea id="note-\$\{b\.id\}" data-act="notetext" data-id="\$\{b\.id\}" rows="3" maxlength="\$\{NOTE_MAX\}"/);
  assert.match(app, /\$\{esc\(ed\.text \?\? ''\)\}<\/textarea>/);
  assert.match(rulesSource, /const NOTE_MAX = 10000;/);
  // A redraw keeps the typed text.
  assert.match(app, /if \(el\.dataset\.act === 'notetext'\) editing\[Number\(el\.dataset\.id\)\]\.text = el\.value;/);
});

test('the card shows the note as escaped text, and a changed note counts as a change', () => {
  assert.match(app, /\$\{b\.note \? `<div class="note"><span class="lbl">Note<\/span>\$\{esc\(b\.note\)\}<\/div>` : ''\}/);
  assert.match(app, /function unchanged\(id\) \{[\s\S]*?&& ed\.text === ed\.noteBase;/);
});

test('a save sends the note only when the user changed it', () => {
  assert.match(app, /const body = \{id, folderId: Number\(folderId\), tags: ed\.tags\};\n\s*if \(ed\.text !== ed\.noteBase\) body\.note = ed\.text;\n\s*const d = await postJson\('\/api\/save', body\);/);
  assert.match(app, /item\.note = d\.note;/);
  // The editor compares with the note that it started with. A list refresh while the editor is open
  // changes the bookmark, and it must not make an untouched note box look changed.
  assert.match(app, /const noteStart = item => \(\{text: noteOf\(item\), noteBase: noteOf\(item\)\}\);/);
  assert.equal((app.match(/\.\.\.noteStart\(/g) || []).length, 3);
});
