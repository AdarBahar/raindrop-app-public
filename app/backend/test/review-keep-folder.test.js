// The review of a batch suggestion keeps the folder of a bookmark that is in a folder (docs/profile-plan.md, PR 3;
// docs/ui-elements.md, section 5.6). The rules are in frontend/rules.js and run here as code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageScript } from './helpers/frontend.js';

const rules = readFileSync(new URL('../../frontend/rules.js', import.meta.url), 'utf8');
const box = {};
vm.runInNewContext(`${rules}\nObject.assign(this, {reviewSorted, reviewStart, sameTags, reviewWaits, reviewInApplyAll, reviewChange});`, box);
const { reviewSorted, reviewStart, sameTags, reviewWaits, reviewInApplyAll, reviewChange } = box;
const js = pageScript();
const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
// Objects from the sandbox have a different prototype. Compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// A suggestion row, as the server sends it. The bookmark is in folder 10 ("Dev") with the tag "a".
const row = (over = {}) => ({
  id: 1, title: 'T', status: 'ready', reason: 'r',
  current_folder: 'Dev', current_folder_id: 10, current_tags: ['a'],
  folder: { action: 'existing', name: 'AI', folderId: 20 }, tags: ['a'], new_tags: [],
  ...over,
});
const unsorted = (over = {}) => row({ current_folder: 'Unsorted', current_folder_id: -1, ...over });
// The card that the review makes for a row, and the tags that Apply would save for it.
const card = (s, over = {}) => ({ s, ...reviewStart(s), edited: false, ...over });
const tagsOf = (s) => [...s.tags, ...s.new_tags];
const PROPOSE = { action: 'propose', name: 'New Stuff', folderId: null };
const NONE = { action: 'none', name: null, folderId: null };

test('a bookmark in a folder starts with its current folder, for each folder decision of the model', () => {
  assert.deepEqual(plain(reviewStart(row())), { folder: '10', suggested: { value: '20', name: 'AI', isNew: false } });
  assert.deepEqual(plain(reviewStart(row({ folder: PROPOSE }))), { folder: '10', suggested: { value: 'new', name: 'New Stuff', isNew: true } });
  assert.deepEqual(plain(reviewStart(row({ folder: NONE, status: 'needs_review' }))), { folder: '10', suggested: null });
  // The model agrees with the current folder: there is nothing to suggest.
  assert.deepEqual(plain(reviewStart(row({ folder: { action: 'existing', name: 'Dev', folderId: 10 } }))), { folder: '10', suggested: null });
});

test('a bookmark in Unsorted starts with the folder of the model, as before', () => {
  assert.equal(reviewSorted(unsorted()), false);
  assert.deepEqual(plain(reviewStart(unsorted())), { folder: '20', suggested: null });
  assert.deepEqual(plain(reviewStart(unsorted({ folder: PROPOSE }))), { folder: '', suggested: null });
  assert.deepEqual(plain(reviewStart(unsorted({ folder: NONE, status: 'needs_review' }))), { folder: '', suggested: null });
});

test('Apply and "Apply all" send the current folder of a sorted bookmark, for each folder decision', () => {
  for (const folder of [{ action: 'existing', name: 'AI', folderId: 20 }, PROPOSE, NONE]) {
    const s = row({ folder, new_tags: ['b'], status: folder === NONE ? 'needs_review' : 'ready' });
    const c = card(s);
    // "Apply all" (create is false) and the Apply button of the card (create is true) send the same folder.
    for (const create of [false, true]) {
      assert.deepEqual(plain(reviewChange(c, tagsOf(s), create)), { id: 1, folderId: 10, tags: ['a', 'b'] });
    }
  }
});

test('a proposed folder is created only after the user selects it', () => {
  const s = row({ folder: PROPOSE, new_tags: ['b'] });
  const c = card(s);
  assert.equal(reviewInApplyAll(c, tagsOf(s)), true);
  assert.equal('newFolder' in reviewChange(c, tagsOf(s), false), false);
  // The user selects the proposed folder on the card. Then both actions send it.
  const chosen = { ...c, folder: 'new', edited: true };
  assert.equal(reviewInApplyAll(chosen, tagsOf(s)), true);
  assert.deepEqual(plain(reviewChange(chosen, tagsOf(s), false)), { id: 1, newFolder: 'New Stuff', tags: ['a', 'b'] });
});

test('an existing folder that the user selects is used by Apply and by "Apply all"', () => {
  const s = row();
  const chosen = { ...card(s), folder: '20', edited: true };
  assert.equal(reviewInApplyAll(chosen, tagsOf(s)), true);
  assert.deepEqual(plain(reviewChange(chosen, tagsOf(s), false)), { id: 1, folderId: 20, tags: ['a'] });
});

test('a card whose only suggestion is a different folder waits for the user and is not in "Apply all"', () => {
  for (const folder of [{ action: 'existing', name: 'AI', folderId: 20 }, PROPOSE]) {
    const s = row({ folder });
    const c = card(s);
    assert.equal(reviewWaits(c, tagsOf(s)), true);
    assert.equal(reviewInApplyAll(c, tagsOf(s)), false);
    // After the user decides, in either direction, the card does not wait.
    assert.equal(reviewWaits({ ...c, edited: true }, tagsOf(s)), false);
    assert.equal(reviewInApplyAll({ ...c, edited: true }, tagsOf(s)), true);
  }
});

test('a card with a tag change is in "Apply all" with the current folder', () => {
  const s = row({ new_tags: ['b'] });
  assert.equal(reviewWaits(card(s), tagsOf(s)), false);
  assert.equal(reviewInApplyAll(card(s), tagsOf(s)), true);
  // Known tags that the model added count as a change too.
  const known = row({ tags: ['a', 'k'] });
  assert.equal(reviewInApplyAll(card(known), tagsOf(known)), true);
});

test('a card that needs review is not in "Apply all" until the user changes it', () => {
  const s = row({ folder: NONE, status: 'needs_review', new_tags: ['b'] });
  assert.equal(reviewInApplyAll(card(s), tagsOf(s)), false);
  assert.equal(reviewInApplyAll({ ...card(s), edited: true }, tagsOf(s)), true);
});

test('Unsorted bookmarks keep the behavior of before', () => {
  const ready = unsorted({ new_tags: ['b'] });
  assert.equal(reviewInApplyAll(card(ready), tagsOf(ready)), true);
  assert.deepEqual(plain(reviewChange(card(ready), tagsOf(ready), false)), { id: 1, folderId: 20, tags: ['a', 'b'] });
  // A proposed folder: the card has no folder, so "Apply all" does not take it. "Create folder and apply" creates it.
  const proposed = unsorted({ folder: PROPOSE });
  assert.equal(reviewInApplyAll(card(proposed), tagsOf(proposed)), false);
  assert.deepEqual(plain(reviewChange(card(proposed), tagsOf(proposed), true)), { id: 1, newFolder: 'New Stuff', tags: ['a'] });
  // The same tags and a folder from the model: the card moves the bookmark, so it does not wait.
  assert.equal(reviewWaits(card(unsorted()), tagsOf(unsorted())), false);
});

test('tag lists are compared without letter case and order', () => {
  assert.equal(sameTags(['a', 'B'], ['b', 'A']), true);
  assert.equal(sameTags(['a'], ['a', 'b']), false);
  assert.equal(sameTags([], []), true);
});

test('the review uses the rules, and shows the suggested folder with a button for each direction', () => {
  assert.match(js, /s, \.\.\.reviewStart\(s\),/);
  assert.match(js, /const changes = cards\.map\(c => reviewChange\(c, reviewTags\(c\), create\)\);/);
  assert.match(js, /data-rc="usefolder" data-id="\$\{id\}"\$\{busy\}>\$\{sug\.isNew \? 'Use the new folder' : 'Move to this folder'\}<\/button>/);
  assert.match(js, /data-rc="keepfolder" data-id="\$\{id\}"\$\{busy\}>Keep the current folder<\/button>/);
  // A selection in either direction is a decision of the user.
  assert.match(js, /c\.folder = use \? c\.suggested\.value : String\(c\.s\.current_folder_id\);\n\s+c\.edited = true;/);
  assert.match(js, /waits \? 'Folder change suggested'/);
  // Apply is off on a card that waits, because it would save nothing.
  assert.match(js, /const idle = reviewWaits\(c, reviewTags\(c\)\);/);
  assert.match(js, /\(c\.folder \|\| create\) && !idle \? busy : ' disabled'/);
});

test('the head of the review says that a sorted bookmark stays in its folder', () => {
  const text = /A bookmark that is in a folder stays there unless you select the suggested folder\./;
  assert.match(html, text);
  assert.match(js, text);
});

test('folder names in the new lines go into the page through esc()', () => {
  assert.match(js, /sugName = sug \? esc\(sug\.name\)/);
  assert.match(js, /Moves from "\$\{esc\(s\.current_folder\)\}"\./);
});
