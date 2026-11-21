import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { classifyV2 } from '../src/llm.js';
import { addHebrewTag, isHebrewTitle, typeForLink } from '../src/rules.js';

const empty = { status: 'ready', folder: { action: 'none', name: null }, existingTags: [], newTags: [], profileTags: [], reason: 'x' };

test('a Hebrew title gets the Hebrew tag as a new tag when the vocabulary has none', () => {
  const out = addHebrewTag(empty, 'הכלכלה האמיתית', ['design']);
  assert.deepEqual(out.newTags, ['hebrew']);
  assert.deepEqual(out.existingTags, []);
});

test('a Hebrew title uses the known spelling of the Hebrew tag', () => {
  const out = addHebrewTag(empty, 'שלום', ['Hebrew', 'design']);
  assert.deepEqual(out.existingTags, ['Hebrew']);
  assert.deepEqual(out.newTags, []);
});

test('the Hebrew tag is not added twice', () => {
  const entry = { ...empty, newTags: ['Hebrew'] };
  assert.equal(addHebrewTag(entry, 'שלום', []), entry);
  const known = { ...empty, existingTags: ['hebrew'] };
  assert.equal(addHebrewTag(known, 'שלום', ['hebrew']), known);
});

test('an English title gets no Hebrew tag', () => {
  assert.equal(addHebrewTag(empty, 'Serve Markdown to AI Agents', ['hebrew']), empty);
  assert.equal(isHebrewTitle('Serve Markdown'), false);
});

test('a missing entry stays missing', () => {
  assert.equal(addHebrewTag(undefined, 'שלום', []), undefined);
});

test('an X photo page is an image', () => {
  assert.equal(typeForLink('https://x.com/ExodusPgame/status/1942217547396391079/photo/1'), 'image');
  assert.equal(typeForLink('https://x.com/JoshuaBarzon/status/2119199745583591641/photo/1?a=fP5&s=09'), 'image');
});

test('a direct image file is an image', () => {
  assert.equal(typeForLink('http://www.filmschoolrejects.com/images/hurt-locker-poster1.jpg'), 'image');
  assert.equal(typeForLink('https://example.com/pic.PNG?size=2'), 'image');
});

test('a video host page is a video, also a TikTok video page', () => {
  assert.equal(typeForLink('https://www.youtube.com/watch?v=XPM1o9QKw1Q'), 'video');
  assert.equal(typeForLink('https://youtu.be/XPM1o9QKw1Q'), 'video');
  assert.equal(typeForLink('https://www.tiktok.com/@kinolime_official/video/7486704748876369194'), 'video');
  assert.equal(typeForLink('https://vimeo.com/12345'), 'video');
});

test('an X post without a photo, and a normal page, keep their type', () => {
  assert.equal(typeForLink('https://x.com/MengTo/status/2078319170249425059'), null);
  assert.equal(typeForLink('https://digital-photography-school.com/mastering-on-camera-flash/'), null);
  assert.equal(typeForLink(''), null);
});

// The wiring in classifyV2: the model is stubbed, and the reply is read through the real code path.
test('classifyV2 adds the Hebrew tag to a Hebrew title, and not to an English title', async () => {
  const saved = { ...config.llm };
  const realFetch = globalThis.fetch;
  config.llm.endpoint = 'http://llm.invalid';
  config.llm.token = 'dummy';
  config.llm.minIntervalMs = 0;
  const reply = [
    { id: 1, folder: { action: 'existing', name: 'AI' }, tags: { existing: [], new: [] }, status: 'ready', reason: 'r' },
    { id: 2, folder: { action: 'existing', name: 'AI' }, tags: { existing: [], new: [] }, status: 'ready', reason: 'r' },
  ];
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }),
  });
  try {
    const batch = [
      { id: 1, title: 'הכלכלה האמיתית', url: 'https://example.com/1', note: '', excerpt: '', currentFolder: 'Unsorted', currentTags: [] },
      { id: 2, title: 'Serve Markdown', url: 'https://example.com/2', note: '', excerpt: '', currentFolder: 'Unsorted', currentTags: [] },
    ];
    const out = await classifyV2(batch, ['AI'], ['design'], { attempts: 1 });
    assert.deepEqual(out.get(1).newTags, ['hebrew']);
    assert.deepEqual(out.get(2).newTags, []);
    assert.deepEqual(out.get(2).existingTags, []);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.llm, saved);
  }
});

// Review round 1 of PR #145. A query string or a look-alike domain does not make a media link.
test('a query string that names an image is not an image', () => {
  assert.equal(typeForLink('https://example.com/article?thumbnail=photo.jpg'), null);
});

test('a host that starts with a video domain is not a video', () => {
  assert.equal(typeForLink('https://youtube.com.example.org/article'), null);
  assert.equal(typeForLink('https://notyoutube.com/watch?v=1'), null);
});

test('a subdomain of a video host is a video, and a TED page that is not a talk is not', () => {
  assert.equal(typeForLink('https://m.youtube.com/watch?v=1'), 'video');
  assert.equal(typeForLink('https://www.ted.com/talks/toby_shapshak'), 'video');
  assert.equal(typeForLink('https://www.ted.com/about'), null);
});

test('a link that is not http or https keeps its type', () => {
  assert.equal(typeForLink('ftp://example.com/photo.jpg'), null);
  assert.equal(typeForLink('not a url'), null);
});

// Review round 1 of PR #145: the topic limit and the profile tag.
test('the Hebrew tag takes a topic place: the last other tag gives way when the list is full', () => {
  const full = { ...empty, existingTags: ['design'], newTags: ['a', 'b', 'c'] };
  const out = addHebrewTag(full, 'שלום', ['design']);
  assert.deepEqual(out.existingTags, ['design']);
  assert.deepEqual(out.newTags, ['a', 'b', 'hebrew']);
  assert.equal(out.existingTags.length + out.newTags.length, 3 + 1);
});

test('the Hebrew tag replaces a known tag when only known tags fill the list', () => {
  const full = { ...empty, existingTags: ['w', 'x', 'y', 'z'] };
  const out = addHebrewTag(full, 'שלום', ['Hebrew', 'w', 'x', 'y', 'z']);
  assert.deepEqual(out.existingTags, ['w', 'x', 'y', 'Hebrew']);
  assert.equal(out.existingTags.length, 4);
});

test('a reserved Hebrew tag, in any letter case, is never added as a topic tag', () => {
  assert.equal(addHebrewTag(empty, 'שלום', ['Hebrew'], new Set(['hebrew'])), empty);
});

test('a Hebrew title without a reserved tag still gets the tag', () => {
  assert.deepEqual(addHebrewTag(empty, 'שלום', [], new Set(['other'])).newTags, ['hebrew']);
});

// Review round 2 of PR #145: a bookmark that has the Hebrew tag keeps four fresh topic tags.
test('a bookmark that already has the Hebrew tag keeps four fresh topic tags', () => {
  const full = { ...empty, newTags: ['a', 'b', 'c', 'd'] };
  assert.equal(addHebrewTag(full, 'שלום', [], new Set(), ['Hebrew']), full);
  assert.equal(addHebrewTag(full, 'שלום', [], new Set(), ['hebrew', 'x']), full);
});
