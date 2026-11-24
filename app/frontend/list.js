// The page script, part 3 of 9: The bookmark list, the duplicate view, the cards and the row editor.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- The list ----
// The filters of the list that the page shows now, as text. Null before the first list.
let listFilter = null;
function filterParams() {
  const p = new URLSearchParams({q: $('q').value, tags: $('tags').value, collection: folder,
                                 sort: $('sort').value, visited: $('visited').value, status: $('statusFilter').value, preset});
  if (preset === 'custom') { p.set('from', $('from').value); p.set('to', $('to').value); }
  if ($('statusFilter').value === 'needs' && needsKind) p.set('needs', needsKind);
  p.set('tz', TZ);
  return p;
}

// background: a live reload while a job runs (liveReload). It draws nothing if the user works in the list now.
async function run({background = false} = {}) {
  const err = dateError();
  $('dateErr').textContent = err;
  if (err) { $('count').textContent = 'Fix the dates to see results.'; return; }
  const seq = ++runSeq;
  const p = filterParams();
  // The filter words of this request. A later change of the filters cannot mix new words with an old count.
  const where = filterSummary();
  const asked = p.toString(); // the filters of this request, without the page
  p.set('page', String(page)); p.set('pageSize', String(pageSize));
  let d;
  try {
    d = await api('/api/bookmarks?' + p);
  } catch (err) {
    if (seq === runSeq) $('count').textContent = 'Error: ' + err.message;
    return;
  }
  if (seq !== runSeq) return; // a newer search has started, so this answer is out of date
  // The focus can move into the list while the request waits. Then the background answer is dropped.
  if (background && listBusy()) { liveAt = 0; return; }
  loaded = true;
  listFilter = asked;
  lastResults = d.results;
  lastGroups = d.groups ?? null;
  // first is the position of the first row on this page. Row numbers count from it.
  pageInfo = {matched: d.matched, total: d.total, pages: d.pages, first: (d.page - 1) * d.pageSize};
  page = d.page;
  const from = (d.page - 1) * d.pageSize + 1, to = from + d.results.length - 1;
  if (d.total === 0) $('count').textContent = 'No bookmarks yet.';
  else {
    const tail = where ? ` ${where}` : '';
    if (lastGroups) {
      const n = kind => lastGroups.filter(g => g.section === kind).length;
      $('count').textContent = `${plural(n('definite'), 'duplicate group')} and ${plural(n('possible'), 'possible group')}${tail}`;
    } else if (d.matched === 0) $('count').textContent = `No bookmarks match${tail}.`;
    else if (activeFilterCount() === 0 && d.pages === 1) $('count').textContent = `${plural(d.matched, 'bookmark')}`;
    else $('count').textContent = `Showing ${from}–${to} of ${plural(d.matched, 'bookmark')}${tail}`;
  }
  filteredPresets = d.presets ?? null;
  needsCounts = d.needsCounts ?? null;
  renderPresetCounts();
  renderNeedsSwitch();
  renderPaging();
  render();
}

function renderPaging() {
  document.querySelectorAll('[data-paging]').forEach(nav => {
    if (!loaded || pageInfo.matched === 0) { nav.innerHTML = ''; return; }
    nav.innerHTML = `<button class="btn sm" data-page="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="page">Page ${page} of ${pageInfo.pages}</span>
      <button class="btn sm" data-page="next" ${page >= pageInfo.pages ? 'disabled' : ''}>Next</button>
      <label class="lbl">Page size <select data-pagesize aria-label="Page size">${[25, 50, 100].map(n => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (b) goPage(b.dataset.page === 'next' ? 1 : -1);
});
// Moves one page on. The list starts again at the top of the page.
function goPage(step) {
  page += step;
  return run().then(() => { $('appMain').scrollTo({top: 0}); window.scrollTo({top: 0}); });
}
document.addEventListener('change', e => {
  if (!e.target.matches('[data-pagesize]')) return;
  pageSize = Number(e.target.value);
  page = 1;
  run();
});

// Move focus into the editor of one bookmark, to its folder select.
function focusEditor(id) {
  document.querySelector(`[data-act="folder"][data-id="${id}"]`)?.focus();
}

// Move focus back to the bookmark after its editor closes: the Edit button of that card.
function returnFocus(id) {
  const target = document.querySelector(`[data-act="edit"][data-id="${id}"]`) ?? document.querySelector(`a[href="/go/${id}"]`);
  target?.focus();
}

// The note of a bookmark as a text box holds it: each line end is "\n".
const noteOf = item => (item?.note ?? '').replace(/\r\n?/g, '\n');

// The note fields of a new editor. `text` is the text of the note box. `noteBase` is the note when the editor
// opened. A list refresh can change the note of the bookmark while the editor is open, so the editor
// compares its text with `noteBase`, not with the bookmark.
const noteStart = item => ({text: noteOf(item), noteBase: noteOf(item)});

// True when the editor holds the same folder and tags as the saved bookmark, and the note that it started with.
function unchanged(id) {
  const item = lastResults.find(x => x.id === id);
  const ed = editing[id];
  return Boolean(item) && !ed.creating && String(ed.folderId) === String(item.collection_id) &&
         ed.tags.length === item.tags.length && ed.tags.every((t, i) => t === item.tags[i]) && ed.text === ed.noteBase;
}

function render() {
  if (!loaded) return;
  if (inReview()) renderReview(); // the row numbers on the cards follow the page
  $('list').innerHTML = lastGroups ? dupesHtml() : lastResults.map((b, i) => card(b, pageInfo.first + i + 1)).join('') ||
    `<li class="empty">${pageInfo.total === 0 ? 'No bookmarks yet.' : 'No bookmarks match.'}</li>`;
  renderSelection();
}

// The duplicate view: the section "Duplicates", then "Possible duplicates". Each group has a header with its
// reason and two actions. In a group, the newest bookmark comes first. An empty section says so.
// A bookmark can be in a definite group and in a possible group. It shows one time, in the first group, so
// the rows are in the order of lastResults (Shift+click uses that order). The header of a later group says
// how many of its bookmarks are in a group above.
function dupesHtml() {
  const byId = new Map(lastResults.map(b => [b.id, b]));
  const shown = new Set();
  let n = 0;
  const section = (kind, title) => {
    const groups = lastGroups.map((g, i) => [g, i]).filter(([g]) => g.section === kind);
    const head = `<li class="dupe-section"><h2>${title}</h2></li>`;
    if (!groups.length) return head + '<li class="empty">No duplicates found.</li>';
    return head + groups.map(([g, i]) => {
      const why = kind === 'definite' ? `The same ${g.note || 'page'}.` : `Possibly the same page: ${g.why}.`;
      const fresh = g.ids.filter(id => !shown.has(id));
      const above = g.ids.length - fresh.length;
      fresh.forEach(id => shown.add(id));
      const where = above ? ` ${above === g.ids.length ? 'All' : above} of them ${above === 1 ? 'is' : 'are'} in a group above.` : '';
      // "Keep recent" would also move bookmarks that show only in a group above. The user must see each row
      // that an action moves, so the button is off. After the group above is done, this group is new again.
      const recent = above
        ? `<button class="btn sm" disabled aria-describedby="dupeAbove${i}">Keep recent</button><span class="dupe-hint" id="dupeAbove${i}">Do the group above first.</span>`
        : `<button class="btn sm" data-keep-recent="${i}" title="Keep the newest bookmark and move the others to the folder ${ARCHIVE}">Keep recent</button>`;
      return `<li class="dupe-group"><span>${plural(g.ids.length, 'bookmark')}.${where} ${esc(why)}</span>
          ${recent}
          <button class="btn sm" data-keep-all="${i}" title="Keep all the bookmarks of this group and hide the group">Keep all</button></li>` +
        fresh.map(id => card(byId.get(id), ++n)).join('');
    }).join('');
  };
  return section('definite', 'Duplicates') + section('possible', 'Possible duplicates');
}

// In the duplicate view, the card shows the full link, so the user can compare the links of a group.
function dupeHtml(b) {
  return lastGroups ? `<div class="dupe-link">${esc(b.link)}</div>` : '';
}

// "Keep recent": select the older bookmarks of the group and open the Archive step. The user confirms there.
// The move is a bulk job, so its progress and Undo are the same as for the bulk Archive.
function keepRecent(g) {
  const byId = new Map(lastResults.map(b => [b.id, b]));
  clearSelection();
  for (const id of g.ids.slice(1)) selected.set(id, byId.get(id)?.tags ?? []);
  renderSelection();
  bulkPanel('archive');
  $('bulkGo')?.focus();
}

// "Keep all": the server stores the group, and the group does not show again. Undo shows it again.
async function keepAll(g, keep = true) {
  try {
    await postJson(keep ? '/api/duplicates/keep' : '/api/duplicates/unkeep', {section: g.section, key: g.key});
  } catch (err) {
    if (keep) {
      $('status').textContent = 'Error: Keep all failed: ' + err.message;
      render(); // draws the list again from the last answer, so the "Keep all" button works again
      focusKeepAll(g);
    } else {
      // The Undo link stays, so the user can try again.
      $('status').innerHTML = `${esc('Error: Undo failed: ' + err.message)} <button type="button" class="status-link" id="unkeepGroup">Undo</button>`;
      $('unkeepGroup').focus();
    }
    return;
  }
  keptGroup = keep ? g : null;
  $('status').innerHTML = keep
    ? `${esc('Group kept. It shows again only when a new bookmark joins the group.')} <button type="button" class="status-link" id="unkeepGroup">Undo</button>`
    : esc('The group shows again.');
  await run();
  // The redraw removes the button that had the focus. Keep the focus near the action.
  if (keep) $('unkeepGroup')?.focus();
  else focusKeepAll(g);
}
// The "Keep all" button of a group, or the first control of the list when the group is not there.
function focusKeepAll(g) {
  const i = (lastGroups ?? []).findIndex(x => x.section === g.section && x.key === g.key);
  (document.querySelector(`[data-keep-all="${i}"]`) ?? $('selectAll')).focus();
}

document.addEventListener('click', e => {
  const recent = e.target.closest('[data-keep-recent]');
  if (recent && lastGroups) keepRecent(lastGroups[Number(recent.dataset.keepRecent)]);
  const all = e.target.closest('[data-keep-all]');
  if (all && lastGroups) { all.disabled = true; keepAll(lastGroups[Number(all.dataset.keepAll)]); }
  if (e.target.id === 'unkeepGroup' && keptGroup) keepAll(keptGroup, false);
});

// n is the row number in the whole result, not only on this page.
function card(b, n) {
  const ed = editing[b.id];
  const sel = selected.has(b.id);
  // A text search shows all dates. Each result then shows the date preset that it belongs to.
  const period = $('q').value.trim() ? {today: 'Today', last7: 'Last 7 days', last30: 'Last 30 days', older: 'Older than 30 days'}[b.period] : '';
  const badges = (b.is_new ? '<span class="badge new">New</span>' : '') +
                 (b.needs && !b.is_new ? '<span class="badge needs">No folder or tags</span>' : '') +
                 (b.dupes ? `<span class="badge dupe">Same URL as ${plural(b.dupes, 'other')}</span>`
                  : b.maybe_dupes ? `<span class="badge maybe">Possibly same URL as ${plural(b.maybe_dupes, 'other')}</span>` : '');
  const visit = b.visits ? `visited ${b.visits}× (last ${esc(localDateTime(b.last_visit))})` : 'not visited';
  const webLink = /^https?:\/\//.test(b.link);
  const title = webLink
    ? `<a class="title" href="/go/${b.id}" target="_blank" rel="noopener" aria-label="${esc(b.title)}, opens in a new tab" title="${esc(b.title)}">${esc(b.title)}</a>`
    : `<span class="title" title="${esc(b.title)}">${esc(b.title)}</span><span class="warn-text">This link cannot be opened.</span>`;
  const tags = ed ? ed.tags : b.tags;
  const chips = tags.map(t => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('');
  let action = '';
  if (ed) action = editorHtml(b, ed);
  else {
    // Every card can be edited. Cards that are new or have no folder or tags can also get a suggestion.
    // A redrawn card keeps the disabled state of a pending suggestion. Otherwise a click could start a second one.
    const pending = suggesting.has(b.id);
    const suggest = b.is_new || b.needs
      ? `<button class="btn sm" data-act="suggest" data-id="${b.id}" ${pending ? 'disabled' : ''} title="Sends the title, link, note, excerpt, current folder and tags of this bookmark, your folder names, your known tags and the active entries of My context to the language model">${pending ? 'Asking the model...' : 'Suggest folder and tags'}</button>`
      : '';
    action = `<div class="actions"><button class="btn sm" data-act="edit" data-id="${b.id}" ${pending ? 'disabled' : ''}>Edit</button>${suggest}</div>`;
  }
  return `
    <li class="row${sel ? ' selected' : ''}" data-id="${b.id}">
      <input class="chk" type="checkbox" data-sel="${b.id}" ${sel ? 'checked' : ''} aria-label="Select ${esc(b.title)}">
      <span class="tile" style="--h:${hue(b.collection_id)}" aria-hidden="true">${esc((b.domain || '?')[0].toUpperCase())}</span>
      <div class="body">
        <div class="title-line"><span class="rownum">${n}</span>${aiMarkHtml(aiMark(b.id))}${title}${badges}</div>
        <div class="meta">${[esc(b.domain), esc(b.collection), `<span class="d">${esc(localDateTime(b.created))}</span> (${ago(b.created)})`, period, visit].filter(Boolean).map(x => `<span>${x}</span>`).join('')}</div>
        ${dupeHtml(b)}
        ${b.excerpt ? `<div class="excerpt">${esc(b.excerpt)}</div>` : ''}
        ${b.note ? `<div class="note"><span class="lbl">Note</span>${esc(b.note)}</div>` : ''}
      </div>
      <div class="chips">${chips}</div>
      ${action}
    </li>`;
}

// The suggestion of the model in the editor: its reason, and a folder that the user can select.
// A bookmark that is in a folder keeps it unless the user selects the suggested folder. Nothing is created here.
function noteHtml(b, ed) {
  const n = suggestionNote(ed.note, ed.folderId), off = ed.busy ? 'disabled' : '';
  const folder = !n.folder ? ''
    : n.folder.selected ? `<div class="muted">Suggested folder: ${esc(n.folder.label)} (selected).</div>`
    : `<div>Suggested folder: ${esc(n.folder.label)} <button class="btn sm" data-act="usefolder" data-id="${b.id}" ${off}>Move to this folder</button></div>`;
  // The button opens the "New folder name" box with the proposed name. "Create folder" creates it.
  const made = metaFolders.some(f => f.label === n.proposed);
  const proposed = !n.proposed ? ''
    : `<div>The model proposed a new folder: ${esc(n.proposed)}. ${made || ed.creating ? '' : `<button class="btn sm" data-act="useproposed" data-id="${b.id}" ${off}>Use this name</button>`}</div>`;
  // A tag from the profile has a box that is not checked at first. A checked box adds the tag to the tags of the editor.
  const has = tag => ed.tags.some(t => t.toLowerCase() === tag.toLowerCase());
  const profile = n.profile.map((p, k) => `<label class="ed-ptag"><input type="checkbox" id="ptag-${b.id}-${k}" data-act="ptag" data-id="${b.id}" value="${esc(p.tag)}"${has(p.tag) ? ' checked' : ''} ${off}> Add tag: ${esc(p.tag)} <span class="muted">(from your profile: ${esc(p.entryName)})</span></label>`).join('');
  return `<div class="ed-note">
        ${n.reason ? `<div class="${n.warn ? 'warn-text' : 'muted'}">Suggestion: ${esc(n.reason)}</div>` : ''}
        ${folder}${proposed}
        ${n.left ? `<div class="muted">${esc(n.left)}</div>` : ''}
        ${profile}
      </div>`;
}

function editorHtml(b, ed) {
  const opts = metaFolders.map(f => `<option value="${esc(f.id)}" ${String(f.id) === String(ed.folderId) && !ed.creating ? 'selected' : ''}>${esc(f.label)}</option>`).join('') +
               `<option value="__new__" ${ed.creating ? 'selected' : ''}>+ Create a new folder...</option>`;
  const newBox = ed.creating ? `
      <div class="field"><label for="newfolder-${b.id}">New folder name</label>
        <div class="line">
          <input id="newfolder-${b.id}" data-act="newfolder-name" data-id="${b.id}" placeholder="New folder name" value="${esc(ed.newName || '')}" maxlength="100">
          <button class="btn sm" data-act="newfolder-ok" data-id="${b.id}" ${ed.busy ? 'disabled' : ''}>Create folder</button>
          <button class="btn sm" data-act="newfolder-cancel" data-id="${b.id}" ${ed.busy ? 'disabled' : ''}>Cancel</button>
        </div></div>` : '';
  const chips = ed.tags.map(t => `<span class="chip">${esc(t)}<button type="button" class="x" data-act="rmtag" data-id="${b.id}" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
  const confirm = ed.confirmDiscard ? `
      <div class="confirm">Discard the changes to this bookmark?
        <button class="btn sm" data-act="discard-yes" data-id="${b.id}">Discard</button>
        <button class="btn sm" data-act="discard-no" data-id="${b.id}">Keep editing</button>
      </div>` : '';
  return `
    <div class="editor" role="group" aria-label="Edit ${esc(b.title)}">
      ${ed.note ? noteHtml(b, ed) : ''}
      <div class="line">
        <div class="field"><label for="folder-${b.id}">Folder</label><select id="folder-${b.id}" data-act="folder" data-id="${b.id}">${opts}</select></div>
        ${newBox}
      </div>
      <div class="field"><label for="note-${b.id}">Note</label><textarea id="note-${b.id}" data-act="notetext" data-id="${b.id}" rows="3" maxlength="${NOTE_MAX}" dir="auto" placeholder="Your note for this bookmark">
${esc(ed.text ?? '')}</textarea></div>
      <div class="tags-row"><span class="lbl">Tags</span>${chips || '<span class="none">none</span>'}</div>
      <div class="line">
        <div class="field"><label for="newtag-${b.id}">Add tag</label><input id="newtag-${b.id}" data-act="newtag" data-id="${b.id}" aria-label="Add tag" placeholder="Add tag, press Enter" value="${esc(ed.draft || '')}" list="taglist" autocomplete="off"></div>
        <button class="btn sm primary" data-act="save" data-id="${b.id}" ${ed.busy ? 'disabled' : ''}>Save</button>
        <button class="btn sm" data-act="discard" data-id="${b.id}" ${ed.busy ? 'disabled' : ''}>Discard</button>
        <button class="btn sm" data-act="archive" data-id="${b.id}" ${ed.busy ? 'disabled' : ''} title="Save the tags and move this bookmark to the folder ${ARCHIVE}">Archive</button>
      </div>
      <span class="err" role="alert">${esc(ed.error || '')}</span>
      <span class="warn-text">${esc(ed.warn || '')}</span>
      ${confirm}
    </div>`;
}

// Update one card in place after a save, so the list does not jump.
function applySaved(id, d) {
  const item = lastResults.find(x => x.id === id);
  if (item) { item.is_new = false; item.needs = false; item.tags = d.tags; item.collection = d.label; item.collection_id = d.folderId; item.note = d.note; }
  if (selected.has(id)) selected.set(id, d.tags);
}

$('list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'suggest') {
    // One suggestion at a time for each bookmark. A second click would start a second request.
    if (suggesting.has(id)) return;
    // While the model answers, Edit is off. Otherwise the answer would replace what the user edits.
    suggesting.add(id);
    btn.disabled = true; btn.textContent = 'Asking the model...';
    const edit = document.querySelector(`[data-act="edit"][data-id="${id}"]`);
    if (edit) edit.disabled = true;
    renderAiMarks();
    // The status line is a live region. Its text is announced while the model answers.
    const statusBefore = $('status').textContent;
    $('status').textContent = 'Asking the model...';
    try {
      const d = await postJson('/api/suggest', {id});
      // note: the answer of the model. The editor shows its reason and its folder suggestion.
      editing[id] = {folderId: String(d.folderId), tags: d.tags, note: d, ...noteStart(lastResults.find(x => x.id === id))};
    } catch (err) {
      const item = lastResults.find(x => x.id === id);
      editing[id] = {folderId: String(item.collection_id), tags: [...item.tags], ...noteStart(item), error: 'Error: Suggestion failed: ' + err.message};
    }
    suggesting.delete(id);
    $('status').textContent = statusBefore;
    render();
    focusEditor(id);
  } else if (act === 'edit') {
    // Edit is ignored while a suggestion is pending. See the suggest branch.
    if (suggesting.has(id)) return;
    // The editor starts with the bookmark's current folder, tags and note. Nothing is saved until Save.
    const item = lastResults.find(x => x.id === id);
    editing[id] = {folderId: String(item.collection_id), tags: [...item.tags], ...noteStart(item)};
    render();
    focusEditor(id);
  } else if (act === 'usefolder') {
    const ed = editing[id];
    ed.folderId = String(ed.note.suggestedFolder.id); ed.creating = false; ed.error = '';
    render();
    focusEditor(id);
  } else if (act === 'useproposed') {
    // Only the name box opens. The folder is created when the user selects "Create folder".
    const ed = editing[id];
    ed.creating = true; ed.newName = ed.note.proposedFolder; ed.error = '';
    render();
    document.querySelector(`[data-act="newfolder-name"][data-id="${id}"]`)?.focus();
  } else if (act === 'rmtag') {
    const ed = editing[id];
    ed.tags = ed.tags.filter(t => t !== btn.dataset.tag);
    ed.error = '';
    render();
    document.querySelector(`[data-act="newtag"][data-id="${id}"]`)?.focus();
  } else if (act === 'newfolder-cancel') {
    const ed = editing[id];
    ed.creating = false; ed.newName = ''; ed.error = '';
    render();
    focusEditor(id);
  } else if (act === 'newfolder-ok') {
    const ed = editing[id];
    ed.busy = true; ed.error = ''; render();
    try {
      const created = await createFolder((ed.newName || '').trim());
      ed.folderId = String(created.id);
      ed.creating = false; ed.newName = ''; ed.busy = false;
      await refreshMeta();
      render();
      focusEditor(id);
    } catch (err) {
      ed.busy = false; ed.error = 'Error: Create folder failed: ' + err.message; render();
      document.querySelector(`[data-act="newfolder-name"][data-id="${id}"]`)?.focus();
    }
  } else if (act === 'discard') {
    // With changes, a confirm step first. Without changes, the editor closes at once.
    if (unchanged(id)) { delete editing[id]; render(); returnFocus(id); }
    else { editing[id].confirmDiscard = true; render(); document.querySelector(`[data-act="discard-yes"][data-id="${id}"]`)?.focus(); }
  } else if (act === 'discard-yes') {
    delete editing[id];
    render();
    returnFocus(id);
  } else if (act === 'discard-no') {
    editing[id].confirmDiscard = false;
    render();
    focusEditor(id);
  } else if (act === 'save' || act === 'archive') {
    const ed = editing[id];
    if (act === 'save' && ed.creating) { ed.error = 'Error: Create the folder first, or choose an existing folder.'; render(); return; }
    // A tag typed but not confirmed with Enter is added now, so Save keeps it.
    // A tag that fails the check stays in the draft, so the user can correct it.
    const typed = (ed.draft ?? '').trim();
    if (typed) {
      const problem = tagProblem(typed, ed.tags);
      if (problem) { ed.busy = false; ed.error = 'Error: ' + problem; render(); return; }
      if (!ed.tags.some(t => t.toLowerCase() === typed.toLowerCase())) ed.tags.push(typed);
      ed.draft = '';
    }
    ed.busy = true; ed.error = ''; ed.warn = ''; render();
    // Archive is a save with the folder "Archive". The editor keeps its own folder choice, so a failed
    // Archive does not make a later Save move the bookmark to Archive.
    let folderId = ed.folderId;
    if (act === 'archive') {
      try {
        folderId = (await ensureArchive()).id;
      } catch (err) {
        ed.busy = false; ed.error = `Error: Create folder ${ARCHIVE} failed: ` + err.message; render();
        focusEditor(id);
        return;
      }
    }
    try {
      // The note goes to the server only when the user changed it. Without it, the server keeps the note.
      const body = {id, folderId: Number(folderId), tags: ed.tags};
      if (ed.text !== ed.noteBase) body.note = ed.text;
      const d = await postJson('/api/save', body);
      delete editing[id];
      applySaved(id, d);
      const done = act === 'archive' ? `Moved to ${ARCHIVE}.` : 'Saved.';
      $('status').textContent = d.tags_match ? done : done + ' Raindrop stored different tags than you chose. Review the tags on this bookmark.';
      refreshMeta().then(refreshFilteredCounts).catch(reportError);
      render();
      returnFocus(id);
    } catch (err) {
      ed.busy = false; ed.error = 'Error: Save failed: ' + err.message; render();
      focusEditor(id);
    }
  }
});

$('list').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act === 'ptag') {
    // The box of a profile tag adds the tag to the editor or removes it. The tag rules of the editor apply.
    const ed = editing[Number(el.dataset.id)], tag = el.value;
    const problem = el.checked ? tagProblem(tag, ed.tags) : '';
    ed.error = problem ? 'Error: ' + problem : '';
    if (el.checked && !problem && !ed.tags.some(t => t.toLowerCase() === tag.toLowerCase())) ed.tags.push(tag);
    if (!el.checked) ed.tags = ed.tags.filter(t => t.toLowerCase() !== tag.toLowerCase());
    render();
    document.getElementById(el.id)?.focus();
    return;
  }
  if (el.dataset.act === 'folder') {
    const id = el.dataset.id;
    const ed = editing[Number(id)];
    if (el.value === '__new__') { ed.creating = true; ed.newName = ''; } else { ed.creating = false; ed.folderId = el.value; }
    render();
    if (ed.creating) document.querySelector(`[data-act="newfolder-name"][data-id="${id}"]`)?.focus();
    else focusEditor(id);
  }
});

$('list').addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.act === 'newfolder-name') editing[Number(el.dataset.id)].newName = el.value;
  // The tag draft is kept in the editor state, so a redraw does not lose it.
  if (el.dataset.act === 'newtag') editing[Number(el.dataset.id)].draft = el.value;
  if (el.dataset.act === 'notetext') editing[Number(el.dataset.id)].text = el.value;
});

$('list').addEventListener('keydown', e => {
  const el = e.target;
  // Escape closes an editor that has no changes. Inside the new folder row, it closes that row only.
  if (e.key === 'Escape' && el.dataset.id && editing[Number(el.dataset.id)]) {
    const id = Number(el.dataset.id);
    // A save or a folder creation is running. Its result must reach this editor, so Escape waits.
    if (editing[id].busy) return;
    if (el.dataset.act === 'newfolder-name') {
      editing[id].creating = false; editing[id].newName = '';
      render();
      focusEditor(id);
    } else if (unchanged(id)) {
      delete editing[id];
      render();
      returnFocus(id);
    }
    return;
  }
  if (e.key === 'Enter' && el.dataset.act === 'newfolder-name') {
    e.preventDefault();
    document.querySelector(`[data-act="newfolder-ok"][data-id="${el.dataset.id}"]`).click();
  }
  if (e.key === 'Enter' && el.dataset.act === 'newtag') {
    e.preventDefault();
    const ed = editing[Number(el.dataset.id)];
    const tag = el.value.trim();
    const problem = tag ? tagProblem(tag, ed.tags) : '';
    if (problem) { ed.error = 'Error: ' + problem; ed.draft = tag; }
    else {
      if (tag && !ed.tags.some(t => t.toLowerCase() === tag.toLowerCase())) ed.tags.push(tag);
      ed.error = ''; ed.draft = '';
    }
    render();
    const again = document.querySelector(`[data-act="newtag"][data-id="${el.dataset.id}"]`);
    if (again) again.focus();
  }
});
