// The suggestion for one bookmark uses the v2 prompt with a batch of one (docs/profile-plan.md, section 7.4).
// The answer fills the editor. A bookmark that is in a folder keeps it, and nothing is created.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { suggest } from '../src/bookmarks.js';
import * as llm from '../src/llm.js';

const USER = 'u';
const collections = [[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']];
const item = (id, folder, tags) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, domain: 'example.com', tags,
  collection: { $id: folder }, created: new Date().toISOString(), excerpt: 'e', note: 'n',
});

let profileEntries = []; // the profile of the user in the fake store
// A service with a fresh cache, so no Raindrop call is made.
function fakeService(items) {
  const svc = { cache: new Map(), store: { profile: async () => profileEntries } };
  svc.cache.set(USER, { at: Date.now(), items, collections: new Map(collections), progress: { loaded: 0, total: 0 }, loading: null });
  return svc;
}

// A parsed entry of the model, and a fake model that returns it for the bookmark.
const entry = (folder, { existing = [], fresh = [], status = 'ready' } = {}) => ({
  status, folder, existingTags: existing, newTags: fresh, reason: 'Because.',
});
function fakeAsk(found) {
  const calls = [];
  const ask = async (batch, folders, vocab, opts) => {
    calls.push({ batch, folders, vocab, opts });
    return new Map(found ? [[batch[0].id, found]] : []);
  };
  return { ask, calls };
}
const run = (bookmark, found) => suggest(fakeService([bookmark, item(2, 20, ['saas'])]), USER, bookmark._id, fakeAsk(found).ask);

test('the model gets one bookmark, with its current folder and tags', async () => {
  const { ask, calls } = fakeAsk(entry({ action: 'existing', name: 'AI' }));
  await suggest(fakeService([item(1, 20, ['x']), item(2, 10, ['saas'])]), USER, 1, ask);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].batch, [{
    id: 1, title: 'bookmark 1', url: 'https://example.com/1', note: 'n', excerpt: 'e', currentFolder: 'Business', currentTags: ['x'],
  }]);
  assert.deepEqual(calls[0].folders, ['AI', 'Business']);
  assert.deepEqual(calls[0].opts, { who: USER, profile: null });
});

test('existing folder, bookmark in Unsorted: the editor gets the folder of the model', async () => {
  const d = await run(item(1, -1, []), entry({ action: 'existing', name: 'AI' }, { existing: ['saas'], fresh: ['llm'] }));
  assert.equal(d.folderId, 10);
  assert.equal(d.folder, 'AI');
  assert.equal(d.label, 'AI');
  assert.equal(d.suggestedFolder, null);
  assert.equal(d.proposedFolder, null);
  assert.deepEqual(d.tags, ['saas', 'llm']);
  assert.equal(d.reason, 'Because.');
  assert.equal(d.status, 'ready');
  assert.deepEqual(d.profileTags, []);
});

test('existing folder, bookmark in a different folder: the current folder stays, and the folder of the model is a suggestion', async () => {
  const d = await run(item(1, 20, ['x']), entry({ action: 'existing', name: 'AI' }));
  assert.equal(d.folderId, 20);
  assert.equal(d.folder, 'Business');
  assert.deepEqual(d.suggestedFolder, { id: 10, label: 'AI' });
});

test('existing folder that is the folder of the bookmark: no suggestion', async () => {
  const d = await run(item(1, 10, []), entry({ action: 'existing', name: 'AI' }));
  assert.equal(d.folderId, 10);
  assert.equal(d.suggestedFolder, null);
});

test('proposed folder: the current folder stays, for a sorted and for an Unsorted bookmark', async () => {
  for (const current of [20, -1]) {
    const d = await run(item(1, current, []), entry({ action: 'propose', name: 'Gardening' }));
    assert.equal(d.folderId, current);
    assert.equal(d.folder, current === 20 ? 'Business' : 'Unsorted');
    assert.equal(d.proposedFolder, 'Gardening');
    assert.equal(d.suggestedFolder, null);
  }
});

test('"none": the current folder stays, and the status is needs_review', async () => {
  for (const current of [20, -1]) {
    const d = await run(item(1, current, ['x']), entry({ action: 'none', name: null }, { status: 'needs_review', fresh: ['y'] }));
    assert.equal(d.folderId, current);
    assert.equal(d.status, 'needs_review');
    assert.equal(d.suggestedFolder, null);
    assert.equal(d.proposedFolder, null);
    assert.deepEqual(d.tags, ['x', 'y']);
  }
});

test('no answer for the bookmark is a 502 with the text of the old path', async () => {
  await assert.rejects(run(item(1, -1, []), null), (err) => err.status === 502 && err.message === 'The model returned no suggestion.');
});

test('an unknown bookmark is a 404, and the model is not asked', async () => {
  const { ask, calls } = fakeAsk(entry({ action: 'none', name: null }));
  await assert.rejects(suggest(fakeService([item(1, -1, [])]), USER, 99, ask), (err) => err.status === 404);
  assert.equal(calls.length, 0);
});

test('the tags: the current tags first, no duplicate in any letter case, cut at the limit of a bookmark', async () => {
  const d = await run(item(1, 10, ['React', 'x']), entry({ action: 'existing', name: 'AI' }, { existing: ['react', 'saas'], fresh: ['X', 'new'] }));
  assert.deepEqual(d.tags, ['React', 'x', 'saas', 'new']);
  assert.equal(d.tagsLeftOut, 0);

  const many = Array.from({ length: 19 }, (_, i) => `t${i}`);
  const cut = await run(item(1, 10, many), entry({ action: 'existing', name: 'AI' }, { existing: ['saas'], fresh: ['a', 'b'] }));
  assert.deepEqual(cut.tags, [...many, 'saas']);
  assert.equal(cut.tagsLeftOut, 2);

  const full = Array.from({ length: 22 }, (_, i) => `t${i}`);
  const over = await run(item(1, 10, full), entry({ action: 'existing', name: 'AI' }, { fresh: ['a'] }));
  assert.deepEqual(over.tags, full, 'the current tags are never cut');
  assert.equal(over.tagsLeftOut, 1);
});

test('the older prompt and its parser are gone', () => {
  assert.equal(llm.classify, undefined);
  assert.equal(llm.parseReply, undefined);
  assert.equal(typeof llm.classifyV2, 'function');
});

// ---- The editor ----
const rules = readFileSync(new URL('../../frontend/rules.js', import.meta.url), 'utf8');
const box = {};
vm.runInNewContext(`${rules}\nthis.suggestionNote = suggestionNote;`, box);
const note = (d, folderId) => JSON.parse(JSON.stringify(box.suggestionNote(d, folderId)));
const answer = (over) => ({ folderId: 20, tags: [], tagsLeftOut: 0, reason: 'Because.', status: 'ready', suggestedFolder: null, proposedFolder: null, ...over });

test('the editor note: the reason, a warning when the model is not sure', () => {
  assert.deepEqual(note(answer(), '20'), { reason: 'Because.', warn: false, folder: null, proposed: '', profile: [], left: '' });
  assert.equal(note(answer({ status: 'needs_review' }), '20').warn, true);
});

test('the editor note: a suggested folder, and whether the editor has it selected', () => {
  const d = answer({ suggestedFolder: { id: 10, label: 'AI' } });
  assert.deepEqual(note(d, '20').folder, { id: '10', label: 'AI', selected: false });
  assert.equal(note(d, '10').folder.selected, true);
});

test('the editor note: a proposed folder, and the text for tags over the limit', () => {
  assert.equal(note(answer({ proposedFolder: 'Gardening' }), '20').proposed, 'Gardening');
  assert.equal(note(answer({ tagsLeftOut: 1 }), '20').left, '1 suggested tag was left out: a bookmark can have at most 20 tags.');
  assert.equal(note(answer({ tagsLeftOut: 3 }), '20').left, '3 suggested tags were left out: a bookmark can have at most 20 tags.');
});

test('the editor keeps the answer, shows the note, and creates nothing by itself', () => {
  const js = readFileSync(new URL('../../frontend/list.js', import.meta.url), 'utf8');
  assert.match(js, /editing\[id\] = \{folderId: String\(d\.folderId\), tags: d\.tags, note: d\};/);
  assert.match(js, /\$\{ed\.note \? noteHtml\(b, ed\) : ''\}/);
  assert.match(js, /data-act="usefolder"[^>]*>Move to this folder</);
  assert.match(js, /data-act="useproposed"[^>]*>Use this name</);
  // "Use this name" only opens the name box. The create call stays in the "Create folder" button.
  const branch = js.slice(js.indexOf("act === 'useproposed'"), js.indexOf("act === 'rmtag'"));
  assert.match(branch, /ed\.creating = true; ed\.newName = ed\.note\.proposedFolder;/);
  assert.doesNotMatch(branch, /createFolder|postJson/);
});
