// A local page to label the set of scripts/suggest-eval.mjs (docs/profile-plan.md, section 9).
//
//   node scripts/suggest-label.mjs <set.json> [port]
//
// It serves one page on 127.0.0.1 only. The page shows each bookmark of the set with a folder select.
// A change of a select writes "rightFolder" of that bookmark into the set file at once.
// When the set has a "profile", the page also has a box for each entry. It writes "rightEntries" and "unclear".
// A bookmark with a "recheck" text in the set shows that text, and the button "Examine again" lists these bookmarks.
// The script makes no call to Raindrop, to the model or to another host. Stop it with Ctrl+C.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const setPath = process.argv[2];
const port = Number(process.argv[3] ?? 8130);
if (!setPath) {
  console.error('Usage: node scripts/suggest-label.mjs <set.json> [port]');
  process.exit(2);
}
const read = () => JSON.parse(readFileSync(setPath, 'utf8'));
// The label of a folder, as the app shows it: a name that two folders have also shows the folder ID.
function labelsOf(set) {
  // A folder that the set lists two times is one folder.
  const byId = new Map(set.folders);
  const count = new Map();
  for (const name of byId.values()) count.set(name, (count.get(name) ?? 0) + 1);
  return new Map([...byId].map(([id, name]) => [id, count.get(name) > 1 ? `${name} (#${id})` : name]));
}

// The set for the page. folderLabels: the labels to select from. currentFolder comes from "collection". -1 is Unsorted.
function forPage() {
  const set = read();
  const labels = labelsOf(set);
  for (const b of set.bookmarks) b.currentFolder = b.collection === -1 ? 'Unsorted' : labels.get(b.collection) ?? `Folder #${b.collection}`;
  // The entries that can give a profile tag: active, with a tag. Empty when the set has no profile.
  const entries = (set.profile ?? []).filter((e) => e.active && e.tag && e.kind !== 'about').map((e) => ({ id: e.id, name: e.name, tag: e.tag, description: e.description }));
  return { folderLabels: [...labels.values()], entries, bookmarks: set.bookmarks };
}
const origin = `http://127.0.0.1:${port}`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label the bookmarks</title>
<style>
  :root { --bg: #f6f7f5; --surface: #fff; --line: #c9cfc9; --text: #1b211d; --muted: #5a645d; --accent: #0b6b4f; --warn: #8a5300; --mark: #e4f3ec; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101614; --surface: #18201d; --line: #45504a; --text: #e8ede9; --muted: #a3ada6; --accent: #6fd3ae; --warn: #f0b860; --mark: #1d3029; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; }
  header .in, main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { margin: 0 0 8px; color: var(--muted); }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .bar button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; }
  .bar button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  #state { margin-left: auto; color: var(--muted); font-size: 13px; }
  #state.err { color: var(--warn); font-weight: 600; }
  main { padding: 12px 16px 60px; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  li { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 6px; }
  li.changed { background: var(--mark); border-color: var(--accent); }
  li.open { border-color: var(--warn); }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .title a { color: inherit; }
  .meta, .text { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  label { font-size: 13px; color: var(--muted); }
  select { font: inherit; font-size: 16px; padding: 6px 8px; min-height: 36px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); max-width: 100%; }
  .row button { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; }
  .tag { font-size: 12px; font-weight: 600; }
  .tag.changed { color: var(--accent); }
  .tag.open { color: var(--warn); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .empty { color: var(--muted); padding: 24px 0; text-align: center; border: 0; background: none; }
  .recheck { margin: 6px 0 0; font-size: 13px; color: var(--warn); }
  fieldset.entries { margin: 4px 0 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; display: flex; flex-wrap: wrap; gap: 6px 16px; }
  fieldset.entries.open { border-color: var(--warn); }
  fieldset.entries legend { font-size: 13px; color: var(--muted); padding: 0 4px; }
  label.check { font-size: 14px; color: var(--text); display: inline-flex; gap: 6px; align-items: center; min-height: 28px; }
</style>
</head>
<body>
<header><div class="in">
  <h1>Label the bookmarks</h1>
  <p>For each bookmark, select the folder where it belongs. A bookmark that is in the right folder needs no change. When the set has a profile, also select the entries that fit, or "No entry fits". Each change is saved at once.</p>
  <div class="bar">
    <button type="button" data-show="all" aria-pressed="true">All</button>
    <button type="button" data-show="open" aria-pressed="false">No label</button>
    <button type="button" data-show="changed" aria-pressed="false">Changed</button>
    <button type="button" data-show="noentry" aria-pressed="false" hidden>No entry label</button>
    <button type="button" data-show="recheck" aria-pressed="false" hidden>Examine again</button>
    <span id="state" role="status"></span>
  </div>
</div></header>
<main><ol id="list"></ol></main>
<script>
let set = null, show = 'all';
const state = document.getElementById('state'), list = document.getElementById('list');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function counts() {
  const open = set.bookmarks.filter(b => !b.rightFolder).length;
  const changed = set.bookmarks.filter(b => b.rightFolder && b.rightFolder !== b.currentFolder).length;
  const noentry = set.bookmarks.filter(b => !Array.isArray(b.rightEntries)).length;
  // "recheck" is a text that a person wrote into the set: why the bookmark needs a second look.
  const recheck = set.bookmarks.filter(b => b.recheck).length;
  for (const b of document.querySelectorAll('[data-show]')) {
    const n = {all: set.bookmarks.length, open, changed, noentry, recheck}[b.dataset.show];
    b.textContent = {all: 'All', open: 'No folder label', changed: 'Folder changed', noentry: 'No entry label', recheck: 'Examine again'}[b.dataset.show] + ' (' + n + ')';
    if (b.dataset.show === 'noentry') b.hidden = !set.entries.length;
    if (b.dataset.show === 'recheck') b.hidden = !recheck;
  }
}

function mark(li, b) {
  const changed = Boolean(b.rightFolder) && b.rightFolder !== b.currentFolder;
  li.classList.toggle('changed', changed);
  li.classList.toggle('open', !b.rightFolder);
  const tag = li.querySelector('.tag');
  tag.className = 'tag' + (changed ? ' changed' : !b.rightFolder ? ' open' : '');
  tag.textContent = changed ? 'Changed' : !b.rightFolder ? 'No label' : '';
  li.querySelector('[data-same]').hidden = b.rightFolder === b.currentFolder || b.currentFolder === 'Unsorted';
}

// Save the entry labels of one bookmark. patch: {rightEntries} or {unclear}. On a failure, the page loads the set again.
async function saveEntries(b, patch) {
  Object.assign(b, patch);
  if (patch.rightEntries === null) delete b.rightEntries;
  counts();
  state.className = ''; state.textContent = 'Saving...';
  try {
    const r = await fetch('/label', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: b._id, ...patch})});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The server answered with ' + r.status + '.');
    state.textContent = 'Saved.';
  } catch (err) {
    state.className = 'err'; state.textContent = 'Not saved: ' + err.message + ' Make sure that the script still runs. The page shows the saved labels again.';
    set = await fetch('/set').then(r => r.json()).catch(() => set);
    render();
  }
}

// The entry labels of one bookmark: one box for each entry, "No entry fits", and "Not a clear case".
function entryBox(b) {
  const box = el('fieldset', 'entries');
  box.append(el('legend', '', 'Entries of your profile that fit this bookmark'));
  const mark = () => box.classList.toggle('open', !Array.isArray(b.rightEntries));
  const boxes = [];
  const add = (text, title, checked, onChange) => {
    const label = el('label', 'check'), input = el('input');
    input.type = 'checkbox'; input.checked = checked; if (title) label.title = title;
    input.addEventListener('change', () => { onChange(input); mark(); });
    label.append(input, ' ' + text); box.append(label);
    return input;
  };
  const chosen = () => boxes.filter(x => x.input.checked).map(x => x.id);
  for (const e of set.entries) {
    const input = add(e.name + ' (' + e.tag + ')', e.description, Array.isArray(b.rightEntries) && b.rightEntries.includes(e.id), () => {
      none.checked = false;
      const ids = chosen();
      saveEntries(b, {rightEntries: ids.length ? ids : null});
    });
    boxes.push({id: e.id, input});
  }
  const none = add('No entry fits', '', Array.isArray(b.rightEntries) && b.rightEntries.length === 0, input => {
    for (const x of boxes) x.input.checked = false;
    saveEntries(b, {rightEntries: input.checked ? [] : null});
  });
  add('Not a clear case (not scored)', 'Use this when a careful person could decide for or against the entry.', b.unclear === true, input => saveEntries(b, {unclear: input.checked}));
  mark();
  return box;
}

async function save(b, value, li, select) {
  const before = b.rightFolder;
  b.rightFolder = value; mark(li, b); counts();
  state.className = ''; state.textContent = 'Saving...';
  try {
    const r = await fetch('/label', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: b._id, rightFolder: value})});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The server answered with ' + r.status + '.');
    state.textContent = 'Saved.';
  } catch (err) {
    b.rightFolder = before; select.value = before; mark(li, b); counts();
    state.className = 'err'; state.textContent = 'Not saved: ' + err.message + ' Make sure that the script still runs, then select the folder again.';
  }
}

function render() {
  list.textContent = '';
  const names = [...set.folderLabels].sort((a, b) => a.localeCompare(b));
  let n = 0;
  set.bookmarks.forEach((b, i) => {
    const changed = b.rightFolder && b.rightFolder !== b.currentFolder;
    if (show === 'open' && b.rightFolder) return;
    if (show === 'changed' && !changed) return;
    if (show === 'noentry' && Array.isArray(b.rightEntries)) return;
    if (show === 'recheck' && !b.recheck) return;
    n += 1;
    const li = el('li');
    const title = el('div', 'title');
    const text = (i + 1) + '. ' + (b.title || '(no title)');
    if (/^https?:\\/\\//.test(b.link)) {
      const a = el('a', '', text); a.href = b.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; title.append(a);
    } else title.textContent = text;
    li.append(title, el('div', 'meta', b.link));
    if (b.excerpt || b.note) li.append(el('div', 'text', [b.note, b.excerpt].filter(Boolean).join(' | ').slice(0, 260)));
    li.append(el('div', 'meta', 'Current folder: ' + b.currentFolder + (b.tags.length ? '. Tags: ' + b.tags.join(', ') : '. No tags.')));
    const row = el('div', 'row');
    const label = el('label', '', 'Right folder'); label.htmlFor = 'f' + b._id;
    const select = el('select'); select.id = 'f' + b._id;
    select.append(new Option('(no label)', ''));
    for (const name of names) select.append(new Option(name === b.currentFolder ? name + ' (current)' : name, name));
    select.value = b.rightFolder || '';
    select.addEventListener('change', () => save(b, select.value, li, select));
    const same = el('button', '', 'Back to the current folder'); same.type = 'button'; same.dataset.same = '1';
    same.addEventListener('click', () => { select.value = b.currentFolder; save(b, b.currentFolder, li, select); });
    row.append(label, select, same, el('span', 'tag'));
    li.append(row);
    if (b.recheck) li.append(el('div', 'recheck', 'Examine again: ' + b.recheck));
    if (set.entries.length) li.append(entryBox(b));
    mark(li, b);
    list.append(li);
  });
  if (!n) list.append(el('li', 'empty', {open: 'Each bookmark has a folder label.', changed: 'No bookmark with a changed folder.', noentry: 'Each bookmark has an entry label.', recheck: 'No bookmark to examine again.'}[show] || 'The set has no bookmarks.'));
  counts();
}

for (const b of document.querySelectorAll('[data-show]')) b.addEventListener('click', () => {
  show = b.dataset.show;
  for (const x of document.querySelectorAll('[data-show]')) x.setAttribute('aria-pressed', String(x === b));
  render();
});

fetch('/set').then(r => r.json()).then(d => { set = d; render(); })
  .catch(() => { state.className = 'err'; state.textContent = 'The set did not load. Make sure that the script runs, then load the page again.'; });
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  // Only a browser on this page can talk to the script. A different site cannot read or change the set.
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Open the page as ' + origin });
  try {
    if (req.method === 'GET' && req.url === '/') return send(200, PAGE, 'text/html');
    if (req.method === 'GET' && req.url === '/set') return send(200, forPage());
    if (req.method === 'POST' && req.url === '/label') {
      if (req.headers.origin !== origin) return send(403, { error: 'The request came from a different page.' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10000) return send(400, { error: 'The request is too large.' });
      }
      const { id, rightFolder, rightEntries, unclear } = JSON.parse(raw);
      const set = read();
      const bookmark = set.bookmarks.find((b) => b._id === id);
      if (!bookmark) return send(404, { error: 'The bookmark is not in the set.' });
      // One request changes the folder label, or the entry labels of the bookmark.
      if (rightFolder !== undefined) {
        if (rightFolder !== '' && ![...labelsOf(set).values()].includes(rightFolder)) return send(400, { error: 'The folder is not in the set.' });
        bookmark.rightFolder = rightFolder;
      }
      if (rightEntries !== undefined) {
        // null: not labeled. A list: the entries that fit. An empty list: no entry fits.
        const ids = new Set((set.profile ?? []).map((e) => e.id));
        if (rightEntries !== null && !(Array.isArray(rightEntries) && rightEntries.every((e) => ids.has(e)))) return send(400, { error: 'An entry is not in the profile of the set.' });
        if (rightEntries === null) delete bookmark.rightEntries; else bookmark.rightEntries = [...new Set(rightEntries)];
      }
      if (unclear !== undefined) {
        if (unclear === true) bookmark.unclear = true; else delete bookmark.unclear;
      }
      // Write a full file, then put it in place, so a stop in the middle leaves the old file.
      writeFileSync(`${setPath}.tmp`, JSON.stringify(set, null, 1));
      renameSync(`${setPath}.tmp`, setPath);
      return send(200, { ok: true });
    }
    send(404, { error: 'Not found.' });
  } catch (err) {
    send(500, { error: err.message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Label page: ${origin}  (Ctrl+C stops it)`));
