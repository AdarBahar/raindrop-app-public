// The footer text about the stored copy ("Synced 3 hours ago"). The rules are in docs/ui-elements.md, section 6.2.
// The page scripts run here in a sandbox, as the page loads them. No browser is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageScript } from './helpers/frontend.js';

const read = (name) => readFileSync(new URL(`../../frontend/${name}`, import.meta.url), 'utf8');
const datetime = read('datetime.js');
const app = pageScript();
const html = read('index.html');
const css = read('styles.css');

// The source of one function of the page script, from its first line to the closing brace at the start of a line.
const fn = (name) => {
  let start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page script has function ${name}`);
  if (app.slice(start - 6, start) === 'async ') start -= 6; // keep the word async
  return app.slice(start, app.indexOf('\n}\n', start) + 2);
};

const sandbox = {};
vm.runInNewContext(`${datetime}\n${fn('ago')}\nthis.syncedView = syncedView; this.ago = ago; this.localDateTime = localDateTime;`, sandbox);
const { syncedView, ago, localDateTime } = sandbox;

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

test('the stored copy is off: no field, no text', () => {
  assert.equal(syncedView({ user: 'a', connected: true }, ago), null);
  assert.equal(syncedView(null, ago), null);
});

test('no sync yet: "Not synced yet", with no time attribute', () => {
  const v = syncedView({ syncedAt: null, syncError: null }, ago);
  assert.deepEqual({ ...v }, { text: 'Not synced yet', datetime: '', title: '', warning: '' });
});

test('the text is "Synced " plus the age text of section 5.3', () => {
  const view = (m) => syncedView({ syncedAt: minutesAgo(m), syncError: null }, ago).text;
  assert.equal(view(0), 'Synced 1 minute ago', 'never shorter than 1 minute');
  assert.equal(view(1), 'Synced 1 minute ago');
  assert.equal(view(45), 'Synced 45 minutes ago');
  assert.equal(view(60), 'Synced 1 hour ago');
  assert.equal(view(3 * 60 + 20), 'Synced 3 hours ago');
  assert.equal(view(2 * 24 * 60), 'Synced 2 days ago');
});

test('the time attribute holds the ISO time, and the title holds the local date and time', () => {
  const iso = '2026-11-10T08:36:11.000Z';
  const v = syncedView({ syncedAt: iso, syncError: null }, () => '3 hours ago');
  assert.equal(v.datetime, iso);
  assert.equal(v.title, localDateTime(iso));
  assert.match(v.title, /^\d{1,2} \w{3} 2026, \d\d:\d\d$/);
});

test('a failed sync shows the fixed warning and never the text of the server error', () => {
  const secret = 'relation "bookmarks" does not exist at 10.0.0.5';
  const v = syncedView({ syncedAt: minutesAgo(5), syncError: secret }, ago);
  assert.equal(v.warning, 'The last sync failed. The data can be old.');
  assert.ok(!JSON.stringify(v).includes('bookmarks'));
  assert.equal(syncedView({ syncedAt: minutesAgo(5), syncError: null }, ago).warning, '');
  // A failed first sync: not synced yet, with the warning.
  assert.equal(syncedView({ syncedAt: null, syncError: secret }, ago).warning, 'The last sync failed. The data can be old.');
});

// showSynced() with fake footer elements.
function page(me) {
  const el = () => ({
    hidden: true, textContent: '', title: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'title') this.title = ''; },
  });
  const els = { syncedAt: el(), syncWarn: el() };
  const box = { me, ago, syncedView, $: (id) => els[id] };
  vm.runInNewContext(`${fn('showSynced')}\nthis.showSynced = showSynced;`, box);
  return { els, box };
}

test('showSynced shows the text, and the warning only when the sync failed', () => {
  const ok = page({ syncedAt: minutesAgo(180), syncError: null });
  ok.box.showSynced();
  assert.equal(ok.els.syncedAt.hidden, false);
  assert.equal(ok.els.syncedAt.textContent, 'Synced 3 hours ago');
  assert.ok(ok.els.syncedAt.attrs.datetime);
  assert.ok(ok.els.syncedAt.title);
  assert.equal(ok.els.syncWarn.hidden, true);

  const bad = page({ syncedAt: minutesAgo(180), syncError: 'x' });
  bad.box.showSynced();
  assert.equal(bad.els.syncWarn.hidden, false);
  assert.equal(bad.els.syncWarn.textContent, 'The last sync failed. The data can be old.');
});

test('showSynced hides both elements when the stored copy is off, and clears the attributes when never synced', () => {
  const off = page({ connected: true });
  off.els.syncedAt.hidden = false; off.els.syncWarn.hidden = false;
  off.box.showSynced();
  assert.equal(off.els.syncedAt.hidden, true);
  assert.equal(off.els.syncWarn.hidden, true);

  const none = page({ syncedAt: null, syncError: null });
  none.els.syncedAt.attrs.datetime = 'old'; none.els.syncedAt.title = 'old';
  none.box.showSynced();
  assert.equal(none.els.syncedAt.textContent, 'Not synced yet');
  assert.equal('datetime' in none.els.syncedAt.attrs, false);
  assert.equal(none.els.syncedAt.title, '');
});

test('the footer has the elements after "Last checked" and before the Raindrop link, hidden at the start', () => {
  const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  const order = ['id="lastChecked"', 'id="syncedAt"', 'id="syncWarn"', 'Open Raindrop'].map((s) => footer.indexOf(s));
  assert.ok(order.every((i) => i >= 0), 'all four are in the footer');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.match(footer, /<time id="syncedAt" hidden><\/time>/);
  assert.match(footer, /id="syncWarn" class="warn-text" hidden/);
});

test('no live region, as the specification says, and the phone footer is stacked', () => {
  const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  assert.doesNotMatch(footer, /aria-live|role="(status|alert)"/);
  assert.match(css, /@media \(max-width: 599px\) \{[\s\S]*?footer \{ flex-direction: column;/);
});

test('the page recomputes the age each minute and when the tab shows again, and boot shows the text', () => {
  assert.match(app, /setInterval\(\(\) => \{ if \(!document\.hidden && me\?\.connected\) showSynced\(\); \}, 60000\)/);
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.match(app, /\n  showSynced\(\);\n/, 'boot shows the text');
});

// --- The lifecycle: the real boot() and the real handler of "Check for new bookmarks", with fake page parts ---

// A fake server. `state` is what /api/me answers now. A test changes it while the page runs, as a sync does.
function lifecycle(state, hooks = {}) {
  const els = {};
  const el = (id) => (els[id] ??= {
    id, hidden: false, disabled: false, textContent: '', innerHTML: '', title: '', attrs: {}, style: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() {},
  });
  const requests = [];
  const box = {
    $: el, requests, state, location: { search: '' }, TZ: 'UTC',
    api: async (path) => {
      requests.push(path);
      if (path === '/api/me') return structuredClone(box.state);
      if (path === '/api/changes') return hooks.changes ?? { added: 0, more: false };
      throw new Error(`Unexpected request ${path}`);
    },
    postJson: async (path) => { requests.push(`POST ${path}`); if (hooks.pullFails) throw new Error('Raindrop failed'); return { message: 'Checked.' }; },
    refreshMeta: async () => { await hooks.duringLoad?.(box); },
    run: async () => {}, esc: (t) => t, showLoadProgress() {}, showGate() {}, connectAgain() {}, ago, syncedView, localDateTime,
    document: { hidden: false, addEventListener() {} }, setInterval() {},
  };
  const src = [
    'let me = null; let loading = true; let pulling = false; let quickAt = 0;',
    fn('showSynced'), fn('refreshSynced'), fn('boot'), fn('pullNow'), fn('quickCheck'),
    // The page script assigns the handler to $('pull').onclick in one line.
    /\$\('pull'\)\.onclick = [^\n]*\n/.exec(app)[0],
    'this.boot = boot; this.getMe = () => me;',
  ].join('\n');
  vm.runInNewContext(src, box);
  return { box, els, requests };
}
const ME = (over) => ({ user: 'a@example.test', connected: true, syncedAt: null, syncError: null, ...over });

test('page load: new bookmarks in Raindrop start the full check before the list; none, no check', async () => {
  const fresh = lifecycle(ME({ syncedAt: new Date().toISOString() }), { changes: { added: 3, more: false } });
  await fresh.box.boot();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fresh.requests.slice(0, 3), ['/api/me', '/api/changes', 'POST /api/pull']);
  assert.equal(fresh.els.status.textContent, 'Checked.');

  const same = lifecycle(ME({ syncedAt: new Date().toISOString() }));
  await same.box.boot();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(same.requests.includes('POST /api/pull'), false);
});

test('first load of a new user: the footer shows the sync that ran while the list loaded', async () => {
  const hours3 = new Date(Date.now() - 3 * 3600000).toISOString();
  const { box, els, requests } = lifecycle(ME(), {
    // The first sync runs during the load of /api/meta. After it, the server has a sync time.
    duringLoad: (b) => { b.state = ME({ syncedAt: hours3 }); },
  });
  await box.boot();
  for (let i = 0; i < 20 && els.syncedAt.textContent !== 'Synced 3 hours ago'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(els.syncedAt.textContent, 'Synced 3 hours ago', 'not "Not synced yet"');
  assert.equal(requests.filter((p) => p === '/api/me').length, 2, 'a second read after the load');
});

test('first load: a failed first sync shows the warning, and a failed status read keeps the load result', async () => {
  const failed = lifecycle(ME(), { duringLoad: (b) => { b.state = ME({ syncError: 'secret table name' }); } });
  await failed.box.boot();
  for (let i = 0; i < 20 && failed.els.syncWarn.hidden; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(failed.els.syncWarn.hidden, false);
  assert.equal(failed.els.syncWarn.textContent, 'The last sync failed. The data can be old.');

  // The second read of /api/me fails. boot() must not fail, and the first text stays.
  const broken = lifecycle(ME({ syncedAt: new Date().toISOString() }), {
    duringLoad: (b) => { b.api = async () => { throw new Error('network'); }; },
  });
  await broken.box.boot();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(broken.els.syncedAt.textContent, /^Synced /);
});

test('a check that works shows the new synced time', async () => {
  const old = new Date(Date.now() - 30 * 3600000).toISOString();
  const { box, els } = lifecycle(ME({ syncedAt: old }));
  await box.boot();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.syncedAt.textContent, 'Synced 1 day ago');
  box.state = ME({ syncedAt: new Date().toISOString() }); // the check ran a full sync
  await els.pull.onclick();
  assert.equal(els.syncedAt.textContent, 'Synced 1 minute ago');
  assert.equal(els.pull.disabled, false);
});

test('a check that fails shows the warning from the new status, and keeps the error of the check', async () => {
  const { box, els } = lifecycle(ME({ syncedAt: new Date().toISOString() }), { pullFails: true });
  await box.boot();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.syncWarn.hidden, true, 'no warning before the check');
  box.state = ME({ syncedAt: box.state.syncedAt, syncError: 'The sync of this user failed' }); // the server recorded the failure
  await els.pull.onclick();
  assert.equal(els.status.textContent, 'Error: Check failed: Raindrop failed');
  assert.equal(els.syncWarn.hidden, false);
  assert.equal(els.syncWarn.textContent, 'The last sync failed. The data can be old.');
  assert.equal(els.pull.textContent, 'Check for new bookmarks');
});

test('a check whose status read fails still ends in a good state and keeps the old text', async () => {
  const { box, els } = lifecycle(ME({ syncedAt: new Date().toISOString() }));
  await box.boot();
  await new Promise((r) => setTimeout(r, 10));
  box.api = async () => { throw new Error('network'); };
  await els.pull.onclick();
  assert.equal(els.status.textContent, 'Checked.');
  assert.match(els.syncedAt.textContent, /^Synced /);
  assert.equal(els.pull.disabled, false);
});

test('with the stored copy off, a refresh keeps both elements hidden', async () => {
  const { box, els } = lifecycle({ user: 'a@example.test', connected: true });
  await box.boot();
  await new Promise((r) => setTimeout(r, 10));
  await els.pull.onclick();
  assert.equal(els.syncedAt.hidden, true);
  assert.equal(els.syncWarn.hidden, true);
});
