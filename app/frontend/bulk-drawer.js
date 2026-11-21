// The page script, part 6 of 9: Undo, cancel and the failure list of a job, the bulk action delegates, the phone action sheet, the drawer position and the peek.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// Start the undo of a finished bulk action. The undo runs as a job, and the progress panel shows it.
async function undoJob(id) {
  $('status').textContent = '';
  let started;
  try {
    started = track(await postJson(`/api/bulk/${id}/undo`));
  } catch (err) {
    $('status').textContent = 'Error: Undo failed: ' + err.message;
    return;
  }
  renderProgress();
  $('jobCancel').focus();
  pollJob(started.id);
}

$('jobCancel').onclick = async () => {
  const view = shownJob();
  if (!view) return;
  $('jobCancel').disabled = true;
  try { await postJson(`/api/bulk/${view.id}/cancel`); }
  catch (err) { $('progText').textContent = 'Error: ' + err.message; }
  finally { $('jobCancel').disabled = false; }
};
document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('[data-bulk]')) adoptPeek();
  if (t.closest('[data-bulk="suggest"]')) startSuggest();
  else if (t.closest('[data-bulk]')) { bulkPanel(t.closest('[data-bulk]').dataset.bulk); document.querySelector('#bulkPanel select, #bulkPanel input')?.focus(); }
  else if (t.id === 'bulkGo') bulkApply();
  else if (t.id === 'bulkCancelPanel') { $('bulkPanel').hidden = true; $('bulkPanel').innerHTML = ''; document.querySelector('[data-bulk="move"]').focus(); }
  else if (t.id === 'bulkCreateFolder') bulkCreateFolder();
  else if (t.id === 'undoJob') undoJob(t.dataset.job);
  else if (t.id === 'showFail') {
    const view = jobs.get(reportId) ?? {failed: [], warnings: []};
    const rows = [...(view.failed || []).map(f => ({...f, kind: 'Not updated'})), ...(view.warnings || []).map(w => ({...w, kind: 'Warning'}))];
    $('failList').innerHTML = rows.map(f => `<li><span>${esc(f.title || `Bookmark #${f.id}`)}</span><span class="why">${esc(f.kind)}: ${esc(f.reason)}</span></li>`).join('');
    $('failDlg').showModal(); $('failClose').focus();
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'bulkFolder') { $('bulkNewFolder').hidden = t.value !== '__new__'; $('bulkErr').textContent = ''; bulkQuestion(); if (t.value === '__new__') $('bulkNewFolderName').focus(); }
  if (t.closest('#bulkPanel .picks')) { bulkQuestion(); $('bulkErr').textContent = ''; }
});
document.addEventListener('input', e => { if (e.target.id === 'bulkTags') { bulkQuestion(); $('bulkErr').textContent = ''; } });
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'bulkTags') { e.preventDefault(); bulkApply(); }
  if (e.target.id === 'bulkNewFolderName') { e.preventDefault(); bulkCreateFolder(); }
});
async function bulkCreateFolder() {
  $('bulkCreateFolder').disabled = true; $('bulkErr').textContent = '';
  try {
    const created = await createFolder($('bulkNewFolderName').value.trim());
    await refreshMeta();
    bulkPanel('move');
    $('bulkFolder').value = String(created.id);
    bulkQuestion();
    $('bulkGo').focus();
  } catch (err) {
    $('bulkCreateFolder').disabled = false;
    $('bulkErr').textContent = 'Error: Create folder failed: ' + err.message;
  }
}
$('failClose').onclick = () => $('failDlg').close();

// Phone: the bulk bar shows the count and an "Actions" button that opens the action sheet.
function closeBulkSheet() { document.body.classList.remove('bulk-open'); $('bulkActions').setAttribute('aria-expanded', 'false'); }
$('bulkActions').onclick = () => {
  const open = document.body.classList.toggle('bulk-open');
  $('bulkActions').setAttribute('aria-expanded', String(open));
};

// Wide screens: the bulk actions are a drawer to the right of the list (section 5.6).
// One ticked row on this page: the drawer is aligned to that row. Else the drawer fills the visible part
// of the list, with the actions in the middle. The drawer stays inside the visible part of the page.
const wideBulk = matchMedia('(min-width: 1100px)');
let placeQueued = false;
function queuePlaceBulk() {
  if (placeQueued) return;
  placeQueued = true;
  requestAnimationFrame(() => { placeQueued = false; placeBulk(); });
}
function placeBulk() {
  const bulk = $('bulk');
  const points = $('bulkPoints');
  if (bulk.hidden || !wideBulk.matches) {
    bulk.classList.remove('drawer', 'one');
    bulk.style.left = bulk.style.top = bulk.style.height = '';
    points.innerHTML = '';
    return;
  }
  const list = $('list').getBoundingClientRect();
  const view = $('appMain').getBoundingClientRect();
  const gap = 8;
  const minTop = view.top + gap, maxBottom = view.bottom - gap;
  const peekRow = bulk.classList.contains('peek') ? peekRowEl() : null;
  const reviewing = inReview();
  const rows = reviewing ? review.cards.map(c => document.querySelector(`#list .row[data-id="${c.s.id}"]`)).filter(Boolean)
    : peekRow ? [peekRow] : document.querySelectorAll('#list .row.selected');
  // A review with one card is aligned to its row, as one selected bookmark is.
  const one = reviewing ? review.cards.length === 1 && rows.length === 1 : Boolean(peekRow) || (!allMatching && selectionCount() === 1 && rows.length === 1 && !shownJob());
  bulk.classList.add('drawer');
  bulk.classList.toggle('one', one);
  bulk.style.left = `${Math.round(list.right + 24)}px`;
  bulk.style.height = '';
  const own = bulk.offsetHeight;
  let top, height;
  if (one) {
    top = rows[0].getBoundingClientRect().top;
    height = own;
  } else {
    top = Math.max(list.top, minTop);
    height = Math.max(Math.min(list.bottom, maxBottom) - top, own);
    bulk.style.height = `${Math.round(height)}px`;
  }
  top = Math.max(minTop, Math.min(top, maxBottom - height));
  bulk.style.top = `${Math.round(top)}px`;
  // A point on the left edge of the drawer, like the middle of "{", shows each selected row.
  // Only rows whose middle is next to the drawer get a point.
  const edge = Math.round(list.right + 24);
  points.innerHTML = [...rows].map(r => {
    const b = r.getBoundingClientRect();
    const mid = Math.round((b.top + b.bottom) / 2);
    return mid >= top + 14 && mid <= top + height - 14 && mid >= minTop && mid <= maxBottom
      ? `<span style="left:${edge}px;top:${mid}px"></span>` : '';
  }).join('');
}
// Peek: on a wide screen with a mouse, a hovered row shows the drawer for that bookmark. The drawer stays
// for a short time after the mouse leaves, so the user can move the mouse to it. A pass over another row
// on the way does not move the drawer, because a new row must be hovered for a short time first.
// A click on an action selects the bookmark, and then the action works as for a selection.
const canPeek = matchMedia('(min-width: 1100px) and (hover: hover)');
const PEEK_OPEN_MS = 120, PEEK_MOVE_MS = 300, PEEK_CLOSE_MS = 700;
let peekId = null, peekTimer = null;
function peekRowEl() {
  if (peekId === null || !canPeek.matches || editing[peekId]) return null;
  return document.querySelector(`#list .row[data-id="${peekId}"]`);
}
function peekLater(id, ms) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { peekId = id; renderSelection(); }, ms);
}
$('list').addEventListener('mouseover', e => {
  if (!canPeek.matches || selectionCount() || shownJob() || inReview()) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (id === peekId) { clearTimeout(peekTimer); return; }
  peekLater(id, peekId === null ? PEEK_OPEN_MS : PEEK_MOVE_MS);
});
$('list').addEventListener('mouseleave', () => { if (peekId !== null || peekTimer) peekLater(null, PEEK_CLOSE_MS); });
$('bulk').addEventListener('mouseenter', () => clearTimeout(peekTimer));
$('bulk').addEventListener('mouseleave', () => { if (peekId !== null) peekLater(null, PEEK_CLOSE_MS); });
// "Edit" in the drawer is for one bookmark on this page: the peeked one, or the one selected bookmark.
// It opens the editor of that row, as the Edit button of the row does.
function editTarget() {
  if (peekId !== null && peekRowEl()) return peekId;
  if (allMatching || selected.size !== 1 || shownJob()) return null;
  const id = selected.keys().next().value;
  return document.querySelector(`#list .row[data-id="${id}"]`) && !editing[id] ? id : null;
}
$('bulkEdit').onclick = () => {
  const id = editTarget();
  if (id === null) return;
  clearTimeout(peekTimer);
  document.querySelector(`[data-act="edit"][data-id="${id}"]`)?.click();
};

// The peeked bookmark becomes the selection before an action starts.
function adoptPeek() {
  const row = $('bulk').classList.contains('peek') ? peekRowEl() : null;
  if (!row) return;
  clearTimeout(peekTimer);
  selected.set(peekId, lastResults.find(b => b.id === peekId)?.tags ?? []);
  lastSel = peekId;
  peekId = null;
  renderSelection();
}

$('appMain').addEventListener('scroll', queuePlaceBulk, {passive: true});
window.addEventListener('resize', queuePlaceBulk);
wideBulk.addEventListener('change', queuePlaceBulk);
// A row editor, a bulk step or the progress panel changes a size. The drawer then moves again.
new ResizeObserver(queuePlaceBulk).observe($('list'));
new ResizeObserver(queuePlaceBulk).observe($('bulk'));
