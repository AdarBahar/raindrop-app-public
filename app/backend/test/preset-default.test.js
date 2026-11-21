import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageScript } from './helpers/frontend.js';

// The page script picks the default date preset from the counts. Load only that part.
const js = pageScript();
const part = js.match(/const PRESET_ORDER = [\s\S]*?\nfunction defaultPresetOf\(counts\) \{[\s\S]*?\n\}/)[0];
const sandbox = {};
vm.runInNewContext(`${part}\nthis.defaultPresetOf = defaultPresetOf;`, sandbox);
const { defaultPresetOf } = sandbox;

test('the default preset is the first one with a count above zero', () => {
  assert.equal(defaultPresetOf({ all: 9, today: 2, last7: 5, last30: 7 }), 'today');
  assert.equal(defaultPresetOf({ all: 9, today: 0, last7: 3, last30: 7 }), 'last7');
  assert.equal(defaultPresetOf({ all: 9, today: 0, last7: 0, last30: 7 }), 'last30');
  assert.equal(defaultPresetOf({ all: 9, today: 0, last7: 0, last30: 0 }), 'all');
});

test('with no bookmarks at all, the default is "All time"', () => {
  assert.equal(defaultPresetOf({ all: 0, today: 0, last7: 0, last30: 0 }), 'all');
  assert.equal(defaultPresetOf({}), 'all');
});

test('the page applies the default on load and after "Clear filters"', () => {
  assert.match(js, /defaultPreset = defaultPresetOf\(m\.presets\)/);
  // The load runs the quick check first, then the same refresh. See quick-check.test.js.
  assert.match(js, /if \(d\?\.added && await pullNow\(\)\) return;\n\s*await refreshMeta\(\{followDefault: true\}\);\n\s*await run\(\);/);
  assert.match(js, /presetChosen = false; showPreset\(defaultPreset\); folder = '';/);
  assert.match(js, /preset !== basePreset\(\) \? 1 : 0/);
});

test('a preset the user clicked stays when the default moves', () => {
  // The click is remembered on its own. Equality with the default is not a sign of a choice.
  assert.match(js, /function setPreset\(p\) \{\n  presetChosen = true;/);
  assert.match(js, /if \(followDefault && !presetChosen && preset !== basePreset\(\)\) \{/);
});

test('when the view moves to a new default, the page and the selection reset', () => {
  const branch = js.match(/if \(followDefault && !presetChosen && preset !== basePreset\(\)\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(branch, /showPreset\(basePreset\(\)\);/);
  assert.match(branch, /page = 1;/);
  assert.match(branch, /clearSelection\(\);/);
});

test('only the refreshes that reload the list may move the view', () => {
  // A check and a finished bulk job reload the list. A save or a new folder does not, so the view stays.
  const follows = js.match(/refreshMeta\(\{followDefault: true\}\)/g) ?? [];
  assert.equal(follows.length, 3);
  assert.match(js, /await refreshMeta\(\{followDefault: true\}\)\.catch\(reportError\);\n\s+await run\(\);\n\s+\/\/ [^\n]*\n\s+if \(!\$\('review'\)\.contains\(document\.activeElement\)\) \{\n\s+if \(inReview\(\)\) \$\('reviewH'\)\.focus\(\{preventScroll: true\}\); else \$\('selectAll'\)\.focus\(\);/);
  assert.match(js, /await refreshMeta\(\{followDefault: true\}\);\n\s+await run\(\);\n\s+return true;\n\s+\} catch \(e\) \{\n\s+if \(e\.connect\) throw e;\n\s+\$\('status'\)\.textContent = 'Error: Check failed: '/);
  assert.equal(follows.length, 3); // the load, the check (pullNow) and a finished job
});

// The search rule, run with a small copy of the page state.
function searchPage({ preset, chosen, defaultPreset = 'last7' }) {
  const rule = js.match(/let searchOn = false, beforeSearch = null;\nfunction syncSearchPreset\(\) \{[\s\S]*?\n\}/)[0];
  const page = { q: '', preset, presetChosen: chosen, defaultPreset };
  vm.runInNewContext(`
    let preset = page.preset, presetChosen = page.presetChosen, defaultPreset = page.defaultPreset;
    const $ = () => ({ get value() { return page.q; } });
    function showPreset(p) { preset = p; }
    ${rule}
    page.type = (text) => { page.q = text; return syncSearchPreset(); };
    page.click = (p) => { presetChosen = true; showPreset(p); };
    page.state = () => preset + (presetChosen ? ' chosen' : ' not chosen');
  `, { page });
  return page;
}

test('a text search shows all dates, and the date filter from before returns after it', () => {
  // A view the user did not choose: to "All time", then back to the default.
  let p = searchPage({ preset: 'last7', chosen: false });
  assert.equal(p.type('w'), true); // the date filter changed, so the list reloads at once
  assert.equal(p.state(), 'all not chosen');
  assert.equal(p.type('wh'), false); // more text is not a new search
  assert.equal(p.type(''), true);
  assert.equal(p.state(), 'last7 not chosen');
  // A preset the user clicked before the search returns as a choice.
  p = searchPage({ preset: 'today', chosen: true });
  p.type('w');
  assert.equal(p.state(), 'all not chosen');
  p.type('');
  assert.equal(p.state(), 'today chosen');
  // The same with "All time" clicked before the search, for example by the duplicate view. Nothing changes.
  p = searchPage({ preset: 'all', chosen: true });
  assert.equal(p.type('w'), false);
  assert.equal(p.type(''), false);
  assert.equal(p.state(), 'all chosen');
  // A preset the user clicked during the search stays after it.
  p = searchPage({ preset: 'last7', chosen: false });
  p.type('w');
  p.click('last30');
  assert.equal(p.type(''), false);
  assert.equal(p.state(), 'last30 chosen');
  // Spaces only are not search text.
  p = searchPage({ preset: 'last7', chosen: false });
  assert.equal(p.type('  '), false);
  assert.equal(p.state(), 'last7 not chosen');
});

test('the page wires the search rule and the date label', () => {
  assert.match(js, /function basePreset\(\) \{ return \$\('q'\)\.value\.trim\(\) \? 'all' : defaultPreset; \}/);
  // A change of the date filter starts the new list at once, so the selection does not stay during the delay.
  assert.match(js, /\$\('q'\)\.addEventListener\('input', \(\) => \{ if \(syncSearchPreset\(\)\) \{ clearTimeout\(timer\); changed\(\); \} \}\);/);
  assert.match(js, /function changed\(\) \{\n  page = 1;\n  clearSelection\(\);\n[^\n]*\n  renderSelection\(\);/);
  // "Select all N matching" works only when the list on the page has the current filters.
  assert.match(js, /const asked = p\.toString\(\); \/\/ [^\n]*\n  p\.set\('page'/);
  assert.match(js, /if \(seq !== runSeq\) return;[\s\S]*?listFilter = asked;/);
  assert.match(js, /closest\('\[data-select-matching\]'\) && filterParams\(\)\.toString\(\) === listFilter\) \{ allMatching = true;/);
  assert.match(js, /searchOn = false; beforeSearch = null;/);
  // The label shows only with search text.
  assert.match(js, /\$\('q'\)\.value\.trim\(\) \? \{today: 'Today', last7: 'Last 7 days', last30: 'Last 30 days', older: 'Older than 30 days'\}\[b\.period\] : ''/);
});
