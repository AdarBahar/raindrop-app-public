// The profile in the suggestion prompt and in the reply check (docs/profile-plan.md, sections 7.1 to 7.4).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../src/bookmarks.js';
import { getJob, startJob } from '../src/bulk.js';
import { buildMessagesV2, maxTokensV2, parseRepliesV2 } from '../src/llm.js';
import { contextFor } from '../src/profile.js';

const folders = ['AI', 'Business'];
const vocab = ['saas', 'proj:raindrop', 'llm'];
const entry = (id, over = {}) => ({ id: String(id), kind: 'project', name: `Project ${id}`, description: `About project ${id}.`, tag: `proj:p${id}`, active: true, ...over });
const ENTRIES = [
  { id: '1', kind: 'about', name: '', description: 'I build web tools.', tag: null, active: true },
  entry(17, { name: 'raindrop-app', tag: 'proj:raindrop' }),
  entry(18, { name: 'Drums', kind: 'interest', tag: 'drums' }),
  entry(19, { name: 'Notes', tag: null }),
  entry(20, { name: 'Old project', tag: 'proj:old', active: false }),
];
const snapshot = (entries = ENTRIES) => contextFor({ store: { profile: async () => entries } }, 'u');
const batch = [{ id: 1, title: 't', url: 'https://e.test/1', note: '', excerpt: '', currentFolder: 'Unsorted', currentTags: [] }];
const reply = (over) => JSON.stringify([{ id: 1, folder: { action: 'existing', name: 'AI' }, tags: { existing: [], new: [] }, status: 'ready', reason: 'r', ...over }]);
const read = async (over, entries) => parseRepliesV2(reply(over), [1], folders, vocab, await snapshot(entries)).get(1);

// ---- The request ----

test('without a profile, the prompt is the current prompt, byte for byte', async () => {
  const none = buildMessagesV2(batch, folders, vocab);
  // The hash of the system message. It changed on 2026-11-20 with the prompt rules 9 to 13 (llm.js).
  // Update this hash only when the prompt changes on purpose.
  assert.equal(createHash('sha256').update(none[0].content).digest('hex'), '0e43a4089fc1acaabd0a870b392a9ac25c47e28c45ccbccc86d419997c6d9f48');
  assert.equal(none[1].content, JSON.stringify({ folders, knownTags: vocab, bookmarks: batch }));
  assert.deepEqual(buildMessagesV2(batch, folders, vocab, null), none);
  // A user with no entry, and a user whose entries are all inactive, get the same messages.
  assert.equal(await snapshot([]), null);
  const inactive = await snapshot([entry(20, { tag: 'saas', active: false })]);
  assert.equal(inactive.block, null);
  assert.deepEqual(buildMessagesV2(batch, folders, vocab, inactive), none);
  assert.equal(maxTokensV2(null), 2000);
  assert.equal(maxTokensV2(inactive), 2000);
});

test('with a profile, the user message has the active entries with text keys, and their tags are not known tags', async () => {
  const [system, user] = buildMessagesV2(batch, folders, vocab, await snapshot());
  const sent = JSON.parse(user.content);
  assert.deepEqual(sent.profile, {
    about: 'I build web tools.',
    entries: [
      { id: 'p17', name: 'raindrop-app', description: 'About project 17.', tag: 'proj:raindrop' },
      { id: 'p18', name: 'Drums', description: 'About project 18.', tag: 'drums' },
      { id: 'p19', name: 'Notes', description: 'About project 19.', tag: null },
    ],
  });
  assert.deepEqual(sent.knownTags, ['saas', 'llm']);
  assert.deepEqual(sent.folders, folders);
  assert.match(system.content, /PERSONAL CONTEXT/);
  assert.match(system.content, /1 to 4 relevant topic tags/);
  assert.doesNotMatch(system.content, /1 to 4 relevant tags in total/);
  assert.match(system.content, /"context": string\[\],/);
  assert.match(system.content, /The same language, library, or framework is not enough\./);
  assert.match(system.content, /The profile does not change the folder rules\./);
});

test('a full reply for 10 bookmarks is inside the token limit with a profile', async () => {
  const p = await snapshot();
  // 4 topic tags, 2 profile tags, 2 keys and a reason of full length for each bookmark.
  const full = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
    id: 1000000000 + i,
    folder: { action: 'propose', name: 'A new folder with a long name' },
    tags: { existing: ['a-known-topic-tag', 'second-known-tag', 'proj:raindrop', 'drums'], new: ['a-new-topic-tag-x', 'another-new-tag'] },
    context: ['p17', 'p18'],
    status: 'needs_review',
    reason: 'x'.repeat(300),
  })), null, 1);
  // A token is 3 characters or more for this kind of text, so characters / 3 is an upper estimate.
  assert.ok(full.length / 3 < maxTokensV2(p), `${Math.ceil(full.length / 3)} tokens estimated`);
  assert.equal(maxTokensV2(p), 4000);
});

// ---- The reply check ----

test('the app takes the profile tag from the entry in context: the model does not repeat it', async () => {
  // The tag is in no list of the model. The key of the entry is enough.
  const plain = await read({ tags: { existing: ['llm'], new: ['obsidian-notes'] }, context: ['p17'] });
  assert.deepEqual(plain.profileTags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
  assert.deepEqual([plain.existingTags, plain.newTags], [['llm'], ['obsidian-notes']]);

  // A model that repeats the tag gets the same result: one profile tag, and the tag is not a topic tag.
  const ok = await read({ tags: { existing: ['proj:raindrop'], new: ['llm'] }, context: ['p17'] });
  assert.deepEqual(ok.profileTags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
  assert.deepEqual(ok.existingTags, ['llm']);
  assert.deepEqual(ok.newTags, []);

  // Without a key, the tag of an entry is dropped in each list. It does not become a topic tag.
  for (const tags of [{ existing: ['proj:raindrop'], new: [] }, { existing: [], new: ['PROJ:Raindrop'] }]) {
    for (const context of [undefined, [], 'p17']) {
      const e = await read({ tags, context });
      assert.deepEqual([e.profileTags, e.existingTags, e.newTags], [[], [], []]);
    }
    // With the key of a different entry, only the tag of that entry is given.
    const other = await read({ tags, context: ['p18'] });
    assert.deepEqual([other.profileTags.map((p) => p.tag), other.existingTags, other.newTags], [['drums'], [], []]);
  }
});

test('context keeps only exact keys of active entries: no number, no other text, no duplicate, at most 2', async () => {
  const tags = { existing: ['proj:raindrop', 'drums'], new: [] };
  for (const context of [[17], ['17'], [' p17'], ['p17 raindrop-app'], ['P17'], [null], [{ id: 'p17' }], ['p20'], ['p99']]) {
    assert.deepEqual((await read({ tags, context })).profileTags, [], JSON.stringify(context));
  }
  const dup = await read({ tags, context: ['p17', 'p17', 'p18'] });
  assert.deepEqual(dup.profileTags.map((p) => p.tag), ['proj:raindrop', 'drums']);
  // p19 and p17 are the first 2 valid keys, so p18 is not used and its tag is dropped. p19 has no tag.
  const three = await read({ tags, context: ['p19', 'p17', 'p18'] });
  assert.deepEqual(three.profileTags.map((p) => p.tag), ['proj:raindrop']);
});

test('the tag of an inactive entry is reserved: it is dropped in each list, also with its key', async () => {
  for (const tags of [{ existing: ['proj:old', 'saas'], new: [] }, { existing: ['saas'], new: ['Proj:Old'] }]) {
    const e = await read({ tags, context: ['p20'] });
    assert.deepEqual(e.profileTags, []);
    assert.deepEqual(e.existingTags, ['saas']);
    assert.deepEqual(e.newTags, []);
  }
});

test('four topic tags followed by two profile tags: all six stay', async () => {
  const e = await read({ tags: { existing: ['saas', 'llm'], new: ['t3', 't4', 'proj:raindrop', 'drums'] }, context: ['p17', 'p18'] });
  assert.deepEqual(e.existingTags, ['saas', 'llm']);
  assert.deepEqual(e.newTags, ['t3', 't4']);
  assert.deepEqual(e.profileTags.map((p) => p.tag), ['proj:raindrop', 'drums']);
  // A fifth topic tag is dropped, and a profile tag before the topic tags does not use one of the 4 places.
  const more = await read({ tags: { existing: ['drums', 'saas', 'llm'], new: ['t3', 't4', 't5'] }, context: ['p18'] });
  assert.deepEqual([...more.existingTags, ...more.newTags], ['saas', 'llm', 't3', 't4']);
  assert.deepEqual(more.profileTags.map((p) => p.tag), ['drums']);
});

test('the profile tag has the spelling and the name of the snapshot, and an entry with no tag gives none', async () => {
  const e = await read({ tags: { existing: ['PROJ:RAINDROP'], new: [] }, context: ['p17', 'p19'] });
  assert.deepEqual(e.profileTags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
});

test('without a profile, a reply with context and any tag is read as today', () => {
  const e = parseRepliesV2(reply({ tags: { existing: ['proj:raindrop'], new: ['x'] }, context: ['p17'] }), [1], folders, vocab).get(1);
  assert.deepEqual(e.existingTags, ['proj:raindrop']);
  assert.deepEqual(e.newTags, ['x']);
  assert.deepEqual(e.profileTags, []);
});

test('a malformed entry with a profile needs review and has no profile tags', async () => {
  const e = await read({ folder: { action: 'existing', name: 'No such folder' }, tags: { existing: ['proj:raindrop'], new: [] }, context: ['p17'] });
  assert.equal(e.status, 'needs_review');
  assert.deepEqual(e.profileTags, []);
});

// ---- The two paths ----

const USER = 'u';
const item = (id, folder, tags) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, domain: 'example.com', tags,
  collection: { $id: folder }, created: new Date().toISOString(), excerpt: '', note: '',
});
function service(items, profiles) {
  const svc = {
    cache: new Map(),
    store: { profile: async (user) => profiles[user] ?? [], removeNew: async () => {}, addLog: async () => {}, keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() },
  };
  for (const user of Object.keys(profiles)) {
    svc.cache.set(user, { at: Date.now(), items, collections: new Map([[-1, 'Unsorted'], [10, 'AI'], [20, 'Business']]), progress: { loaded: 0, total: 0 }, loading: null });
  }
  return svc;
}
// A fake model that reads its reply with the real reply check and the profile that the path gives it.
function fakeModel(over) {
  const calls = [];
  const ask = async (list, labels, known, opts) => {
    calls.push({ list, opts });
    const text = JSON.stringify(list.map((b) => ({ id: b.id, folder: { action: 'existing', name: 'AI' }, tags: { existing: [], new: [] }, status: 'ready', reason: 'r', ...over })));
    return parseRepliesV2(text, list.map((b) => b.id), labels, known, opts.profile);
  };
  return { ask, calls };
}
async function finished(svc, user, job) {
  for (let i = 0; i < 500; i++) {
    const current = getJob(svc, user, job.id);
    if (current.status !== 'running') return current;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('job did not finish');
}

test('single path: profile tags come in their own list, and a tag that the bookmark has is not proposed', async () => {
  const svc = service([item(1, -1, ['drums'])], { [USER]: ENTRIES });
  const { ask, calls } = fakeModel({ tags: { existing: ['proj:raindrop', 'drums'], new: ['topic'] }, context: ['p17', 'p18'] });
  const d = await suggest(svc, USER, 1, ask);
  assert.deepEqual(d.profileTags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
  assert.deepEqual(d.tags, ['drums', 'topic'], 'the profile tag is not in the selected tags, and the current tag stays');
  assert.deepEqual(calls[0].opts.profile.block.entries.map((e) => e.id), ['p17', 'p18', 'p19']);
});

test('single path: a profile tag that does not fit in the tag limit is dropped', async () => {
  const many = Array.from({ length: 18 }, (_, i) => `t${i}`);
  const svc = service([item(1, 10, many)], { [USER]: ENTRIES });
  const { ask } = fakeModel({ tags: { existing: ['proj:raindrop', 'drums'], new: ['topic'] }, context: ['p17', 'p18'] });
  const d = await suggest(svc, USER, 1, ask);
  assert.equal(d.tags.length, 19);
  assert.deepEqual(d.profileTags.map((p) => p.tag), ['proj:raindrop']);
});

test('bulk path: the row has profile_tags, apart from the selected tags, inside the tag limit', async () => {
  const many = Array.from({ length: 19 }, (_, i) => `t${i}`);
  const svc = service([item(1, 10, ['drums']), item(2, 10, many), item(3, 10, [])], { [USER]: ENTRIES });
  const { ask } = fakeModel({ tags: { existing: ['proj:raindrop', 'drums'], new: ['topic'] }, context: ['p17', 'p18'] });
  const job = await finished(svc, USER, await startJob(svc, USER, { action: 'suggest', ids: [1, 2, 3] }, undefined, ask));
  const rows = new Map(job.suggestions.map((s) => [s.id, s]));
  assert.deepEqual(rows.get(1).profile_tags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
  assert.deepEqual(rows.get(1).tags, ['drums']);
  assert.deepEqual(rows.get(1).new_tags, ['topic']);
  // 19 tags and one new topic tag: no room for a profile tag.
  assert.deepEqual(rows.get(2).profile_tags, []);
  assert.deepEqual(rows.get(3).profile_tags.map((p) => p.tag), ['proj:raindrop', 'drums']);
  assert.equal(rows.get(3).status, 'ready');
});

test('bulk path: the profile is read one time, so an edit during the job does not change the names in the review', async () => {
  const profiles = { [USER]: ENTRIES };
  const svc = service([item(1, 10, []), item(2, 10, [])], profiles);
  let reads = 0;
  const readProfile = svc.store.profile;
  svc.store.profile = async (user) => { reads += 1; return readProfile(user); };
  const model = fakeModel({ tags: { existing: ['proj:raindrop'], new: [] }, context: ['p17'] });
  const ask = async (...args) => {
    // The user renames the entry and changes its tag while the job runs.
    profiles[USER] = ENTRIES.map((e) => (e.id === '17' ? { ...e, name: 'Renamed', tag: 'proj:renamed' } : e));
    return model.ask(...args);
  };
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  svc.cache.get(USER).items = ids.map((id) => item(id, 10, []));
  const job = await finished(svc, USER, await startJob(svc, USER, { action: 'suggest', ids }, undefined, ask));
  assert.equal(model.calls.length, 2, 'two model requests');
  assert.equal(reads, 1);
  for (const row of job.suggestions) assert.deepEqual(row.profile_tags, [{ tag: 'proj:raindrop', entryId: '17', entryName: 'raindrop-app' }]);
});

test('two users never see the context of each other', async () => {
  const other = [entry(50, { name: 'Secret plan', tag: 'proj:secret' })];
  const svc = service([item(1, 10, [])], { alice: ENTRIES, bob: other, carol: [] });
  const model = fakeModel({ tags: { existing: ['proj:raindrop', 'proj:secret'], new: [] }, context: ['p17', 'p50'] });
  const a = await suggest(svc, 'alice', 1, model.ask);
  const b = await suggest(svc, 'bob', 1, model.ask);
  const c = await suggest(svc, 'carol', 1, model.ask);
  assert.deepEqual(a.profileTags.map((p) => p.tag), ['proj:raindrop']);
  assert.deepEqual(b.profileTags.map((p) => p.tag), ['proj:secret']);
  assert.deepEqual(c.profileTags, []);
  const [forAlice, forBob, forCarol] = model.calls.map((call) => JSON.stringify(buildMessagesV2(call.list, folders, vocab, call.opts.profile)));
  assert.doesNotMatch(forAlice, /Secret plan|proj:secret/);
  assert.doesNotMatch(forBob, /raindrop-app|I build web tools/);
  assert.doesNotMatch(forCarol, /Secret plan|raindrop-app|PERSONAL CONTEXT/);
  // A tag of the profile of a different user is a normal topic tag for this user.
  assert.deepEqual(b.tags, ['proj:raindrop']);
});

// ---- The page ----
const front = (name) => readFileSync(new URL(`../../frontend/${name}`, import.meta.url), 'utf8');

test('the review: a profile tag has a box that is not checked, and apply sends only a checked one', () => {
  const js = front('review.js');
  // The card starts with no profile tag selected.
  assert.match(js, /newTags: new Set\(s\.new_tags\), profileTags: new Set\(\), editing: false/);
  assert.match(js, /data-rc-ptag="\$\{id\}" value="\$\{esc\(p\.tag\)\}"\$\{c\.profileTags\.has\(p\.tag\) \? ' checked' : ''\}/);
  assert.match(js, /\(from your profile: \$\{esc\(p\.entryName\)\}\)/);
  // The tags that Apply and "Apply all" send: the tag field, the selected new tags, the selected profile tags.
  const box = { splitTags: (text) => (text || '').split(',').map((t) => t.trim()).filter(Boolean) };
  const fn = js.match(/function reviewTags\(c\) \{[\s\S]*?\n\}/)[0];
  vm.runInNewContext(`${fn}\nthis.reviewTags = reviewTags;`, box);
  const card = (selected) => ({ tags: 'a, b', newTags: new Set(['n']), profileTags: new Set(selected) });
  assert.deepEqual([...box.reviewTags(card([]))], ['a', 'b', 'n']);
  assert.deepEqual([...box.reviewTags(card(['proj:x']))], ['a', 'b', 'n', 'proj:x']);
  assert.deepEqual([...box.reviewTags(card(['A']))], ['a', 'b', 'n'], 'a tag that the card has is not sent twice');
});

test('the editor: a profile tag has a box that is not checked until the tag is in the editor', () => {
  const rules = front('rules.js');
  const box = {};
  vm.runInNewContext(`${rules}\nthis.suggestionNote = suggestionNote;`, box);
  const note = box.suggestionNote({ status: 'ready', reason: 'r', profileTags: [{ tag: 'proj:x', entryId: '7', entryName: 'X' }] }, '10');
  assert.deepEqual(JSON.parse(JSON.stringify(note.profile)), [{ tag: 'proj:x', entryName: 'X' }]);
  const js = front('list.js');
  assert.match(js, /data-act="ptag" data-id="\$\{b\.id\}" value="\$\{esc\(p\.tag\)\}"\$\{has\(p\.tag\) \? ' checked' : ''\}/);
  // The answer of the model puts no profile tag in the tags of the editor: only d.tags.
  assert.match(js, /editing\[id\] = \{folderId: String\(d\.folderId\), tags: d\.tags, note: d, \.\.\.noteStart\(lastResults\.find\(x => x\.id === id\)\)\};/);
});

test('the page says that the active entries go to the model', () => {
  const html = front('index.html');
  assert.match(html, /your known tags and the active entries of "My context" to the language model this app uses\./);
  assert.match(front('list.js'), /your known tags and the active entries of My context to the language model"/);
});
