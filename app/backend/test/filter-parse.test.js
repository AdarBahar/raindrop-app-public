import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { dateRange, parseFilter, presetStarts } from '../src/listing.js';

const { limits } = config;
const longText = 'x'.repeat(limits.searchLength + 1);
const manyTags = Array.from({ length: limits.tagsPerFilter + 1 }, (_, i) => `t${i}`).join(',');

test('parseFilter gives the search words, the tags without repeats, and the date range', () => {
  const f = parseFilter({ q: '  Foo  BAR ', tags: 'News, news ,,Tech', preset: 'custom', from: '2026-01-10', to: '2026-01-12', tz: 'UTC' });
  assert.deepEqual(f.terms, ['foo', 'bar']);
  assert.deepEqual(f.tags, ['news', 'tech']);
  assert.deepEqual([f.start, f.end], dateRange('custom', '2026-01-10', '2026-01-12', 'UTC'));
});

test('parseFilter with no input gives no words, no tags and no date limits', () => {
  assert.deepEqual(parseFilter({}), { terms: [], tags: [], start: null, end: null });
});

test('parseFilter checks the search text first, then the tag filter, then the zone and the dates', () => {
  assert.throws(() => parseFilter({ q: longText, tags: manyTags, tz: 'Not/AZone' }), /search text/);
  assert.throws(() => parseFilter({ tags: manyTags, tz: 'Not/AZone' }), /at most 10 tags/);
  assert.throws(() => parseFilter({ tz: 'Not/AZone' }), (err) => err.status === 400);
});

test('presetStarts gives the start of each date preset in the zone', () => {
  const starts = presetStarts('UTC');
  assert.deepEqual(Object.keys(starts), ['today', 'last7', 'last30']);
  for (const name of Object.keys(starts)) assert.deepEqual(starts[name], dateRange(name, '', '', 'UTC')[0]);
});
