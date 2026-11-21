// The page script, part 1 of 9: The state of the page, the small helpers and the API client.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

const $ = id => document.getElementById(id);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // the user's zone, for the date filters
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Filter state. Every change resets the page to 1 and clears the selection (section 2).
// The default date filter, on page load and after "Clear filters", is the first preset in this
// order with a count above zero. With no bookmarks at all, it is "All time".
const PRESET_ORDER = ['today', 'last7', 'last30', 'all'];
function defaultPresetOf(counts) {
  return PRESET_ORDER.find(p => counts[p] > 0) ?? 'all';
}
let defaultPreset = 'today'; // replaced by defaultPresetOf() when the counts load
let presetChosen = false;    // true after the user clicks a preset; false again after "Clear filters"
let preset = defaultPreset, folder = '', page = 1, pageSize = 50, timer = null;
let lastGroups = null; // the duplicate groups of the last list, with status "dupes"; else null
let keptGroup = null;  // the group of the last "Keep all", for its Undo
let lastResults = [], metaFolders = [], metaTags = [], runSeq = 0;
// The date counts with no filter (from /api/meta), and with the other filters on (from /api/bookmarks).
let metaPresets = {}, filteredPresets = null;
// With the status "Unsorted or no tags": the kind of gap ('' any, 'both', 'folder', 'tags'), and the count of each kind.
let needsKind = '', needsCounts = null;
let pageInfo = {matched: 0, total: 0, pages: 1};
let loaded = false;           // true after the first list answer
const editing = {};           // id -> {folderId, tags, busy, error, warn, creating, newName, confirmDiscard}
const suggesting = new Set(); // ids of bookmarks whose suggestion is still pending
const selected = new Map();   // id -> tags of each selected bookmark, kept across page changes
let allMatching = false;      // true after "Select all <n> matching bookmarks"
let lastSel = null;           // the last checkbox clicked, for Shift+click ranges
let allTags = false;          // the sidebar shows every tag, not only the first 12
const jobs = new Map();       // bulk jobs of this page, by id. Each one has its own poller and its own state.
let reviewId = null;         // the suggest job whose review is open
let reportId = null;         // the job whose "Show details" list is shown
let me = null;                // the answer of /api/me

// A toggle button shows its state with the "on" class and with aria-pressed.
function setOn(b, on) {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}

function ago(iso) {
  const created = new Date(iso), now = new Date();
  const minutes = Math.floor((now - created) / 60000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const sixMonths = new Date(now); sixMonths.setMonth(sixMonths.getMonth() - 6);
  if (created < sixMonths) return 'more than 6 months ago';
  if (minutes < 60) return plural(Math.max(minutes, 1), 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 21) return plural(days, 'day');
  return plural(Math.floor(days / 7), 'week');
}

// One colour for each folder. The bar of a bookmark and the folder name in the side list use the same hue.
// The hue comes from the position of the folder in the list. The golden angle keeps close positions far apart on the colour wheel.
// A folder that is not in the list yet gets a hue from a hash of its ID (FNV-1a).
function hue(key) {
  const i = metaFolders.findIndex(f => String(f.id) === String(key));
  if (i >= 0) return Math.round(i * 137.508) % 360;
  let h = 2166136261; for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (h >>> 8) % 360;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The tags in a comma-separated text, without spaces at the ends and without empty entries.
function splitTags(text) { return (text || '').split(',').map(t => t.trim()).filter(Boolean); }

const SIGN_IN_ENDED = 'Your sign-in ended. Reload the page to sign in again.';
function signInEnded() { const e = new Error(SIGN_IN_ENDED); e.signIn = true; return e; }

// One JSON request. A failed answer throws with the server's message. An answer that is not JSON
// (for example a proxy page) gives a plain message, not the parser's text.
async function api(url, {method = 'GET', body} = {}) {
  // redirect: 'manual' shows an ended sign-in. The gateway then answers with a redirect to its login page.
  const init = {method, headers: {}, redirect: 'manual'};
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let r;
  try {
    r = await fetch(url, init);
  } catch {
    throw new Error('The server could not be reached.');
  }
  if (r.type === 'opaqueredirect') throw signInEnded();
  let d = null;
  try { d = await r.json(); } catch { /* not JSON, handled below */ }
  if (!r.ok) {
    const err = new Error(d?.error || `The server answered with ${r.status}.`);
    err.status = r.status;
    err.connect = Boolean(d?.connect);
    err.tagExists = Boolean(d?.tagExists); // a profile tag that is already a Raindrop tag (context.js)
    throw err;
  }
  if (d === null) throw new Error('The server sent an answer that is not JSON.');
  return d;
}
function postJson(url, body) { return api(url, {method: 'POST', body}); }
