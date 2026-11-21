import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, folderOptions, keepDuplicates, meta, search } from '../src/bookmarks.js';

// These tests build dates in the machine's own zone. The app uses the zone in the request.
const LOCAL = Intl.DateTimeFormat().resolvedOptions().timeZone;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// A cache that is always fresh, so no Raindrop call is made.
function fakeService(items, collections, { newIds = [], visits = [] } = {}) {
  const svc = {
    cache: new Map(),
    store: {
      keptDuplicates: () => [], newItems: () => new Set(newIds),
      visits: () => new Map(visits),
    },
  };
  svc.cache.set('u', {
    at: Date.now(),
    items,
    collections: new Map(collections),
    progress: { loaded: 0, total: 0 },
    loading: null,
  });
  return svc;
}

const collections = [[-1, 'Unsorted'], [10, 'AI & LLMs'], [20, 'Business']];
const items = [
  { _id: 1, title: 'Fresh AI post', link: 'https://a.example/1', domain: 'a.example', tags: ['ai'], collection: { $id: 10 }, created: new Date(Date.now() - HOUR).toISOString() },
  { _id: 2, title: 'Old business note', link: 'https://b.example/2', domain: 'b.example', tags: [], collection: { $id: 20 }, created: new Date(Date.now() - 10 * DAY).toISOString() },
  { _id: 3, title: 'Unsorted link', link: 'https://c.example/3', domain: 'c.example', tags: ['misc'], collection: { $id: -1 }, created: new Date(Date.now() - 3 * DAY).toISOString() },
];

test('time presets count only bookmarks in range', async () => {
  const svc = fakeService(items, collections);
  const counts = (await meta(svc, 'u', LOCAL)).presets;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const createdToday = items.filter((i) => new Date(i.created) >= midnight).length;
  assert.equal(counts.all, 3);
  assert.equal(counts.today, createdToday); // computed from local midnight, not from the code under test
  assert.equal(counts.last7, 2); // the fresh post and the unsorted link
  assert.equal(counts.last30, 3);
});

test('folder counts come from the bookmarks in each folder', async () => {
  const svc = fakeService(items, collections);
  const { collections: cols } = await meta(svc, 'u', LOCAL);
  const byName = Object.fromEntries(cols.map((c) => [c.name, c.count]));
  assert.equal(byName['AI & LLMs'], 1);
  assert.equal(byName.Business, 1);
  assert.equal(byName.Unsorted, 1);
});

test('folder filter and text search combine', async () => {
  const svc = fakeService(items, collections);
  const result = await search(svc, 'u', { collection: '10', q: 'fresh' });
  assert.deepEqual(result.results.map((r) => r.id), [1]);
  assert.equal(result.total, 3);
  assert.equal(result.matched, 1);
});

test('status needs finds unsorted bookmarks and bookmarks without tags', async () => {
  const svc = fakeService(items, collections);
  const result = await search(svc, 'u', { status: 'needs' });
  assert.deepEqual(result.results.map((r) => r.id).sort(), [2, 3]);
});

test('status needs: the switch narrows to no folder and no tags, no folder, or no tags, and counts each kind', async () => {
  const gaps = [
    ...items,
    { _id: 4, title: 'Bare link', link: 'https://d.example/4', domain: 'd.example', tags: [], collection: { $id: -1 }, created: new Date(Date.now() - 2 * DAY).toISOString() },
  ];
  const svc = fakeService(gaps, collections);
  const ids = async (needs) => (await search(svc, 'u', { status: 'needs', needs })).results.map((r) => r.id).sort();
  // 2: a folder, no tags. 3: no folder, a tag. 4: no folder, no tags.
  assert.deepEqual(await ids(''), [2, 3, 4]);
  assert.deepEqual(await ids('both'), [4]);
  assert.deepEqual(await ids('folder'), [3, 4]);
  assert.deepEqual(await ids('tags'), [2, 4]);
  assert.deepEqual(await ids('other'), [2, 3, 4]); // an unknown kind means any
  // The counts do not depend on the chosen kind. They follow the other filters and the date.
  const all = await search(svc, 'u', { status: 'needs', needs: 'both' });
  assert.deepEqual(all.needsCounts, { any: 3, both: 1, folder: 2, tags: 2 });
  assert.equal(all.presets.all, 1);
  const week = await search(svc, 'u', { status: 'needs', preset: 'last7', tz: LOCAL });
  assert.deepEqual(week.needsCounts, { any: 2, both: 1, folder: 2, tags: 1 });
  // Without the status "needs", the answer has no counts and the kind is ignored.
  const plain = await search(svc, 'u', { needs: 'both' });
  assert.equal(plain.needsCounts, undefined);
  assert.equal(plain.matched, 4);
});

test('visits and new labels are read per user', async () => {
  const svc = fakeService(items, collections, { newIds: [2], visits: [[3, { count: 4, last: 'x' }]] });
  const visited = await search(svc, 'u', { visited: 'yes' });
  assert.deepEqual(visited.results.map((r) => r.id), [3]);
  const fresh = await search(svc, 'u', { status: 'new' });
  assert.deepEqual(fresh.results.map((r) => r.id), [2]);
});

test('most visited sort puts the highest count first', async () => {
  const svc = fakeService(items, collections, { visits: [[2, { count: 1, last: 'x' }], [3, { count: 5, last: 'y' }]] });
  const result = await search(svc, 'u', { sort: 'visits' });
  assert.equal(result.results[0].id, 3);
});

test('custom date range uses local dates and an exclusive end', () => {
  const [start, end] = dateRange('custom', '2026-01-10', '2026-01-12', LOCAL);
  assert.equal(start.getDate(), 10);
  assert.equal(end.getDate(), 13);
  assert.equal(end.getHours(), 0);
});

test('two folders with the same name get different labels and IDs', () => {
  const c = { collections: new Map([[-1, 'Unsorted'], [10, 'Work'], [20, 'Work'], [30, 'Home']]) };
  const options = folderOptions(c);
  assert.deepEqual(options.map((o) => o.label), ['Home', 'Work (#10)', 'Work (#20)']);
  assert.equal(options.find((o) => o.label === 'Work (#20)').id, 20);
});

test('search returns the date counts with the other filters on, and the date filter does not change them', async () => {
  const svc = fakeService(items, collections);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  // Folder 10 has only the fresh post (one hour old).
  const inFolder = (await search(svc, 'u', { collection: '10', tz: LOCAL })).presets;
  const freshToday = new Date(items[0].created) >= midnight ? 1 : 0;
  assert.deepEqual(inFolder, { all: 1, today: freshToday, last7: 1, last30: 1 });
  // The date preset filters the results, but the counts stay the same.
  const withDate = await search(svc, 'u', { collection: '10', preset: 'last7', tz: LOCAL });
  assert.deepEqual(withDate.presets, inFolder);
  // A tag filter: two bookmarks have no "misc" tag, so only the unsorted link counts.
  const tagged = (await search(svc, 'u', { tags: 'misc', tz: LOCAL })).presets;
  assert.equal(tagged.all, 1);
  assert.equal(tagged.last7, 1);
  // No filter: the counts are the same as in meta.
  assert.deepEqual((await search(svc, 'u', { tz: LOCAL })).presets, (await meta(svc, 'u', LOCAL)).presets);
});

const at = (h) => new Date(Date.now() - h * HOUR).toISOString();
const bm = (id, link, h, col = 10) => ({ _id: id, title: `B${id}`, link, tags: [], collection: { $id: col }, created: at(h) });

test('status dupes shows the definite groups first, then the possible groups, the newest first, with no pages', async () => {
  const list = [
    bm(1, 'https://x.example/a', 1),
    bm(2, 'https://y.example/b', 2),
    bm(3, 'http://www.x.example/a/?utm_medium=mail', 3, 20), // possible with 1
    bm(4, 'https://y.example/b#part', 0.5, -1), // definite with 2
    bm(5, 'https://z.example/', 4),
    bm(6, '', 5),
    bm(7, '', 6),
  ];
  const svc = fakeService(list, collections);
  const r = await search(svc, 'u', { status: 'dupes', preset: 'all', pageSize: '25' });
  assert.deepEqual(r.groups.map((g) => [g.section, g.ids]), [['definite', [4, 2]], ['possible', [1, 3]]]);
  assert.deepEqual(r.results.map((x) => x.id), [4, 2, 1, 3]);
  assert.equal(r.pages, 1);
  assert.match(r.groups[1].why, /http or https/);

  // A group shows when one of its bookmarks matches the filters. Then it shows all its bookmarks.
  const inFolder = await search(svc, 'u', { status: 'dupes', collection: '20', preset: 'all' });
  assert.deepEqual(inFolder.groups.map((g) => g.ids), [[1, 3]]);

  const plain = await search(svc, 'u', {});
  assert.deepEqual([5, 6].map((id) => plain.results.find((x) => x.id === id).dupes), [0, 0]);
});

test('a bookmark that a load returned two times is not its own duplicate', async () => {
  const one = bm(1, 'https://x.example/a', 0);
  const svc = fakeService([one, { ...one }], collections);
  const result = await search(svc, 'u', { preset: 'all' });
  assert.deepEqual(result.results.map((r) => r.dupes), [0, 0]);
  assert.equal((await search(svc, 'u', { status: 'dupes', preset: 'all' })).matched, 0);
});

test('a plain YouTube link and the same video in a playlist are a possible group', async () => {
  const list = [bm(1, 'https://youtube.com/watch?v=dxQbKwOPpMo', 1), bm(2, 'https://youtube.com/watch?v=dxQbKwOPpMo&list=PL1', 2, 20)];
  const svc = fakeService(list, collections);
  const r = await search(svc, 'u', { status: 'dupes', preset: 'all' });
  assert.deepEqual(r.groups.map((g) => [g.section, g.ids]), [['possible', [1, 2]]]);
  assert.deepEqual(r.results.map((x) => [x.id, x.dupes, x.maybe_dupes]), [[1, 0, 1], [2, 0, 1]]);
  assert.match(r.groups[0].why, /playlist/);
});

test('a bookmark in a definite group and in a possible group is listed one time', async () => {
  const list = [bm(1, 'https://a.example/x', 1), bm(2, 'https://b.example/', 2), bm(3, 'http://a.example/x', 3), bm(4, 'https://a.example/x?utm_source=y', 4)];
  const svc = fakeService(list, collections);
  const r = await search(svc, 'u', { status: 'dupes', preset: 'all' });
  assert.deepEqual(r.groups.map((g) => [g.section, g.ids]), [['definite', [1, 4]], ['possible', [1, 3, 4]]]);
  assert.deepEqual(r.results.map((x) => [x.id, x.dupes, x.maybe_dupes]), [[1, 1, 1], [4, 1, 1], [3, 0, 2]]);
});

test('bookmarks in a folder named Archive are not duplicates', async () => {
  const list = [bm(1, 'https://a.example/x', 1), bm(2, 'https://a.example/x', 2, 30), bm(3, 'https://a.example/x', 3, 31)];
  const svc = fakeService(list, [...collections, [30, 'Archive'], [31, 'archive']]);
  const r = await search(svc, 'u', { status: 'dupes', preset: 'all' });
  assert.deepEqual(r.groups, []);
  assert.equal((await search(svc, 'u', {})).results.find((x) => x.id === 1).dupes, 0);
});

test('a kept group does not show, and a new bookmark with the same URL shows it again', async () => {
  const list = [bm(1, 'https://a.example/x', 1), bm(2, 'https://a.example/x', 2)];
  const svc = fakeService(list, collections);
  const kept = [];
  svc.store.keptDuplicates = () => kept;
  svc.store.keepDuplicates = (u, hash, ids) => kept.push({ hash, ids });
  svc.store.unkeepDuplicates = (u, hash) => kept.splice(kept.findIndex((g) => g.hash === hash), 1);

  const [group] = (await search(svc, 'u', { status: 'dupes', preset: 'all' })).groups;
  await keepDuplicates(svc, 'u', group.section, group.key);
  assert.deepEqual(kept.map((g) => g.ids.sort()), [[1, 2]]);
  assert.deepEqual((await search(svc, 'u', { status: 'dupes', preset: 'all' })).groups, []);
  assert.equal((await search(svc, 'u', {})).results.find((x) => x.id === 1).dupes, 0); // no badge

  list.push(bm(3, 'https://a.example/x?utm_source=z', 0.5));
  const again = (await search(svc, 'u', { status: 'dupes', preset: 'all' })).groups;
  assert.deepEqual(again.map((g) => g.ids), [[3, 1, 2]]);

  // Undo shows the group again. A group that does not exist is refused.
  await keepDuplicates(svc, 'u', group.section, group.key, false);
  assert.equal(kept.length, 0);
  await assert.rejects(keepDuplicates(svc, 'u', 'definite', 'nothing'), /not found/);
  await assert.rejects(keepDuplicates(svc, 'u', 'other', group.key), /section/);
});

test('the list works when the kept_duplicates table is missing (a release before its migration)', async () => {
  const svc = fakeService([bm(1, 'https://a.example/x', 1), bm(2, 'https://a.example/x', 2)], collections);
  svc.store.keptDuplicates = async () => { throw Object.assign(new Error('relation "kept_duplicates" does not exist'), { code: '42P01' }); };
  assert.equal((await search(svc, 'u', {})).results.length, 2);
  assert.equal((await search(svc, 'u', { status: 'dupes', preset: 'all' })).groups.length, 1);
});

test('each result has the narrowest date preset that it belongs to', async () => {
  const old = { _id: 4, title: 'Very old link', link: 'https://d.example/4', domain: 'd.example', tags: ['x'], collection: { $id: 10 }, created: new Date(Date.now() - 60 * DAY).toISOString() };
  const svc = fakeService([...items, old], collections);
  const { results } = await search(svc, 'u', { tz: LOCAL });
  const period = Object.fromEntries(results.map((r) => [r.id, r.period]));
  assert.equal(period[3], 'last7'); // 3 days old
  assert.equal(period[2], 'last30'); // 10 days old
  assert.equal(period[4], 'older'); // 60 days old
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.equal(period[1], new Date(items[0].created) >= midnight ? 'today' : 'last7'); // 1 hour old
});
