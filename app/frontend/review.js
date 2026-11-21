// The page script, part 5 of 9: The review of a batch suggestion, and the AI marks on the rows.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// The review of a batch suggestion is in the drawer (section 5.6). Each card is one bookmark. A card can be
// applied, edited or cleared on its own. "Apply all" applies the cards that have a folder and are ready, or that
// the user changed (see applyAllCards). "Clear all"
// ends the review. Nothing is saved until an apply. An applied or cleared card leaves the drawer.
// The proposed new tags of a card are selected at the start. Apply and "Apply all" add them. "Edit" can remove one.
// A tag from the profile of the user has its own box on the card. The box is not checked at the start, so
// Apply and "Apply all" add a profile tag only after the user selected it.
// A bookmark that is in a folder keeps it: its card starts with the current folder, and the folder of the model
// is only a suggestion that the user can select (rules.js: reviewStart, reviewWaits, reviewInApplyAll, reviewChange).
let review = null; // {id, cards: [{s, folder, suggested, tags, newTags, profileTags, editing, edited}], busy, total, none, skipped, applied, same, jobs}
function inReview() { return Boolean(review && review.cards.length); }

function openSuggestions(view) {
  reviewId = view.id;
  // total: the bookmarks of the suggest job. none: the bookmarks with no suggestion. skipped: the bookmarks that
  // a cancelled job did not reach. applied: the bookmarks that the apply jobs of this review changed.
  // same: the bookmarks that already had the folder and tags of the apply. jobs: the apply jobs that still run.
  review = {id: view.id, busy: false, total: view.total, none: view.failed.length,
    skipped: Math.max(0, view.total - view.suggestions.length - view.failed.length),
    applied: 0, same: 0, jobs: new Set(), cards: view.suggestions.map(s => ({
      s, ...reviewStart(s),
      tags: s.tags.join(', '), newTags: new Set(s.new_tags), profileTags: new Set(), editing: false, edited: false,
    }))};
  $('reviewErr').textContent = '';
  renderReview();
  renderSelection();
  $('reviewH').focus({preventScroll: true});
}

function endReview() {
  // When the focus is in the review, it goes to "Select all", as after a job. Else it would go to the page body.
  const hadFocus = $('review').contains(document.activeElement);
  review = null; reviewId = null; aiJob = null;
  renderReview();
  renderAiMarks();
  renderSelection();
  if (hadFocus) $('selectAll').focus();
}

function reviewTags(c) {
  const out = [];
  for (const t of [...splitTags(c.tags), ...c.newTags, ...(c.profileTags ?? [])]) {
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
// "Apply all" takes a card with a folder that is ready, or whose folder or tags the user changed. A card whose
// only suggestion is a different folder waits for the user (rules.js).
function applyAllCards() { return review ? review.cards.filter(c => reviewInApplyAll(c, reviewTags(c))) : []; }

function reviewCard(c) {
  const s = c.s, id = s.id, busy = review.busy ? ' disabled' : '';
  const i = lastResults.findIndex(b => b.id === id);
  const num = i >= 0 ? `<span class="rownum">${pageInfo.first + i + 1}</span> ` : '';
  // "Ready" only when the card can go in "Apply all" as it is. A proposed folder for an Unsorted bookmark needs
  // the user. For a bookmark in a folder, the card is ready with its current folder, unless its only suggestion
  // is a different folder: then it waits for the user.
  const waits = s.status === 'ready' && reviewWaits(c, reviewTags(c));
  const ready = s.status === 'ready' && (reviewSorted(s) ? !waits : s.folder.action === 'existing');
  const label = ready ? 'Ready' : waits ? 'Folder change suggested'
    : s.status === 'ready' && s.folder.action === 'propose' ? 'New folder proposed' : 'Needs review';
  // The folder of the model for a bookmark that is in a folder. The user selects it, or keeps the current folder.
  const sug = c.suggested, sugName = sug ? esc(sug.name) + (sug.isNew ? ' (new folder)' : '') : '';
  // The tags from the profile, each with a box that is not checked at the start. They show in the two states of the card.
  const fromProfile = (s.profile_tags ?? []).map((p, k) => `<label class="rc-newtag"><input type="checkbox" id="rcp-${id}-${k}" data-rc-ptag="${id}" value="${esc(p.tag)}"${c.profileTags.has(p.tag) ? ' checked' : ''}${busy}> Add tag: ${esc(p.tag)} <span class="muted">(from your profile: ${esc(p.entryName)})</span></label>`).join('');
  const profileBox = fromProfile ? `<div class="rc-new"><span class="lbl">From your profile</span>${fromProfile}</div>` : '';
  const head = `<div class="rc-title">${num}${esc(s.title || `Bookmark #${id}`)}</div>
    <div class="rc-why${ready ? '' : ' warn-text'}">${label}: ${esc(s.reason)}</div>`;
  let body;
  if (c.editing) {
    const opts = metaFolders.map(f => `<option value="${esc(f.id)}"${String(f.id) === c.folder ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
    const proposal = s.folder.action === 'propose' ? `<option value="new"${c.folder === 'new' ? ' selected' : ''}>New folder: ${esc(s.folder.name)}</option>` : '';
    // Each checkbox has a stable ID, so the focus stays on it after the redraw.
    const newTags = s.new_tags.map((t, k) => `<label class="rc-newtag"><input type="checkbox" id="rcn-${id}-${k}" data-rc-newtag="${id}" value="${esc(t)}"${c.newTags.has(t) ? ' checked' : ''}> Add tag: ${esc(t)}</label>`).join('');
    body = `<div class="field"><label for="rcf-${id}">Folder</label><select id="rcf-${id}" data-rc-folder="${id}"><option value="">Choose a folder</option>${opts}${proposal}</select></div>
      <div class="field"><label for="rct-${id}">Tags (comma separated)</label><input id="rct-${id}" data-rc-tags="${id}" value="${esc(c.tags)}" list="taglist" autocomplete="off"></div>
      ${sug ? `<div class="rc-line muted">Suggested folder: ${sugName}. The bookmark stays in "${esc(s.current_folder)}" unless you choose a different folder.</div>` : ''}
      ${newTags ? `<div class="rc-new"><span class="lbl">Proposed new tags</span>${newTags}</div>` : ''}${profileBox}`;
  } else {
    const label = c.folder === 'new' ? `${s.folder.name} (new folder)` : metaFolders.find(f => String(f.id) === c.folder)?.label;
    const folder = label ? esc(label)
      : s.folder.action === 'propose' ? `<span class="warn-text">${esc(s.folder.name)} (new folder, proposed)</span>`
      : '<span class="warn-text">Choose a folder</span>';
    // reviewTags keeps the order: the tags of the field first, then the selected new tags. A new tag gets "(new)".
    const tags = reviewTags(c), base = reviewTags({tags: c.tags, newTags: []}).length;
    const shown = tags.map((t, k) => k < base ? t : c.profileTags.has(t) ? `${t} (profile)` : `${t} (new)`);
    const pending = s.new_tags.filter(t => !c.newTags.has(t));
    // The suggested folder shows with a button that selects it. After that, a button goes back to the current folder.
    const move = !sug ? ''
      : c.folder === sug.value ? `<div class="rc-line"><span class="muted">Moves from "${esc(s.current_folder)}".</span> <button class="btn sm" data-rc="keepfolder" data-id="${id}"${busy}>Keep the current folder</button></div>`
      : c.folder === String(s.current_folder_id) ? `<div class="rc-line"><span class="lbl">Suggested folder</span> ${sugName} <button class="btn sm" data-rc="usefolder" data-id="${id}"${busy}>${sug.isNew ? 'Use the new folder' : 'Move to this folder'}</button></div>`
      : '';
    body = `<div class="rc-line"><span class="lbl">Folder</span> ${folder}</div>${move}
      <div class="rc-line"><span class="lbl">Tags</span> ${tags.length ? esc(shown.join(', ')) : '<span class="warn-text">none</span>'}</div>
      ${pending.length ? `<div class="rc-line muted">Proposed new tags not used: ${esc(pending.join(', '))}. Choose Edit to add them.</div>` : ''}${profileBox}`;
  }
  // With the proposed folder (chosen, or no folder chosen yet), Apply creates the folder.
  const create = s.folder.action === 'propose' && (c.folder === 'new' || !c.folder);
  // A card that waits would save nothing, so Apply is off until the user selects a folder or changes the card.
  const idle = reviewWaits(c, reviewTags(c));
  return `<li class="rc" data-rc-card="${id}">${head}${body}
    <div class="line"><button class="btn sm primary" data-rc="apply" data-id="${id}"${(c.folder || create) && !idle ? busy : ' disabled'}>${create ? 'Create folder and apply' : 'Apply'}</button>
      <button class="btn sm" data-rc="edit" data-id="${id}" aria-expanded="${c.editing}"${busy}>${c.editing ? 'Done' : 'Edit'}</button>
      <button class="btn sm quiet" data-rc="clear" data-id="${id}"${busy}>Clear</button></div></li>`;
}

// Draw the review. The focus and the cursor stay in the same control.
function renderReview() {
  const on = inReview();
  $('review').hidden = !on;
  if (!on) { $('reviewList').innerHTML = ''; return; }
  const a = document.activeElement;
  const key = a && $('review').contains(a) && a.id ? a.id : a?.dataset?.rc ? `[data-rc="${a.dataset.rc}"][data-id="${a.dataset.id}"]` : null;
  const caret = a && 'selectionStart' in a ? a.selectionStart : null;
  $('reviewList').innerHTML = review.cards.map(reviewCard).join('');
  renderReviewHead();
  if (key) {
    const el = key.startsWith('[') ? $('review').querySelector(key) : $(key);
    if (el) { el.focus({preventScroll: true}); if (caret !== null && 'setSelectionRange' in el) try { el.setSelectionRange(caret, caret); } catch { /* not a text box */ } }
  }
}
function renderReviewHead() {
  // With one card, "Apply all" and "Clear all" do the same as the buttons of the card. They do not show.
  const single = review.cards.length === 1;
  $('reviewAll').hidden = single;
  if (single && $('reviewAll').contains(document.activeElement)) $('reviewH').focus({preventScroll: true});
  const k = applyAllCards().length, rest = single ? 0 : review.cards.length - k;
  $('reviewApplyAll').textContent = k ? `Apply all (${k})` : 'Apply all';
  $('reviewApplyAll').disabled = !k || review.busy;
  $('reviewClearAll').disabled = review.busy;
  const counts = reviewCounts();
  $('reviewHint').textContent = reviewSummary(single ? 0 : k, rest, counts);
  // The head says "saved" only when Raindrop has at least one bookmark of this review in its applied state.
  $('reviewSaved').textContent = counts.applied + counts.same
    ? 'Applied bookmarks are saved in Raindrop. The cards below are not saved yet.'
    : 'Nothing is saved yet. Apply also adds the proposed new tags. A bookmark that is in a folder stays there unless you select the suggested folder. A new folder is used only when you choose it.';
}

// The counts of the apply jobs of this review: the finished jobs, and the progress of the jobs that still run.
function reviewCounts() {
  let applied = review.applied, same = review.same ?? 0, saving = 0;
  for (const id of review.jobs) {
    const j = jobs.get(id);
    if (!j) continue;
    applied += j.done - (j.failed?.length ?? 0) - (j.unchanged ?? 0);
    same += j.unchanged ?? 0;
    saving += Math.max(0, j.total - j.done);
  }
  return {applied, same, saving};
}

// The summary of the review, for example "20 of 50 changed. 27 need your decision. 3 got no suggestion.".
// An apply job that still runs adds the bookmarks it saved, and "Saving <n> more.". A bookmark that already
// had the folder and tags is not counted as changed. It shows as "<n> already as suggested.".
function reviewSummary(k, rest, {applied, same, saving} = reviewCounts()) {
  const parts = [];
  if (applied) parts.push(`${applied} of ${review.total} changed.`);
  if (same) parts.push(`${same} already as suggested.`);
  if (saving) parts.push(`Saving ${saving} more.`);
  if (k) parts.push(`${k} ready for "Apply all".`);
  if (rest) parts.push(`${rest} ${rest === 1 ? 'needs' : 'need'} your decision: apply ${rest === 1 ? 'it' : 'each one'}, or choose Edit.`);
  if (review.none) parts.push(`${review.none} got no suggestion.`);
  if (review.skipped) parts.push(`${review.skipped} not done: the suggestion was cancelled.`);
  return parts.join(' ');
}

// Save cards as one apply job. A proposed folder is sent as a new folder name. The server creates it once.
async function applyCards(cards, {create = false} = {}) {
  if (!cards.length) return;
  const changes = cards.map(c => reviewChange(c, reviewTags(c), create));
  review.busy = true; $('reviewErr').textContent = ''; renderReview();
  let started;
  try {
    started = track(await postJson('/api/bulk', {action: 'apply', from: review.id, changes}));
  } catch (err) {
    review.busy = false; renderReview();
    $('reviewErr').textContent = 'Error: Apply failed: ' + err.message;
    return;
  }
  review.busy = false;
  review.jobs.add(started.id);
  const done = new Set(cards);
  review.cards = review.cards.filter(c => !done.has(c));
  if (!review.cards.length) endReview(); else { renderReview(); renderAiMarks(); }
  showJob(started.id);
}

$('reviewList').addEventListener('click', e => {
  const b = e.target.closest('[data-rc]');
  if (!b || !review) return;
  const c = review.cards.find(x => x.s.id === Number(b.dataset.id));
  if (!c) return;
  // "Create folder and apply" sends the proposed folder, but the card keeps no folder. If the request fails,
  // the card stays out of "Apply all".
  if (b.dataset.rc === 'apply') applyCards([c], {create: true});
  else if (b.dataset.rc === 'usefolder' || b.dataset.rc === 'keepfolder') {
    // The user selects the suggested folder, or goes back to the current one. Both are a decision of the user,
    // so the card counts as changed. The focus goes to the button that takes the place of this one.
    const use = b.dataset.rc === 'usefolder';
    c.folder = use ? c.suggested.value : String(c.s.current_folder_id);
    c.edited = true;
    renderReview();
    $('review').querySelector(`[data-rc="${use ? 'keepfolder' : 'usefolder'}"][data-id="${c.s.id}"]`)?.focus({preventScroll: true});
  } else if (b.dataset.rc === 'edit') {
    c.editing = !c.editing;
    renderReview();
    if (c.editing) $(`rcf-${c.s.id}`)?.focus();
  } else if (b.dataset.rc === 'clear') {
    review.cards = review.cards.filter(x => x !== c);
    if (!review.cards.length) { endReview(); return; }
    renderReview(); renderAiMarks(); queuePlaceBulk();
    $('reviewH').focus({preventScroll: true});
  }
});
$('reviewList').addEventListener('change', e => {
  const t = e.target, c = review?.cards.find(x => x.s.id === Number(t.dataset.rcFolder ?? t.dataset.rcNewtag ?? t.dataset.rcPtag));
  if (!c) return;
  if (t.dataset.rcFolder !== undefined) c.folder = t.value;
  else if (t.dataset.rcPtag !== undefined) { if (t.checked) c.profileTags.add(t.value); else c.profileTags.delete(t.value); }
  else if (t.checked) c.newTags.add(t.value); else c.newTags.delete(t.value);
  c.edited = true;
  renderReview();
});
$('reviewList').addEventListener('input', e => {
  const c = review?.cards.find(x => x.s.id === Number(e.target.dataset.rcTags));
  if (c) { c.tags = e.target.value; c.edited = true; renderReviewHead(); }
});
$('reviewApplyAll').onclick = () => applyCards(applyAllCards());
$('reviewClearAll').onclick = endReview;

// AI marks on the rows (section 5.6). While the model works on a bookmark, the row shows a bouncing drop.
// When the suggestion for it is ready, the drop changes to a check in the same colour.
let aiJob = null; // the last batch suggestion: {id, ids, filter}. With "all matching", ids is null and filter has the filters.
function aiMark(id) {
  if (suggesting.has(id)) return 'work';
  const view = aiJob && jobs.get(aiJob.id);
  if (!view) return '';
  // During the review, only a bookmark with an open card keeps its check.
  if (view.suggestions?.some(s => s.id === id)) return !review || review.cards.some(c => c.s.id === id) ? 'done' : '';
  if (view.failed?.some(f => f.id === id)) return '';
  const inJob = aiJob.ids ? aiJob.ids.has(id) : JSON.stringify(Object.fromEntries(filterParams())) === aiJob.filter;
  return view.status === 'running' && inJob ? 'work' : '';
}
function aiMarkHtml(state) {
  if (state === 'work') return '<span class="ai-mark work" role="img" aria-label="The model works on this bookmark" title="The model works on this bookmark"><i></i></span>';
  if (state === 'done') return '<span class="ai-mark done" role="img" aria-label="Suggestion ready" title="Suggestion ready"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 9.5l3.2 3.2L14 5.8"/></svg></span>';
  return '';
}
// Only a row whose state changed is redrawn, so a running animation does not start again.
function renderAiMarks() {
  document.querySelectorAll('#list .row').forEach(r => {
    const state = aiMark(Number(r.dataset.id));
    const old = r.querySelector('.ai-mark');
    const was = old ? (old.classList.contains('work') ? 'work' : 'done') : '';
    if (was === state) return;
    old?.remove();
    if (state) r.querySelector('.rownum')?.insertAdjacentHTML('afterend', aiMarkHtml(state));
  });
}
