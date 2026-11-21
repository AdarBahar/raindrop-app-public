import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, meta, search } from '../src/bookmarks.js';
import { RequestError } from '../src/util.js';
import { startOfDay, zoneOf } from '../src/timezone.js';

const USER = 'u';
const NEW_YORK = 'America/New_York';
const JERUSALEM = 'Asia/Jerusalem';

// A cache that is always fresh, so no Raindrop call is made.
function fakeService(items) {
  return {
    cache: new Map([[USER, {
      at: Date.now(),
      items,
      collections: new Map([[-1, 'Unsorted'], [10, 'AI']]),
      progress: { loaded: 0, total: 0 },
      loading: null,
    }]]),
    store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() },
  };
}

const item = (id, instant) => ({
  _id: id, title: `bookmark ${id}`, link: `https://example.com/${id}`, tags: [],
  collection: { $id: 10 }, created: instant,
});

// Assert that a call fails with a 400 whose message matches.
async function refused(promise, text) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof RequestError, `expected RequestError, got ${err}`);
    assert.equal(err.status, 400);
    assert.match(err.message, text);
    return true;
  });
}

test('local midnight in New York and in Jerusalem', () => {
  // 2026-10-18 is still on daylight time in both zones.
  assert.equal(startOfDay(2026, 10, 18, NEW_YORK).toISOString(), '2026-10-18T04:00:00.000Z');
  assert.equal(startOfDay(2026, 10, 18, JERUSALEM).toISOString(), '2026-10-17T21:00:00.000Z');
  assert.equal(startOfDay(2026, 10, 18, 'UTC').toISOString(), '2026-10-18T00:00:00.000Z');
});

test('a daylight-saving day in New York is 23 hours long', () => {
  // The clocks move forward on 2026-03-08. Midnight of the next day is one hour sooner.
  const before = startOfDay(2026, 3, 8, NEW_YORK); // still standard time
  const after = startOfDay(2026, 3, 9, NEW_YORK); // daylight time
  assert.equal(before.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(after.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal((after - before) / 3600000, 23);
});

test('"today" depends on the zone: two zones at one instant give different days', () => {
  const now = new Date('2026-10-18T02:00:00.000Z');
  // In Los Angeles it is still 2026-10-17. In Auckland it is already 2026-10-18.
  const la = dateRange('today', '', '', 'America/Los_Angeles', now)[0];
  const auckland = dateRange('today', '', '', 'Pacific/Auckland', now)[0];
  assert.equal(la.toISOString(), '2026-10-17T07:00:00.000Z');
  assert.equal(auckland.toISOString(), '2026-10-17T11:00:00.000Z');
});

test('a custom range uses the zone of the user, and the end day is included', () => {
  const [start, end] = dateRange('custom', '2026-10-18', '2026-10-18', NEW_YORK);
  assert.equal(start.toISOString(), '2026-10-18T04:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-19T04:00:00.000Z');
});

test('a bookmark is matched by its local day, not by its UTC day', async () => {
  // 04:30 UTC on 2026-10-18 is 00:30 on 2026-10-18 in New York. 03:30 UTC is still 2026-10-17 there.
  const svc = fakeService([
    item(1, '2026-10-18T04:30:00.000Z'),
    item(2, '2026-10-18T03:30:00.000Z'),
  ]);
  const result = await search(svc, USER, { preset: 'custom', from: '2026-10-18', to: '2026-10-18', tz: NEW_YORK });
  assert.deepEqual(result.results.map((r) => r.id), [1]);
});

test('a missing zone means UTC', async () => {
  const svc = fakeService([item(1, '2026-10-18T04:30:00.000Z'), item(2, '2026-10-17T23:30:00.000Z')]);
  const withNone = await search(svc, USER, { preset: 'custom', from: '2026-10-18', to: '2026-10-18' });
  const withUtc = await search(svc, USER, { preset: 'custom', from: '2026-10-18', to: '2026-10-18', tz: 'UTC' });
  assert.deepEqual(withNone.results.map((r) => r.id), [1]);
  assert.deepEqual(withNone.results.map((r) => r.id), withUtc.results.map((r) => r.id));
});

test('the preset counts use the zone of the request', async () => {
  const now = Date.now();
  const svc = fakeService([item(1, new Date(now - 60000).toISOString())]);
  const counts = (await meta(svc, USER, 'Pacific/Kiritimati')).presets;
  assert.equal(counts.all, 1);
  assert.equal(counts.today, 1);
});

test('an unknown zone is refused before the bookmarks load', async () => {
  const cold = { cache: new Map(), store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() } };
  await refused(search(cold, USER, { preset: 'today', tz: 'Mars/Olympus' }), /Unknown time zone: Mars\/Olympus/);
  await refused(meta(cold, USER, 'Mars/Olympus'), /Unknown time zone/);
  assert.throws(() => zoneOf('Nowhere/Land'), RequestError);
});

test('a date that is not YYYY-MM-DD is refused before the bookmarks load', async () => {
  const cold = { cache: new Map(), store: { keptDuplicates: () => [], newItems: () => new Set(), visits: () => new Map() } };
  await refused(search(cold, USER, { preset: 'custom', from: '18/10/2026' }), /must look like 2026-10-18/);
  await refused(search(cold, USER, { preset: 'custom', to: '2026-02-30' }), /must look like 2026-10-18/);
});

const SANTIAGO = 'America/Santiago';

test('a day whose midnight is skipped starts at its first valid instant', () => {
  // On 2026-09-06 the clocks jump from 00:00 to 01:00 in Santiago. The day starts at 04:00 UTC.
  assert.equal(startOfDay(2026, 9, 6, SANTIAGO).toISOString(), '2026-09-06T04:00:00.000Z');
  // The day before and the day after are normal.
  assert.equal(startOfDay(2026, 9, 5, SANTIAGO).toISOString(), '2026-09-05T04:00:00.000Z');
  assert.equal(startOfDay(2026, 9, 7, SANTIAGO).toISOString(), '2026-09-07T03:00:00.000Z');
});

test('the day with a skipped midnight is 23 hours long', () => {
  const start = startOfDay(2026, 9, 6, SANTIAGO);
  const next = startOfDay(2026, 9, 7, SANTIAGO);
  assert.equal((next - start) / 3600000, 23);
});

test('a custom filter on the day with a skipped midnight does not take the day before', async () => {
  const svc = fakeService([
    item(1, '2026-09-06T03:30:00.000Z'), // 23:30 on 2026-09-05 in Santiago, before the clocks move
    item(2, '2026-09-06T04:30:00.000Z'), // 01:30 on 2026-09-06 in Santiago
  ]);
  const result = await search(svc, USER, { preset: 'custom', from: '2026-09-06', to: '2026-09-06', tz: SANTIAGO });
  assert.deepEqual(result.results.map((r) => r.id), [2]);
});

test('the day of a clock change back in New York starts at midnight', () => {
  // On 2026-11-01 the clocks go back at 02:00. Midnight is still on daylight time, at 04:00 UTC.
  assert.equal(startOfDay(2026, 11, 1, NEW_YORK).toISOString(), '2026-11-01T04:00:00.000Z');
});
