import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScript } from './helpers/frontend.js';

// Static checks of the keyboard shortcuts (docs/ui-elements.md, section 6.1).
// A browser check with a real keyboard is still needed.
const js = pageScript();
const spec = readFileSync(new URL('../../../docs/ui-elements.md', import.meta.url), 'utf8');

test('the arrow keys move between rows and pages, and Ctrl or Cmd plus A selects the page', () => {
  assert.match(js, /e\.key === 'ArrowDown'\) handled = moveRow\(1\)/);
  assert.match(js, /e\.key === 'ArrowUp'\) handled = moveRow\(-1\)/);
  assert.match(js, /e\.key === 'ArrowRight'\) handled = turnPage\(1\)/);
  assert.match(js, /e\.key === 'ArrowLeft'\) handled = turnPage\(-1\)/);
  assert.match(js, /e\.key\.toLowerCase\(\) === 'a' && \(e\.ctrlKey \|\| e\.metaKey\)/);
});

test('the shortcuts ignore text fields, selects and open dialogs', () => {
  assert.match(js, /function isTyping\(el\)/);
  // A checkbox must not count as a text box, or the arrow keys stop after the first row.
  assert.match(js, /input:not\(\[type="checkbox"\]\), textarea, select/);
  assert.match(js, /input:not\(\[type="checkbox"\]\), textarea, select, \[contenteditable="true"\]/);
  assert.match(js, /document\.querySelector\('dialog\[open\]'\)/);
});

test('paging by keyboard uses the same page change as the buttons, and skips disabled buttons', () => {
  assert.match(js, /function goPage\(step\)/);
  assert.match(js, /if \(b\) goPage\(b\.dataset\.page === 'next' \? 1 : -1\)/);
  assert.match(js, /\[data-page="\$\{step > 0 \? 'next' : 'prev'\}"\]:not\(\[disabled\]\)/);
});

test('the spec lists the shortcuts and the decision about keyboard help', () => {
  assert.match(spec, /### 6\.1 Keyboard shortcuts \(Proposed\)/);
  assert.match(spec, /Ctrl\+A \(Cmd\+A on macOS\)/);
  assert.match(spec, /17\. \*\*Keyboard help\.\*\*/);
});

test('the ? key and the sidebar button open the keyboard help dialog', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="helpBtn"[^>]*>Keyboard shortcuts \(\?\)<\/button>/);
  assert.match(html, /<dialog id="helpDlg" aria-labelledby="helpH">/);
  assert.match(js, /e\.key === '\?' && !e\.ctrlKey && !e\.metaKey && !e\.altKey && !isTyping\(e\.target\)/);
  assert.match(js, /\$\('helpBtn'\)\.onclick = openHelp;/);
});

test('batch suggest: the bulk bar offers it, the review in the drawer applies a card, or all ready cards', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="acts">\s*<button class="btn sm" data-bulk="suggest">AI Suggest folder and tags<\/button>/);
  assert.doesNotMatch(html, /id="suggestDlg"/);
  assert.match(html, /<div id="review" class="review" hidden role="region" aria-labelledby="reviewH">/);
  assert.match(html, /<button id="reviewApplyAll" class="btn sm primary">Apply all<\/button><button id="reviewClearAll" class="btn sm">Clear all<\/button>/);
  assert.match(js, /function applyAllCards\(\) \{ return review \? review\.cards\.filter\(c => reviewInApplyAll\(c, reviewTags\(c\)\)\) : \[\]; \}/);
  assert.match(js, /data-rc="apply"[\s\S]*data-rc="edit"[\s\S]*data-rc="clear"/);
  assert.match(js, /action: 'apply', from: review\.id, changes/);
  assert.match(html, /<p class="muted" id="reviewSaved">Nothing is saved yet\./);
});

test('batch suggest review: the summary, the card labels, and Apply with a proposed folder', () => {
  const src = /function reviewCounts\(\) \{[\s\S]*?\n\}/.exec(js)[0] + /function reviewSummary\(k, rest, .*?\) \{[\s\S]*?\n\}/.exec(js)[0];
  const summary = (review, k, rest, jobs = new Map()) => new Function('review', 'jobs', `${src}; return reviewSummary(${k}, ${rest});`)({jobs: new Set(), ...review}, jobs);
  assert.equal(summary({applied: 20, total: 50, none: 3}, 0, 27), '20 of 50 changed. 27 need your decision: apply each one, or choose Edit. 3 got no suggestion.');
  assert.equal(summary({applied: 0, total: 5, none: 0}, 4, 1), '4 ready for "Apply all". 1 needs your decision: apply it, or choose Edit.');
  assert.equal(summary({applied: 2, total: 2, none: 0}, 0, 0), '2 of 2 changed.');
  // A running apply job: 8 of 25 done, 1 of them failed.
  assert.equal(summary({applied: 0, total: 30, none: 0, jobs: new Set(['j1'])}, 0, 5, new Map([['j1', {done: 8, total: 25, failed: [{}]}]])),
    '7 of 30 changed. Saving 17 more. 5 need your decision: apply each one, or choose Edit.');
  // A bookmark that already had the folder and tags is not counted as changed.
  assert.equal(summary({applied: 6, same: 10, total: 19, none: 0}, 0, 0), '6 of 19 changed. 10 already as suggested.');
  assert.equal(summary({applied: 0, total: 19, none: 0, jobs: new Set(['j1'])}, 0, 0, new Map([['j1', {done: 16, total: 16, failed: [], unchanged: 10}]])),
    '6 of 19 changed. 10 already as suggested.');
  assert.match(js, /if \(view\.action !== 'suggest' && view\.done > before\) liveReload\(\);/);
  assert.match(js, /if \(Date\.now\(\) - liveAt < 3000 \|\| listBusy\(\)\) return;\n  liveAt = Date\.now\(\);\n  run\(\{background: true\}\);/);
  assert.match(js, /return Boolean\(a && \(\$\('list'\)\.contains\(a\) \|\| a\.closest\('\[data-paging\]'\)\)\);/);
  // The focus is checked again when the answer comes back, before the list is drawn.
  assert.match(js, /if \(seq !== runSeq\) return;[^\n]*\n[^\n]*\n  if \(background && listBusy\(\)\) \{ liveAt = 0; return; \}\n  loaded = true;/);
  assert.equal(summary({applied: 5, total: 50, none: 0, skipped: 40}, 5, 0), '5 of 50 changed. 5 ready for "Apply all". 40 not done: the suggestion was cancelled.');
  // A bookmark in a folder is ready with its current folder. A bookmark in Unsorted needs an existing folder.
  assert.match(js, /const ready = s\.status === 'ready' && \(reviewSorted\(s\) \? !waits : s\.folder\.action === 'existing'\);/);
  assert.match(js, /'New folder proposed' : 'Needs review'/);
  assert.match(js, /\$\{create \? 'Create folder and apply' : 'Apply'\}/);
  assert.match(js, /applyCards\(\[c\], \{create: true\}\)/);
  // The folder that Apply sends is a rule in rules.js (reviewChange). review-keep-folder.test.js runs it.
  assert.match(js, /const changes = cards\.map\(c => reviewChange\(c, reviewTags\(c\), create\)\);/);
  assert.doesNotMatch(js, /c\.folder = 'new'/);
  assert.match(js, /total: view\.total,/);
  assert.match(js, /review\.jobs\.add\(started\.id\);/);
  assert.match(js, /review\.applied \+= view\.done - view\.failed\.length - same;/);
  assert.match(js, /review\.same \+= same;/);
  // The proposed new tags are selected at the start, so Apply and "Apply all" add them.
  assert.match(js, /newTags: new Set\(s\.new_tags\)/);
  assert.match(js, /`\$\{t\} \(new\)`/);
  // After the first saved bookmark, the head says that the applied bookmarks are saved.
  // The text shows only when at least one bookmark of the review is saved, not when every apply failed.
  assert.match(js, /\$\('reviewSaved'\)\.textContent = counts\.applied \+ counts\.same\n    \? 'Applied bookmarks are saved in Raindrop\. The cards below are not saved yet\.'/);
  assert.match(js, /No change needed for \$\{u\}\./);
});

test('wide screens: the bulk actions are a drawer next to the list, aligned to one row or centred', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(min-width: 1100px\) \{[\s\S]*?\.bulk \{ position: fixed;/);
  assert.match(js, /const wideBulk = matchMedia\('\(min-width: 1100px\)'\);/);
  assert.match(js, /const one = reviewing \? review\.cards\.length === 1 && rows\.length === 1 : Boolean\(peekRow\) \|\|\n?\s*\(!allMatching && selectionCount\(\) === 1 && rows\.length === 1 && !shownJob\(\)\);/);
  assert.match(js, /queuePlaceBulk\(\);\n\}/);
  // Each selected row in view gets a point on the drawer edge.
  assert.match(html, /<div id="bulkPoints" class="bulk-points" aria-hidden="true"><\/div>/);
  assert.match(js, /points\.innerHTML = \[\.\.\.rows\]\.map/);
});

test('bulk archive: a move to the folder Archive, created on first use', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-bulk="archive">Archive<\/button>/);
  assert.match(html, /id="bulkClear" class="btn sm quiet">Clear bookmarks selection<\/button>/);
  assert.match(js, /const ARCHIVE = 'Archive';/);
  assert.match(js, /body\.action = 'move';/);
  // One helper finds or creates the folder. A 409 (the folder exists) reloads the folders.
  assert.match(js, /try \{ await createFolder\(ARCHIVE\); \} catch \(err\) \{ if \(err\.status !== 409\) throw err; \}/);
  // A bulk Archive stops when the user chose another step while the folder was created.
  assert.match(js, /if \(!go\.isConnected \|\| \$\('bulkPanel'\)\.hidden \|\| \$\('bulkPanel'\)\.dataset\.action !== 'archive'\) return;/);
  // After the wait, the move uses the selection of now.
  assert.match(js, /delete body\.ids; delete body\.filter;\n\s+if \(allMatching\) body\.filter = Object\.fromEntries\(filterParams\(\)\); else body\.ids = \[\.\.\.selected\.keys\(\)\];/);
});

test('hover peek: a hovered row opens the drawer, a click on an action selects the bookmark', () => {
  const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(js, /const canPeek = matchMedia\('\(min-width: 1100px\) and \(hover: hover\)'\);/);
  assert.match(js, /const PEEK_OPEN_MS = 120, PEEK_MOVE_MS = 300, PEEK_CLOSE_MS = 700;/);
  assert.match(js, /if \(t\.closest\('\[data-bulk\]'\)\) adoptPeek\(\);/);
  // The row buttons stay for the keyboard.
  assert.match(css, /\.row \.actions:has\(:focus-visible\) \{ opacity: 1; pointer-events: auto; \}/);
});

test('drawer Edit: shown for one bookmark on the page, opens the editor of that row', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-bulk="suggest">AI Suggest folder and tags<\/button>\s*<button class="btn sm" id="bulkEdit" hidden>Edit<\/button>/);
  assert.match(js, /\$\('bulkEdit'\)\.hidden = editTarget\(\) === null;/);
  assert.match(js, /document\.querySelector\(`\[data-act="edit"\]\[data-id="\$\{id\}"\]`\)\?\.click\(\);/);
});

test('AI marks: a bouncing drop while the model works on a row, then a check in the same colour', () => {
  const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(js, /<span class="rownum">\$\{n\}<\/span>\$\{aiMarkHtml\(aiMark\(b\.id\)\)\}/);
  assert.match(js, /aiJob = \{id: started\.id, ids: body\.ids \? new Set\(body\.ids\) : null, filter: body\.filter \? JSON\.stringify\(body\.filter\) : null\};/);
  assert.match(js, /function endReview\(\) \{[\s\S]*?\n  review = null; reviewId = null; aiJob = null;/);
  assert.match(css, /--ai: #01A1FE;/);
  assert.match(css, /@keyframes ai-drop \{/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.ai-mark i, \.ai-mark::after, \.ai-mark svg \{ animation: none !important; \} \}/);
});

test('archive lookup: any folder named Archive, also a duplicate label "Archive (#id)", the oldest first', () => {
  const src = js.match(/function archiveFolder\(\) \{[\s\S]*?\n\}/)[0];
  const pick = (folders) => new Function('metaFolders', 'ARCHIVE', `${src}; return archiveFolder();`)(folders, 'Archive');
  assert.equal(pick([{id: '9', label: 'Archive (#9)'}, {id: '4', label: 'Archive (#4)'}]).id, '4');
  assert.equal(pick([{id: '7', label: 'archive'}]).id, '7');
  assert.equal(pick([{id: '3', label: 'My Archive'}, {id: '5', label: 'Archive old'}]), undefined);
});

test('review: a proposed-tag checkbox has a stable id, so the focus stays on it after the redraw', () => {
  assert.match(js, /<input type="checkbox" id="rcn-\$\{id\}-\$\{k\}" data-rc-newtag="\$\{id\}"/);
});

test('hover: the row buttons hide only while the hover drawer can open', () => {
  const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(js, /\$\('list'\)\.classList\.toggle\('peek-on', n === 0 && !running && !reviewing\);/);
  assert.match(css, /#list\.peek-on \.row:hover \.actions, #list\.peek-on \.row:focus-within \.actions \{ opacity: 0; pointer-events: none; \}/);
  assert.doesNotMatch(css, /\n  \.row:hover \.actions, \.row:focus-within \.actions \{ opacity: 0;/);
});

test('review: typed tags update "Apply all", and the focus returns to the review after an apply', () => {
  assert.match(js, /if \(c\) \{ c\.tags = e\.target\.value; c\.edited = true; renderReviewHead\(\); \}/);
  // A user who types in another card keeps the focus when a job ends.
  assert.match(js, /if \(!\$\('review'\)\.contains\(document\.activeElement\)\) \{\n\s+if \(inReview\(\)\) \$\('reviewH'\)\.focus\(\{preventScroll: true\}\); else \$\('selectAll'\)\.focus\(\);/);
  // Edit and then Done, with no change, does not add a card to "Apply all".
  assert.doesNotMatch(js, /if \(!c\.editing\) c\.edited = true;/);
});

test('review: after "Clear all" or the last "Clear", the focus goes to "Select all"', () => {
  assert.match(js, /const hadFocus = \$\('review'\)\.contains\(document\.activeElement\);[\s\S]*?if \(hadFocus\) \$\('selectAll'\)\.focus\(\);\n\}/);
});

test('a suggest job with no suggestion leaves the drawer, and bulkLabel names the suggest, apply and undo jobs', () => {
  assert.match(js, /if \(n\) openSuggestions\(view\);\n  else \{[\s\S]*?\n    renderSelection\(\);\n    if \(lost\) \$\('selectAll'\)\.focus\(\);/);
  assert.match(js, /suggest: 'AI Suggest folder and tags',\n\s+apply: 'Apply suggestions', undo: 'Undo'/);
});

test('review with one card: no "Apply all" and "Clear all", and the drawer is aligned to the row', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="line" id="reviewAll"><button id="reviewApplyAll"/);
  assert.match(js, /const single = review\.cards\.length === 1;\n  \$\('reviewAll'\)\.hidden = single;/);
  assert.match(js, /rest = single \? 0 : review\.cards\.length - k;/);
});

test('date tabs show "<with filters>/<all>" when another filter is on, and the count line names the filters', () => {
  const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(js, /function otherFilterOn\(\) \{\n  return Boolean\(\$\('q'\)\.value\.trim\(\) \|\| folder !== '' \|\| \$\('tags'\)\.value\.trim\(\) \|\| \$\('statusFilter'\)\.value \|\| \$\('visited'\)\.value\);/);
  assert.match(js, /<span aria-hidden="true">\/<\/span><span class="sr-only"> of <\/span>\$\{total\}/);
  assert.match(js, /filteredPresets = d\.presets \?\? null;\n  renderPresetCounts\(\);/);
  assert.match(js, /parts\.push\(`in folder \$\{/);
  // The selected folder keeps its colour: bold text and a line above and below.
  assert.match(css, /\.nav-item\.fold \.name \{ color: hsl\(var\(--h\) 70% var\(--fold-l\)\); \}/);
  assert.match(css, /#folders \.nav-item\.on \{ color: var\(--fg\); font-weight: 700;/);
});

test('after a save, the filtered date counts reload without a reload of the list', () => {
  assert.match(js, /refreshMeta\(\)\.then\(refreshFilteredCounts\)\.catch\(reportError\);/);
  assert.match(js, /async function refreshFilteredCounts\(\) \{\n  if \(!otherFilterOn\(\)\) return;\n  const seq = runSeq;/);
  // The same reload updates the counts of the switch of "Unsorted or no tags".
  assert.match(js, /async function refreshFilteredCounts\(\) \{[\s\S]*?renderPresetCounts\(\);\n[^\n]*\n  needsCounts = d\.needsCounts \?\? null;\n  renderNeedsSwitch\(\);\n\}/);
  // The count line uses the filter words of its own request.
  assert.match(js, /const p = filterParams\(\);\n[^\n]*\n  const where = filterSummary\(\);/);
});

test('status "Unsorted or no tags": a switch above the list chooses any, both, no folder or no tags', () => {
  const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="needsSwitch" class="seg needs-switch" role="group" aria-label="Show bookmarks with" hidden>/);
  for (const [v, label] of [['', 'Any of these'], ['both', 'No folder and no tags'], ['folder', 'No folder'], ['tags', 'No tags']]) {
    assert.match(html, new RegExp(`data-needs="${v}" data-label="${label}"`));
  }
  // The kind goes with the request only with the status "needs". Bulk "all matching" uses the same parameters.
  assert.match(js, /if \(\$\('statusFilter'\)\.value === 'needs' && needsKind\) p\.set\('needs', needsKind\);/);
  assert.match(js, /needsCounts = d\.needsCounts \?\? null;/);
  // A new status and "Clear filters" start the switch at "Any of these".
  assert.match(js, /\$\('statusFilter'\)\.onchange = \(\) => \{\n[^\n]*\n  needsKind = '';/);
  assert.match(js, /folder = ''; needsKind = '';/);
  // The count line names the kind.
  assert.match(js, /\{both: 'unsorted and with no tags', folder: 'unsorted', tags: 'with no tags'\}\[needsKind\]/);
});
