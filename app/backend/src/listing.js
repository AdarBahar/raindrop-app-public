// The read side of the bookmarks: search, filters, folder and tag lists, duplicates and meta. See src/bookmarks.js.
import { config } from './config.js';
import { compareText, RequestError } from './util.js';
import { duplicateGroups } from './dupes.js';
import { checkSearchText, checkTagFilter } from './limits.js';
import { addDays, dateOf, parseDay, startOfDay, zoneOf } from './timezone.js';
import { loadAll } from './library.js';

// Name shown for a folder. A duplicate name also shows the folder ID, so the two can be told apart.
export function labelFor(c, id) {
  const name = c.collections.get(id);
  if (name === undefined) return '';
  const same = [...c.collections.values()].filter((n) => n === name).length;
  return same > 1 ? `${name} (#${id})` : name;
}

// The folders the model may choose from. Each one has a unique label, as the user sees it.
export function folderOptions(c) {
  return [...c.collections]
    .filter(([id, name]) => id !== -1 && name !== 'Unsorted' && name !== 'Trash')
    .map(([id]) => ({ id, label: labelFor(c, id) }))
    .sort((a, b) => compareText(a.label.toLowerCase(), b.label.toLowerCase()));
}

function countTags(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

export function tagVocab(c, limit = 80) {
  return [...countTags(c.items)].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag]) => tag);
}

// Start and end of a time filter, as instants. The end is exclusive. Null means no limit.
// Dates are days in the zone `zoneName`. The zone and the dates are checked first.
export function dateRange(preset, from = '', to = '', zoneName = '', now = new Date()) {
  const zone = zoneOf(zoneName);
  const today = dateOf(now, zone);
  const start = (days) => startOfDay(...addDays(today, days), zone);
  if (preset === 'today') return [start(0), null];
  if (preset === 'last7') return [start(-6), null];
  if (preset === 'last30') return [start(-29), null];
  if (preset === 'custom') {
    const first = from ? startOfDay(...parseDay(from), zone) : null;
    const last = to ? startOfDay(...addDays(parseDay(to), 1), zone) : null;
    return [first, last];
  }
  return [null, null];
}

// The start of each date preset in the zone, as instants. The date counts of the filters use them.
export function presetStarts(zoneName = '') {
  return {
    today: dateRange('today', '', '', zoneName)[0],
    last7: dateRange('last7', '', '', zoneName)[0],
    last30: dateRange('last30', '', '', zoneName)[0],
  };
}

// Checks the filter input and parses it: the search words, the tag filter and the date range.
// The checks run in this order: search text, tag filter, zone and dates. Nothing loads here.
export function parseFilter(params) {
  checkSearchText(params.q ?? '');
  const terms = (params.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const tags = [...new Set((params.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  checkTagFilter(tags);
  const [start, end] = dateRange(params.preset ?? '', params.from ?? '', params.to ?? '', params.tz ?? '');
  return { terms, tags, start, end };
}

// The folders named "Archive", in any case. A bookmark in one of them is not a duplicate: "Keep recent"
// moves the older copies there, and the group must then go away. The frontend uses the same name.
function archiveIds(c) {
  return new Set([...c.collections].filter(([, name]) => name.toLowerCase() === 'archive').map(([id]) => id));
}

// The duplicate groups and counts of all bookmarks of the user (src/dupes.js), without the bookmarks
// in Archive and without the groups that the user kept.
export async function duplicatesOf(svc, userId, c) {
  const archive = archiveIds(c);
  // A release can run before its migration on a development database. Without the
  // table, no group is kept, and the list still works. Other errors also keep the list working, but they
  // are logged. 42P01 is the Postgres code for a table that does not exist.
  let kept = [];
  try {
    kept = await svc.store.keptDuplicates(userId);
  } catch (err) {
    if (err?.code !== '42P01') console.error('Could not read the kept duplicate groups:', err?.message);
    kept = [];
  }
  return duplicateGroups(c.items, { skip: (item) => archive.has(item.collection?.$id), kept });
}

function sortResults(results, sort) {
  const created = (r) => Date.parse(r.created);
  const byCreated = (a, b) => created(a) - created(b);
  const sorters = {
    newest: (a, b) => byCreated(b, a),
    oldest: byCreated,
    az: (a, b) => compareText(a.title.toLowerCase(), b.title.toLowerCase()),
    za: (a, b) => compareText(b.title.toLowerCase(), a.title.toLowerCase()),
    visits: (a, b) => b.visits - a.visits || byCreated(a, b),
    folder: (a, b) => compareText(a.collection.toLowerCase(), b.collection.toLowerCase()) || byCreated(a, b),
  };
  results.sort(sorters[sort] ?? sorters.newest);
}

// The kinds of the status "needs". A bookmark with no folder and no tags is in all three.
const NEEDS_KINDS = new Set(['both', 'folder', 'tags']);

// Every bookmark that matches the filters, in sort order. Bulk actions use this list.
// With status "dupes", the list has the duplicate groups with at least one bookmark that matches the other
// filters, and all the bookmarks of those groups (see dupeView). It also returns the groups.
export async function matchAll(svc, userId, params) {
  // Check the input before the bookmarks load, so bad input never causes a Raindrop call.
  const { terms, tags: tagList, start, end } = parseFilter(params);
  const wantedTags = new Set(tagList);
  // The date counts for the other filters: each bookmark that passes all filters except the date adds to them.
  const starts = presetStarts(params.tz ?? '');
  const presets = { all: 0, today: 0, last7: 0, last30: 0 };
  // With status "needs", the kind of gap: "" (any), "both", "folder" or "tags". needsCounts has the count
  // of each kind with all the other filters on, the date too, so the switch above the list shows them.
  const needsKind = NEEDS_KINDS.has(params.needs) ? params.needs : '';
  const needsCounts = { any: 0, both: 0, folder: 0, tags: 0 };
  const c = await loadAll(svc, userId);
  const collection = params.collection ?? '';
  const newIds = await svc.store.newItems(userId);
  const visits = await svc.store.visits(userId);
  const dupes = await duplicatesOf(svc, userId, c);
  const results = [];
  const toResult = (item) => resultOf(c, item, newIds, visits, dupes.info, starts);

  for (const item of c.items) {
    const created = new Date(item.created);
    const colId = item.collection?.$id;
    if (collection && String(colId) !== collection) continue;

    const entry = visits.get(item._id);
    const count = entry?.count ?? 0;
    if (params.visited === 'yes' && count === 0) continue;
    if (params.visited === 'no' && count > 0) continue;

    const tags = item.tags ?? [];
    const isNew = newIds.has(item._id);
    const noFolder = colId === -1, noTags = tags.length === 0;
    if (params.status === 'new' && !isNew) continue;
    if (params.status === 'needs' && !noFolder && !noTags) continue;
    // The counts look at all bookmarks, in all folders, also when a filter hides them.
    const dup = dupes.info.get(item._id);
    if (params.status === 'dupes' && dup.dupes === 0 && dup.maybe === 0) continue;
    const lowerTags = new Set(tags.map((t) => t.toLowerCase()));
    if ([...wantedTags].some((t) => !lowerTags.has(t))) continue;

    const colName = c.collections.get(colId) ?? '';
    const haystack = [
      item.title ?? '', item.excerpt ?? '', item.note ?? '', item.link ?? '',
      item.domain ?? '', tags.join(' '), colName,
    ].join(' ').toLowerCase();
    if (terms.some((t) => !haystack.includes(t))) continue;

    const inDates = !(start && created < start) && !(end && created >= end);
    if (params.status === 'needs') {
      if (inDates) {
        needsCounts.any += 1;
        if (noFolder && noTags) needsCounts.both += 1;
        if (noFolder) needsCounts.folder += 1;
        if (noTags) needsCounts.tags += 1;
      }
      if (needsKind === 'both' && !(noFolder && noTags)) continue;
      if (needsKind === 'folder' && !noFolder) continue;
      if (needsKind === 'tags' && !noTags) continue;
    }

    presets.all += 1;
    for (const [name, from] of Object.entries(starts)) {
      if (created >= from) presets[name] += 1;
    }
    if (!inDates) continue;

    results.push(toResult(item));
  }

  if (params.status === 'dupes') return { total: c.items.length, presets, ...dupeView(c, results, dupes.groups, toResult) };
  sortResults(results, params.sort ?? 'newest');
  return { total: c.items.length, results, presets, ...(params.status === 'needs' ? { needsCounts } : {}) };
}

// One bookmark as the list shows it.
// The narrowest date preset that has the instant: 'today', 'last7' or 'last30'. Before all of them: 'older'.
// The list shows it as a label on each result of a text search, because that search shows all dates.
function periodOf(created, starts) {
  return ['today', 'last7', 'last30'].find((name) => created >= starts[name]) ?? 'older';
}

function resultOf(c, item, newIds, visits, info, starts) {
  const colId = item.collection?.$id;
  const tags = item.tags ?? [];
  const entry = visits.get(item._id);
  const isNew = newIds.has(item._id);
  const dup = info.get(item._id);
  return {
    id: item._id,
    title: item.title || item.link || '',
    link: item.link ?? '',
    domain: item.domain ?? '',
    tags,
    created: item.created,
    period: periodOf(new Date(item.created), starts),
    collection: labelFor(c, colId) || String(colId),
    collection_id: colId,
    excerpt: (item.excerpt ?? '').slice(0, 200),
    visits: entry?.count ?? 0,
    last_visit: entry?.last ?? null,
    is_new: isNew,
    needs: colId === -1 || tags.length === 0,
    dupes: dup.dupes,
    maybe_dupes: dup.maybe,
    url_key: dup.definite,
    loose_key: dup.possible,
    dupe_note: dup.note,
    maybe_why: dup.why,
  };
}

// The duplicate view. A group shows when at least one of its bookmarks matches the filters, and then it
// shows all its bookmarks, because "Keep recent" acts on the whole group.
// The definite groups come first, then the possible groups. In each section, the group with the newest
// bookmark comes first. In each group, the newest bookmark comes first: "Keep recent" keeps it.
// A bookmark can be in a definite group and in a possible group. `results` has it one time. The page shows
// it one time too, in its first group.
function dupeView(c, matched, groups, toResult) {
  const matchedIds = new Set(matched.map((r) => r.id));
  const byId = new Map(c.items.map((item) => [item._id, item]));
  const time = (id) => Date.parse(byId.get(id).created) || 0;
  const shown = groups
    .filter((g) => g.ids.some((id) => matchedIds.has(id)))
    .map((g) => ({ ...g, ids: [...g.ids].sort((a, b) => time(b) - time(a)) }))
    .sort((a, b) => (a.section === b.section ? 0 : a.section === 'definite' ? -1 : 1) || time(b.ids[0]) - time(a.ids[0]));
  const results = [];
  const listed = new Set();
  for (const g of shown) {
    for (const id of g.ids) {
      if (listed.has(id)) continue;
      listed.add(id);
      results.push(toResult(byId.get(id)));
    }
  }
  return { results, groups: shown.map(({ section, key, ids, note, why }) => ({ section, key, ids, note, why })) };
}

// One page of the matching bookmarks. Pages start at 1. A page past the end is empty.
export async function search(svc, userId, params) {
  const pageSize = pageSizeOf(params.pageSize);
  const page = pageOf(params.page);
  const { total, results, presets, groups, needsCounts } = await matchAll(svc, userId, params);
  // The duplicate view has no pages, so a group is never split. The groups are few.
  if (groups) return { total, matched: results.length, presets, page: 1, pageSize, pages: 1, results, groups };
  const start = (page - 1) * pageSize;
  return {
    total,
    matched: results.length,
    // The date counts with the other filters on. /api/meta has the counts with no filter.
    presets,
    ...(needsCounts ? { needsCounts } : {}),
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(results.length / pageSize)),
    results: results.slice(start, start + pageSize),
  };
}

// The page size from the query. Missing means the default. Other values are refused.
function pageSizeOf(text) {
  if (text === undefined || text === '') return config.listPageDefault;
  const size = Number(text);
  if (!config.listPageSizes.includes(size)) {
    throw new RequestError(400, `The page size must be ${config.listPageSizes.join(', ')}.`);
  }
  return size;
}

// The page number from the query. Missing means page 1. Other values are refused.
function pageOf(text) {
  if (text === undefined || text === '') return 1;
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new RequestError(400, 'The page must be a whole number from 1.');
  return Number(text);
}

// Folders, tags and counts for the filters. Counts ignore the other filters.
export async function meta(svc, userId, zoneName = '') {
  // The zone is checked before the bookmarks load.
  const zone = zoneOf(zoneName);
  const c = await loadAll(svc, userId);
  const starts = presetStarts(zone);
  const presets = { all: c.items.length, today: 0, last7: 0, last30: 0 };
  const folderCounts = new Map();
  for (const item of c.items) {
    const key = String(item.collection?.$id);
    folderCounts.set(key, (folderCounts.get(key) ?? 0) + 1);
    const created = new Date(item.created);
    for (const [name, start] of Object.entries(starts)) {
      if (created >= start) presets[name] += 1;
    }
  }
  const tags = [...countTags(c.items)]
    .sort((a, b) => b[1] - a[1] || compareText(a[0].toLowerCase(), b[0].toLowerCase()))
    .slice(0, 200);
  const collections = [...c.collections]
    .sort((a, b) => compareText(a[1].toLowerCase(), b[1].toLowerCase()))
    .map(([id, name]) => ({
      id: String(id),
      name,
      label: labelFor(c, id),
      count: folderCounts.get(String(id)) ?? 0,
    }));
  return {
    tags: tags.map(([name, count]) => ({ name, count })),
    collections,
    presets,
  };
}
