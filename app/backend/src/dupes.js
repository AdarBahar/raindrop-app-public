import { createHash } from 'node:crypto';

// Duplicate links. Each link gets two keys, and the app never changes the link itself.
//
// - The definite key: two links with the same definite key point to the same page.
//   It removes only what cannot change the page: tracking parameters, the host case, a default port,
//   a plain fragment, the order of the parameter names, and the escapes of letters and digits.
// - The possible key: the definite key with more removed. Two links with the same possible key, but a
//   different definite key, are possibly the same page. A person must decide.
//   For most sites it also removes http or https, "www." and a "/" at the end.
//
// Site rules (SITES) can make other keys. A site rule only removes what is safe for that site.
// For example, a YouTube link gives the video ID, and a link to an X post gives the post ID.
// Unknown query parameters always stay in both keys. A false match is worse than a missed match.
//
// The keys are computed in memory. There is no network call and no saved key. Only the groups that the
// user kept are saved (migrations/004_kept_duplicates.sql).

// Query parameters that only track the visit, on all sites. utm_* is matched with any case.
const TRACKING = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'srsltid', '_ga']);
function isTracking(name) {
  return /^utm_/i.test(name) || TRACKING.has(name.toLowerCase());
}

// Escapes of letters, digits and "-._~" become the plain character. Other escapes get capital hex digits.
// So "/%7Euser" and "/~user" give one key, and "%2f" and "%2F" give one key.
function normalEscapes(text) {
  return text.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  });
}

// The query without the parameters in `drop`. The names are sorted. Repeated names keep the order of
// their values (URLSearchParams.sort() is stable). "?a" and "?a=" give the same text.
function queryText(params, drop = () => false) {
  const kept = new URLSearchParams([...params].filter(([name]) => !isTracking(name) && !drop(name)));
  kept.sort();
  const text = kept.toString();
  return text ? `?${text}` : '';
}

// Site rules. Each rule has `hosts` (without "www.") and `keys(url, host)`. keys() returns
// { definite, possible, note } or null. Null means that the general rules apply.
// To add a site, add a rule here. The general code does not change.
const SITES = [
  {
    name: 'YouTube',
    hosts: ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    keys(url, host) {
      const id = youtubeId(url, host);
      if (!id) return null;
      // These parameters do not change the video: the channel name, the share source, the start time.
      const ignored = new Set(['v', 'ab_channel', 'feature', 'si', 'pp', 't']);
      const rest = queryText(url.searchParams, (name) => ignored.has(name));
      return {
        // The playlist and any unknown parameter stay in the definite key.
        definite: `youtube:${id}${rest}`,
        // The same video in another playlist, or with no playlist, is possibly the same bookmark.
        possible: `youtube:${id}`,
        note: 'YouTube video',
        why: 'the same YouTube video, but in another playlist or with other parameters',
      };
    },
  },
  {
    name: 'X',
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
    keys(url) {
      // A post ID is unique on all of X. The user name in the link can change, so it is not in the key.
      const m = /^\/(?:[^/]+\/status(?:es)?|i(?:\/web)?\/status)\/(\d+)\/?$/.exec(url.pathname);
      if (!m) return null;
      // "s", "t", "ref_src" and "ref_url" only show where the link was shared.
      const rest = queryText(url.searchParams, (name) => ['s', 't', 'ref_src', 'ref_url'].includes(name));
      const key = `x:status/${m[1]}${rest}`;
      return { definite: key, possible: key, note: 'X post', why: '' };
    },
  },
  {
    name: 'GitHub',
    hosts: ['github.com'],
    keys(url) {
      const parts = url.pathname.split('/');
      if (parts.length < 3 || !parts[1] || !parts[2]) return null;
      // The owner and the repository names do not change with capital letters on GitHub. The rest of the path does.
      const path = normalEscapes(['', parts[1].toLowerCase(), parts[2].toLowerCase(), ...parts.slice(3)].join('/'));
      // "tab=readme-ov-file" on the repository page only selects the README tab.
      const root = parts.length === 3 || (parts.length === 4 && parts[3] === '');
      const query = queryText(url.searchParams, (name) => root && name === 'tab' && url.searchParams.getAll('tab').every((v) => v === 'readme-ov-file'));
      const definite = `${url.protocol}//github.com${path}${query}`;
      return {
        definite,
        possible: `github.com${path.replace(/\/+$/, '')}${query}`,
        note: root ? 'GitHub repository' : 'GitHub page',
        why: 'the links differ only in http or https, or in a "/" at the end',
      };
    },
  },
  {
    name: 'Google Docs',
    hosts: ['docs.google.com'],
    // The fragment selects a sheet tab ("#gid=…") or a heading, so it stays.
    keys: (url) => general(url, { keepHash: true }),
  },
];

function youtubeId(url, host) {
  const id = (text) => (/^[A-Za-z0-9_-]{6,}$/.test(text ?? '') ? text : null);
  if (host === 'youtu.be') return id(url.pathname.split('/')[1]);
  if (url.pathname === '/watch') return id(url.searchParams.get('v'));
  const m = /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(url.pathname);
  return m ? id(m[1]) : null;
}

// The general rules, for a site with no rule of its own.
function general(url, { keepHash = false } = {}) {
  const host = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : ''; // the URL parser already removes a default port
  const path = normalEscapes(url.pathname);
  const query = queryText(url.searchParams);
  // A plain fragment is a place on the page. A fragment that starts with "#/" or "#!" is a page of a
  // single-page site, so it stays.
  const hash = keepHash || /^#[/!]/.test(url.hash) ? normalEscapes(url.hash) : '';
  const definite = `${url.protocol}//${host}${port}${path}${query}${hash}`;
  const looseHost = host.replace(/^www\./, '');
  const loosePath = path.replace(/\/+$/, '');
  const possible = `${looseHost}${port}${loosePath}${query}${hash}`;
  return { definite, possible, note: '', why: 'the links differ only in http or https, "www." or a "/" at the end' };
}

// The two keys of a link, a short note on the kind of link, and `why`: the reason for a possible match.
// A link that is empty gives null.
// A link that is not an http or https URL gives a key from the trimmed text only.
export function linkKeys(link) {
  const text = String(link ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { definite: `text ${text}`, possible: `text ${text}`, note: 'not a web link', why: '' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { definite: `text ${text}`, possible: `text ${text}`, note: 'not a web link', why: '' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const site = SITES.find((s) => s.hosts.includes(host));
  return site?.keys(url, host) ?? general(url);
}

// How two links compare: 'definite', 'possible' or 'none'. The tests use it. The list uses the keys.
export function compareLinks(a, b) {
  const ka = linkKeys(a);
  const kb = linkKeys(b);
  if (!ka || !kb) return 'none';
  if (ka.definite === kb.definite) return 'definite';
  if (ka.possible === kb.possible) return 'possible';
  return 'none';
}

// The keys of one bookmark. A link never changes in this app, so the keys of each bookmark object are
// computed one time. A new load or a sync gives new objects.
const keyCache = new WeakMap();
function keysOf(item) {
  if (!keyCache.has(item)) keyCache.set(item, linkKeys(item.link));
  return keyCache.get(item);
}

// The ID of a group in the database: the SHA-256 of the section and the key. See kept_duplicates.
export function groupHash(section, key) {
  return createHash('sha256').update(`${section} ${key}`).digest('hex');
}

// The duplicate groups of all bookmarks, and the counts of each bookmark. One pass with hash maps.
//
// - A "definite" group: two or more bookmarks with the same definite key.
// - A "possible" group: two or more bookmarks with the same possible key and more than one definite key.
//   It holds all those bookmarks, also the ones that are in a definite group too.
// - `skip(item)` true: the bookmark is not in any group (for example, it is in the folder Archive).
// - `kept`: the groups that the user kept, as { hash, ids }. A kept group does not show while all its
//   bookmarks are in the kept IDs. A new bookmark with the same key makes the group show again.
// - A bookmark that the list has two times (a load page by page can do that) counts one time.
//
// Returns { groups, info }. `groups` is a list of { section, key, hash, ids, note, why }.
// `info` maps each bookmark ID to { definite, possible, dupes, maybe, note, why }: `dupes` is the number of
// other bookmarks in its shown definite group, and `maybe` is the number of the other bookmarks in its shown
// possible group that have a different definite key.
export function duplicateGroups(items, { skip = () => false, kept = [] } = {}) {
  const seen = new Set();
  const byDefinite = new Map();
  const byPossible = new Map();
  const keys = new Map();
  for (const item of items) {
    if (seen.has(item._id)) continue;
    seen.add(item._id);
    const k = skip(item) ? null : keysOf(item);
    keys.set(item._id, k);
    if (!k) continue;
    if (!byDefinite.has(k.definite)) byDefinite.set(k.definite, []);
    byDefinite.get(k.definite).push(item._id);
    if (!byPossible.has(k.possible)) byPossible.set(k.possible, []);
    byPossible.get(k.possible).push(item._id);
  }
  const keptIds = new Map(kept.map((g) => [g.hash, new Set(g.ids)]));
  const shown = (section, key, ids) => {
    const hash = groupHash(section, key);
    const ids0 = keptIds.get(hash);
    return ids0 && ids.every((id) => ids0.has(id)) ? null : hash;
  };

  const groups = [];
  const definiteShown = new Set();
  for (const [key, ids] of byDefinite) {
    if (ids.length < 2) continue;
    const hash = shown('definite', key, ids);
    if (!hash) continue;
    definiteShown.add(key);
    const k = keys.get(ids[0]);
    groups.push({ section: 'definite', key, hash, ids, note: k.note, why: '' });
  }
  const possibleShown = new Set();
  for (const [key, ids] of byPossible) {
    if (ids.length < 2) continue;
    if (new Set(ids.map((id) => keys.get(id).definite)).size < 2) continue;
    const hash = shown('possible', key, ids);
    if (!hash) continue;
    possibleShown.add(key);
    const k = keys.get(ids[0]);
    groups.push({ section: 'possible', key, hash, ids, note: k.note, why: k.why });
  }

  const info = new Map();
  for (const [id, k] of keys) {
    if (!k) {
      info.set(id, { definite: '', possible: '', dupes: 0, maybe: 0, note: '', why: '' });
      continue;
    }
    const same = byDefinite.get(k.definite).length;
    const dupes = definiteShown.has(k.definite) ? same - 1 : 0;
    // The other members of this definite group are not counted again as possible duplicates.
    const maybe = possibleShown.has(k.possible) ? byPossible.get(k.possible).length - same : 0;
    info.set(id, { definite: k.definite, possible: k.possible, dupes, maybe, note: k.note, why: maybe ? k.why : '' });
  }
  return { groups, info };
}
