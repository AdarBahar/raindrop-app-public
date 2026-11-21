// The page script, part 4 of 9: The selection, the bulk panel, and the bulk jobs and their progress.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- Selection and bulk actions (section 5.6) ----
function clearSelection() {
  selected.clear();
  allMatching = false;
  lastSel = null;
}

function selectionCount() { return allMatching ? pageInfo.matched : selected.size; }

// True when a bookmark is part of the selection. With "all matching", every bookmark on every page is.
function isSelected(id) { return allMatching || selected.has(id); }

function renderSelection() {
  const onPage = lastResults.filter(b => isSelected(b.id)).length;
  const all = $('selectAll');
  all.checked = lastResults.length > 0 && onPage === lastResults.length;
  all.indeterminate = onPage > 0 && onPage < lastResults.length;
  const n = selectionCount();
  let info = '';
  if (n) {
    info = `${n} selected`;
    if (all.checked && !allMatching && pageInfo.matched > selected.size) {
      info += pageInfo.matched > 1000
        ? ' · Only the first 1,000 can be selected. Narrow the filters.'
        : ` · <button type="button" class="status-link" data-select-matching>Select all ${pageInfo.matched} matching bookmarks</button>`;
    }
    info += ' · <button type="button" class="status-link" data-clear-sel>Clear selection</button>';
  }
  $('selInfo').innerHTML = info;
  // The row style and its checkbox both follow the selection, whatever changed it.
  document.querySelectorAll('.row').forEach(r => {
    const on = isSelected(Number(r.dataset.id));
    r.classList.toggle('selected', on);
    const box = r.querySelector('[data-sel]');
    if (box) box.checked = on;
  });
  const shown = shownJob();
  const running = Boolean(shown);
  const bulk = $('bulk');
  // With no selection and no job, a hovered row opens the drawer for that one bookmark (a "peek").
  // An open review of suggestions fills the drawer. It comes before the selection actions and the peek.
  const reviewing = inReview();
  const peekRow = n === 0 && !running && !reviewing ? peekRowEl() : null;
  if (!peekRow) peekId = null;
  bulk.hidden = n === 0 && !running && !peekRow && !reviewing;
  bulk.classList.toggle('running', running);
  bulk.classList.toggle('reviewing', reviewing);
  $('list').classList.toggle('peek-on', n === 0 && !running && !reviewing);
  bulk.classList.toggle('peek', Boolean(peekRow));
  $('bulkCount').textContent = running ? bulkLabel(shown.action)
    : peekRow ? `Bookmark ${peekRow.querySelector('.rownum')?.textContent ?? ''}` : `${n} selected`;
  $('bulkEdit').hidden = editTarget() === null;
  if (n === 0) { $('bulkPanel').hidden = true; $('bulkPanel').innerHTML = ''; closeBulkSheet(); }
  else if (!$('bulkPanel').hidden) refreshBulkPanel(n);
  queuePlaceBulk();
}

// An open bulk panel follows the selection: the count on Apply, the question, and the tag list for removal.
function refreshBulkPanel(n) {
  const p = $('bulkPanel');
  if (p.dataset.action === 'removeTags') {
    const picked = new Set(bulkPicked());
    const focused = document.activeElement?.value;
    bulkPanel('removeTags');
    document.querySelectorAll('#bulkPanel .picks input').forEach(i => { i.checked = picked.has(i.value); if (i.value === focused) i.focus(); });
    bulkQuestion();
    return;
  }
  const go = $('bulkGo');
  if (go) { go.textContent = `Apply to ${plural(n, 'bookmark')}`; go.classList.toggle('primary', n <= 100); }
  bulkQuestion();
}

function bulkLabel(action) {
  return {move: 'Move to folder', addTags: 'Add tags', removeTags: 'Remove tags', suggest: 'AI Suggest folder and tags',
    apply: 'Apply suggestions', undo: 'Undo'}[action] || 'Update';
}

$('selectAll').addEventListener('change', e => {
  // Unticking after "all matching" keeps the rows that were ticked one by one on the other pages.
  if (e.target.checked) lastResults.forEach(b => selected.set(b.id, b.tags));
  else { lastResults.forEach(b => selected.delete(b.id)); allMatching = false; }
  renderSelection();
});
$('list').addEventListener('click', e => {
  const box = e.target.closest('[data-sel]');
  if (!box) return;
  const id = Number(box.dataset.sel);
  // Shift+click selects the range from the last clicked row. The last row must be on this page.
  const a = e.shiftKey && lastSel !== null ? lastResults.findIndex(b => b.id === lastSel) : -1;
  const c = lastResults.findIndex(b => b.id === id);
  if (a >= 0 && c >= 0) {
    const [lo, hi] = [Math.min(a, c), Math.max(a, c)];
    for (let i = lo; i <= hi; i++) selected.set(lastResults[i].id, lastResults[i].tags);
  } else if (box.checked) selected.set(id, lastResults[c]?.tags ?? []);
  else {
    // Unticking one row after "all matching" keeps the rest of this page ticked.
    if (allMatching) lastResults.forEach(b => selected.set(b.id, b.tags));
    selected.delete(id); allMatching = false;
  }
  lastSel = id;
  renderSelection();
});
document.addEventListener('click', e => {
  // "Select all N matching" counts the list on the page. While a list with other filters loads, or after its
  // load failed, the count is not that of the filters, so the click does nothing.
  if (e.target.closest('[data-select-matching]') && filterParams().toString() === listFilter) { allMatching = true; renderSelection(); }
  if (e.target.closest('[data-clear-sel]') || e.target.id === 'bulkClear') { clearSelection(); renderSelection(); }
});

// The panel holds the target choice and the confirm step in one place. The question line updates
// as the target changes. Over 100 bookmarks, Apply is not the primary button.
function bulkPanel(action) {
  const n = selectionCount();
  const p = $('bulkPanel'); p.hidden = false; p.dataset.action = action;
  const apply = `<button class="btn sm${n > 100 ? '' : ' primary'}" id="bulkGo">Apply to ${plural(n, 'bookmark')}</button><button class="btn sm" id="bulkCancelPanel">Cancel</button>`;
  if (action === 'move') {
    p.innerHTML = `<div class="field"><label for="bulkFolder">Move to folder</label><select id="bulkFolder">${metaFolders.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}<option value="__new__">+ Create a new folder...</option></select></div>
      <div class="field" id="bulkNewFolder" hidden><label for="bulkNewFolderName">New folder name</label>
        <div class="line"><input id="bulkNewFolderName" placeholder="New folder name" maxlength="100"><button class="btn sm" id="bulkCreateFolder">Create folder</button></div></div>
      <strong id="bulkQ" role="status"></strong>${apply}<span class="err" id="bulkErr" role="alert"></span>`;
  } else if (action === 'archive') {
    // Archive is a move to the folder named "Archive" (see archiveFolder). The app creates it on first use.
    p.innerHTML = `<span class="lbl">Archive</span>
      <strong id="bulkQ" role="status"></strong>${apply}<span class="err" id="bulkErr" role="alert"></span>`;
  } else if (action === 'addTags') {
    p.innerHTML = `<div class="field"><label for="bulkTags">Add tags</label><input id="bulkTags" placeholder="Tags (comma separated)" list="taglist" autocomplete="off"></div>
      <strong id="bulkQ" role="status"></strong>${apply}<span class="err" id="bulkErr" role="alert"></span>`;
  } else {
    // The tags on the selected bookmarks, on every page, with counts. With "all matching", the tag list of the account.
    const counts = new Map();
    if (allMatching) metaTags.forEach(t => counts.set(t.name, t.count));
    else for (const tags of selected.values()) for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
    const picks = [...counts].sort((a, b) => b[1] - a[1]);
    p.innerHTML = `<div class="field"><span class="lbl">Remove tags</span><div class="picks">${picks.length ? picks.map(([t, c]) => `<label><input type="checkbox" value="${esc(t)}"> ${esc(t)} (${c})</label>`).join('') : '<span class="lbl">The selected bookmarks have no tags.</span>'}</div></div>
      <strong id="bulkQ" role="status"></strong>${apply}<span class="err" id="bulkErr" role="alert"></span>`;
    if (!picks.length) $('bulkGo').disabled = true;
  }
  bulkQuestion();
}
const ARCHIVE = 'Archive';
// The folder named "Archive", at any level. The server refuses a second folder with a name that is in use,
// so the app does not create one when a folder of that name exists. A duplicate name has the label
// "Archive (#<id>)". Then the folder with the lowest ID (the oldest) is used.
function archiveFolder() {
  const name = new RegExp(`^${ARCHIVE}( \\(#\\d+\\))?$`, 'i');
  return metaFolders.filter(f => name.test(f.label)).sort((a, b) => Number(a.id) - Number(b.id))[0];
}
async function ensureArchive() {
  let folder = archiveFolder();
  if (folder) return folder;
  try { await createFolder(ARCHIVE); } catch (err) { if (err.status !== 409) throw err; }
  await refreshMeta();
  folder = archiveFolder();
  if (!folder) throw new Error(`The folder ${ARCHIVE} was not found.`);
  return folder;
}
function bulkTagsTyped() { return splitTags($('bulkTags')?.value); }
function bulkPicked() { return [...document.querySelectorAll('#bulkPanel .picks input:checked')].map(i => i.value); }
function bulkQuestion() {
  const action = $('bulkPanel').dataset.action, n = selectionCount(), q = $('bulkQ');
  if (!q) return;
  if (action === 'move') { const v = $('bulkFolder').value; q.textContent = v === '__new__' ? '' : `Move ${plural(n, 'bookmark')} to ${metaFolders.find(f => f.id === v)?.label ?? ''}?`; }
  else if (action === 'archive') q.textContent = `Move ${plural(n, 'bookmark')} to the folder ${ARCHIVE}?${archiveFolder() ? '' : ` The app creates the folder ${ARCHIVE}.`}`;
  else if (action === 'addTags') { const t = bulkTagsTyped(); q.textContent = t.length ? `Add ${plural(t.length, 'tag')} to ${plural(n, 'bookmark')}?` : ''; }
  else { const t = bulkPicked().length; q.textContent = t ? `Remove ${plural(t, 'tag')} from ${plural(n, 'bookmark')}?` : ''; }
}

async function bulkApply() {
  const action = $('bulkPanel').dataset.action;
  const body = {action};
  if (allMatching) body.filter = Object.fromEntries(filterParams()); else body.ids = [...selected.keys()];
  if (action === 'move') {
    const v = $('bulkFolder').value;
    if (v === '__new__') { $('bulkErr').textContent = 'Error: Create the folder first, or choose an existing folder.'; return; }
    body.folderId = Number(v);
  } else if (action === 'archive') {
    body.action = 'move';
    const go = $('bulkGo');
    go.disabled = true;
    try {
      body.folderId = Number((await ensureArchive()).id);
    } catch (err) {
      go.disabled = false;
      if ($('bulkErr')) $('bulkErr').textContent = `Error: Create folder ${ARCHIVE} failed: ` + err.message;
      return;
    }
    // The user can choose another step while the folder is created. Then this Archive stops.
    if (!go.isConnected || $('bulkPanel').hidden || $('bulkPanel').dataset.action !== 'archive') return;
    // The selection can change during the wait too. The move uses the selection of now.
    delete body.ids; delete body.filter;
    if (allMatching) body.filter = Object.fromEntries(filterParams()); else body.ids = [...selected.keys()];
  } else if (action === 'addTags') {
    const tags = bulkTagsTyped();
    if (!tags.length) { $('bulkErr').textContent = 'Error: Add at least one tag.'; return; }
    const problem = tags.map(t => tagProblem(t, [])).find(Boolean);
    if (problem) { $('bulkErr').textContent = 'Error: ' + problem; return; }
    body.tags = tags;
  } else {
    const tags = bulkPicked();
    if (!tags.length) { $('bulkErr').textContent = 'Error: Choose at least one tag.'; return; }
    body.tags = tags;
  }
  $('bulkGo').disabled = true;
  let started;
  try {
    started = track(await postJson('/api/bulk', body));
  } catch (err) {
    $('bulkGo').disabled = false;
    $('bulkErr').textContent = 'Error: Bulk update failed: ' + err.message;
    return;
  }
  clearSelection();
  $('bulkPanel').hidden = true; $('bulkPanel').innerHTML = '';
  showJob(started.id);
}

// Suggest a folder and tags for the selected bookmarks. Nothing is saved until the user applies them.
async function startSuggest() {
  const body = {action: 'suggest'};
  if (allMatching) body.filter = Object.fromEntries(filterParams()); else body.ids = [...selected.keys()];
  let started;
  try {
    started = track(await postJson('/api/bulk', body));
  } catch (err) {
    $('status').textContent = 'Error: Suggestion failed: ' + err.message;
    return;
  }
  aiJob = {id: started.id, ids: body.ids ? new Set(body.ids) : null, filter: body.filter ? JSON.stringify(body.filter) : null};
  showJob(started.id);
}

// The bulk jobs of this page are kept in `jobs`, each with its own poller. The progress panel shows the
// newest job that is still running.
function track(view) {
  jobs.set(view.id, view);
  return view;
}
function shownJob() {
  let last = null;
  for (const j of jobs.values()) if (j.status === 'running') last = j;
  return last;
}

// Show the progress panel, then follow the job until it ends.
function showJob(id) {
  clearSelection();
  $('status').textContent = '';
  renderProgress();
  renderSelection();
  $('jobCancel').focus();
  pollJob(id);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The job runs on the server. The browser asks for its state until it ends. A job the server has lost
// is reported as failed. A server that does not answer is retried, then the page says so.
async function pollJob(id) {
  let misses = 0;
  let view = jobs.get(id);
  while (view && view.status === 'running') {
    await sleep(misses ? Math.min(5000, 700 * 2 ** misses) : 700);
    try {
      const r = await fetch(`/api/bulk/${id}`, {redirect: 'manual'});
      if (r.type === 'opaqueredirect') {
        $('progText').textContent = SIGN_IN_ENDED;
        return;
      }
      if (r.status === 404) {
        view = {...view, status: 'failed', error: 'The update was lost. The server restarted.'};
        break;
      }
      if (!r.ok) throw new Error(`status ${r.status}`);
      const before = view.done;
      view = await r.json();
      misses = 0;
      jobs.set(id, view);
      renderProgress();
      if (review?.jobs.has(id)) renderReviewHead();
      // A job that changes bookmarks reloads the list while it runs, so the rows follow the saved changes.
      if (view.action !== 'suggest' && view.done > before) liveReload();
    } catch (e) {
      misses += 1;
      if (misses >= 12) {
        $('progText').textContent = 'Lost contact with the server. Reload the page to see the result.';
        return;
      }
    }
  }
  if (view && view.status !== 'running') finishJob(view);
}

// Reload the list at most every 3 seconds while a job runs. The end of the job reloads it again.
// The reload draws the list and the paging again. While the user works in them (an editor, a checkbox,
// a page button), the reload waits, so the focus and the text cursor stay. The next poll tries again.
let liveAt = 0;
function listBusy() {
  const a = document.activeElement;
  return Boolean(a && ($('list').contains(a) || a.closest('[data-paging]')));
}
function liveReload() {
  if (Date.now() - liveAt < 3000 || listBusy()) return;
  liveAt = Date.now();
  run({background: true});
}

function renderProgress() {
  renderAiMarks();
  const view = shownJob();
  $('progress').hidden = !view;
  if (!view) return;
  const verb = {undo: 'Undoing', suggest: 'Suggesting for'}[view.action] ?? 'Updating';
  $('progText').textContent = `${verb} ${view.done} of ${view.total} bookmarks.`;
  $('progBar').style.width = `${Math.round(100 * view.done / Math.max(1, view.total))}%`;
}

function reportError(err) {
  $('status').textContent = 'Error: ' + err.message;
}

async function finishJob(view) {
  jobs.set(view.id, view);
  if (view.action === 'suggest') return finishSuggest(view);
  // An apply job of the open review adds to its "<n> of <total> changed" and "<m> already as suggested" counts.
  // A bookmark that was already as suggested is counted apart, because Raindrop did not change.
  if (review?.jobs.has(view.id)) {
    const same = view.unchanged ?? 0;
    review.jobs.delete(view.id);
    review.applied += view.done - view.failed.length - same;
    review.same += same;
    renderReviewHead();
  }
  reportId = view.id;
  const m = view.failed.length, u = view.unchanged ?? 0, n = view.done - m - u;
  const cancelled = view.status === 'cancelled';
  let text = view.action === 'undo'
    ? `${cancelled ? 'Undo cancelled. ' : 'Undo finished. '}Restored ${n}. Not restored ${m}.`
    : `${cancelled ? 'Update cancelled. ' : ''}Updated ${n}. ${u ? `No change needed for ${u}. ` : ''}Not updated ${m}.`;
  if (view.status === 'failed' && view.error) text = `Error: Update failed: ${view.error} ` + text;
  if (view.warnings?.length) text += ` ${plural(view.warnings.length, 'warning')}.`;
  const details = m || view.warnings?.length
    ? ` <button type="button" class="status-link" id="showFail">Show details</button>` : '';
  // The undo button is offered for 30 seconds after a bulk action, as the spec says.
  const undo = view.undoable ? ` <button type="button" class="status-link" id="undoJob" data-job="${esc(view.id)}">Undo</button>` : '';
  $('status').innerHTML = esc(text) + details + undo;
  // The timer keeps this job's own button. A later job has its own button and timer.
  const own = $('undoJob');
  if (own) setTimeout(() => own.remove(), 30000);
  renderProgress();
  await refreshMeta({followDefault: true}).catch(reportError);
  await run();
  // A user who types in another card of the review keeps the focus there.
  if (!$('review').contains(document.activeElement)) {
    if (inReview()) $('reviewH').focus({preventScroll: true}); else $('selectAll').focus();
  }
}

// A finished suggest job opens the review. Raindrop is not changed, so the list does not reload.
function finishSuggest(view) {
  renderProgress();
  const n = view.suggestions.length, m = view.failed.length;
  let text = view.status === 'failed' ? `Error: Suggestion failed: ${view.error} ` : '';
  text += `${view.status === 'cancelled' ? 'Suggestion cancelled. ' : ''}Suggested ${n}. No suggestion for ${m}.`;
  const details = m ? ' <button type="button" class="status-link" id="showFail">Show details</button>' : '';
  $('status').innerHTML = esc(text) + details;
  reportId = view.id;
  if (n) openSuggestions(view);
  else {
    // No review opens. The drawer leaves its "running" state now. Without this, it kept the job label.
    // The drawer that had the focus ("Cancel the update") is gone. The focus goes to "Select all", as after a job.
    const lost = !document.activeElement || document.activeElement === document.body || $('bulk').contains(document.activeElement);
    renderSelection();
    if (lost) $('selectAll').focus();
    setTimeout(() => { if (aiJob?.id === view.id) { aiJob = null; renderAiMarks(); } }, 5000);
  }
}
