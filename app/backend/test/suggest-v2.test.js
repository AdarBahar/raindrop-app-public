import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRepliesV2, ReplyError } from '../src/llm.js';

// The reader for the v2 batch reply. The model is not called. The tests use replies that the model could send.
const folders = ['AI & LLMs', 'Design & UI', 'Misc', 'Reading'];
const vocab = ['design', 'UI', 'inspiration', 'LLM', 'ai', 'prompts'];
const ids = [101, 102];

test('a ready reply with an existing folder keeps the spelling of the known tags', () => {
  const text = JSON.stringify([
    { id: 101, folder: { action: 'existing', name: 'Design & UI' }, tags: { existing: ['UI', 'design'], new: ['navigation'] }, status: 'ready', reason: 'A gallery.' },
  ]);
  const map = parseRepliesV2(text, ids, folders, vocab);
  assert.deepEqual(map.get(101), {
    status: 'ready',
    folder: { action: 'existing', name: 'Design & UI' },
    existingTags: ['UI', 'design'],
    newTags: ['navigation'],
    profileTags: [],
    reason: 'A gallery.',
  });
});

test('a proposal that matches an existing folder, ignoring case, becomes an existing folder', () => {
  const text = JSON.stringify([{ id: 101, folder: { action: 'propose', name: 'design & ui' }, tags: {}, status: 'ready', reason: 'x' }]);
  assert.deepEqual(parseRepliesV2(text, ids, folders, vocab).get(101).folder, { action: 'existing', name: 'Design & UI' });
});

test('a new folder proposal stays a proposal, and its status is kept as the model gave it', () => {
  const text = JSON.stringify([{ id: 101, folder: { action: 'propose', name: 'Developer Tools' }, tags: {}, status: 'ready', reason: 'x' }]);
  const entry = parseRepliesV2(text, ids, folders, vocab).get(101);
  assert.deepEqual(entry.folder, { action: 'propose', name: 'Developer Tools' });
  assert.equal(entry.status, 'ready');
});

test('"none" never becomes a folder, even when the model says ready', () => {
  const text = JSON.stringify([{ id: 102, folder: { action: 'none', name: null }, tags: {}, status: 'ready', reason: 'Unclear.' }]);
  const entry = parseRepliesV2(text, ids, folders, vocab).get(102);
  assert.deepEqual(entry.folder, { action: 'none', name: null });
  assert.equal(entry.status, 'needs_review');
});

test('an existing folder that the list does not have needs review', () => {
  const text = JSON.stringify([{ id: 101, folder: { action: 'existing', name: 'Nope' }, tags: {}, status: 'ready', reason: 'x' }]);
  const entry = parseRepliesV2(text, ids, folders, vocab).get(101);
  assert.equal(entry.status, 'needs_review');
  assert.equal(entry.folder.action, 'none');
  assert.match(entry.reason, /does not exist/);
});

test('at most 4 distinct tags are kept, and a repeated tag is kept once', () => {
  const text = JSON.stringify([{
    id: 101,
    folder: { action: 'existing', name: 'Reading' },
    tags: { existing: ['ai', 'AI'], new: ['a1', 'a2', 'a3', 'a4'] },
    status: 'ready',
    reason: 'x',
  }]);
  const entry = parseRepliesV2(text, ids, folders, vocab).get(101);
  assert.deepEqual(entry.existingTags, ['ai']);
  assert.deepEqual(entry.newTags, ['a1', 'a2', 'a3']);
});

test('ids that were not sent are ignored, and a bookmark with no entry has no result', () => {
  const text = JSON.stringify([{ id: 999, folder: { action: 'none' }, tags: {}, status: 'needs_review', reason: 'x' }]);
  const map = parseRepliesV2(text, ids, folders, vocab);
  assert.equal(map.size, 0);
});

test('a reply that is not a JSON array is refused, so the caller can retry', () => {
  assert.throws(() => parseRepliesV2('Sorry, I cannot help.', ids, folders, vocab), ReplyError);
  assert.throws(() => parseRepliesV2('{"id": 101}', ids, folders, vocab), ReplyError);
});

test('a bookmark listed twice refuses the whole reply, so the caller can retry', () => {
  const one = { id: 101, folder: { action: 'none' }, tags: {}, status: 'needs_review', reason: 'x' };
  assert.throws(() => parseRepliesV2(JSON.stringify([one, one]), ids, folders, vocab), ReplyError);
});

test('the v2 prompt tells the model to use the URL when the title is only a file name', () => {
  const src = readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8');
  assert.match(src, /If the title is empty or is only a file name[^\n]*use the URL's domain and path to determine the topic\./);
});

test('a tag that apply would refuse is dropped, so a ready card does not fail in "Apply all"', () => {
  const long = 'x'.repeat(51);
  const text = JSON.stringify([
    { id: 101, folder: { action: 'existing', name: 'Reading' }, tags: { existing: ['design'], new: ['a, b', long, 'ok'] }, status: 'ready', reason: 'A gallery.' },
  ]);
  const entry = parseRepliesV2(text, ids, folders, vocab).get(101);
  assert.equal(entry.status, 'ready');
  assert.deepEqual(entry.existingTags, ['design']);
  assert.deepEqual(entry.newTags, ['ok']);
});
