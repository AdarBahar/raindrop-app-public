// The page script, part 2 of 9: The filters, the date presets, and the folders and tags in the sidebar.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- Filters ----
function activeFilterCount() {
  return ($('q').value.trim() ? 1 : 0) + (folder !== '' ? 1 : 0) + ($('tags').value.trim() ? 1 : 0) +
         ($('statusFilter').value ? 1 : 0) + ($('visited').value ? 1 : 0) + (preset !== basePreset() ? 1 : 0);
}
// The date filter that counts as "no date filter". A text search shows all dates, so with search text it is
// "All time". Without search text, it is the default preset.
function basePreset() { return $('q').value.trim() ? 'all' : defaultPreset; }
// A text search starts at "All time", so an old bookmark is not hidden. The user can then click a preset to see
// fewer dates. When the search text goes away, the date filter from before the search returns, unless the user
// clicked a preset during the search. A choice from before the search returns as a choice.
// The return value is true when the date filter changed. Then the caller starts a new list at once: the
// selection must not stay for the 250 ms of the search delay, because a bulk action would use the new dates.
let searchOn = false, beforeSearch = null;
function syncSearchPreset() {
  const on = Boolean($('q').value.trim());
  if (on === searchOn) return false;
  searchOn = on;
  const was = preset;
  if (on) {
    beforeSearch = {preset, chosen: presetChosen};
    presetChosen = false;
    showPreset('all');
  } else if (!presetChosen) {
    presetChosen = Boolean(beforeSearch?.chosen);
    showPreset(presetChosen ? beforeSearch.preset : defaultPreset);
  }
  return preset !== was;
}
// True when a filter other than the date is on: search text, folder, tags, status or visited.
function otherFilterOn() {
  return Boolean($('q').value.trim() || folder !== '' || $('tags').value.trim() || $('statusFilter').value || $('visited').value);
}

// Each date tab shows its count. With another filter on, it shows "<with the filters>/<all>", for example "75/790".
function renderPresetCounts() {
  const filtered = otherFilterOn() ? filteredPresets : null;
  document.querySelectorAll('[data-preset]').forEach(b => {
    const key = b.dataset.preset, total = metaPresets[key];
    let n = '';
    if (total !== undefined && filtered && filtered[key] !== undefined) {
      n = ` <span class="n">${filtered[key]}<span aria-hidden="true">/</span><span class="sr-only"> of </span>${total}</span>`;
    } else if (total !== undefined) n = ` <span class="n">${total}</span>`;
    b.innerHTML = esc(b.dataset.label) + n;
  });
}

// With the status "Unsorted or no tags", a switch above the list chooses the kind of gap. Each button shows its
// count with all the other filters on. "No folder" means the folder Unsorted. A bookmark with no folder and no
// tags is in each kind.
function renderNeedsSwitch() {
  const on = $('statusFilter').value === 'needs';
  $('needsSwitch').hidden = !on;
  if (!on) return;
  const key = {'': 'any', both: 'both', folder: 'folder', tags: 'tags'};
  document.querySelectorAll('[data-needs]').forEach(b => {
    const n = needsCounts?.[key[b.dataset.needs]];
    b.innerHTML = esc(b.dataset.label) + (n === undefined ? '' : ` <span class="n">${n}</span>`);
    setOn(b, b.dataset.needs === needsKind);
  });
}
document.querySelectorAll('[data-needs]').forEach(b => b.onclick = () => {
  if (b.dataset.needs === needsKind) return;
  needsKind = b.dataset.needs;
  changed();
});

// Reload only the date counts and the counts of the switch with the current filters, for example after a save. The list does not
// reload, so the view does not move. A newer search wins, because it also sets the counts.
async function refreshFilteredCounts() {
  if (!otherFilterOn()) return;
  const seq = runSeq;
  const p = filterParams();
  p.set('page', '1'); p.set('pageSize', '25');
  const d = await api('/api/bookmarks?' + p);
  if (seq !== runSeq) return;
  filteredPresets = d.presets ?? null;
  renderPresetCounts();
  // The counts of the switch of "Unsorted or no tags" change after a save too, for example after a new tag.
  needsCounts = d.needsCounts ?? null;
  renderNeedsSwitch();
}

// The filters other than the date, in words, for the count line. For example: in folder Business, with tag #docs.
function filterSummary() {
  const parts = [];
  if (folder !== '') parts.push(`in folder ${metaFolders.find(f => String(f.id) === String(folder))?.label ?? folder}`);
  const tags = filterTags();
  if (tags.length) parts.push(`with ${tags.length > 1 ? 'tags' : 'tag'} ${tags.map(t => '#' + t).join(', ')}`);
  const q = $('q').value.trim();
  if (q) parts.push(`matching "${q}"`);
  const needsText = {both: 'unsorted and with no tags', folder: 'unsorted', tags: 'with no tags'}[needsKind] ?? 'unsorted or with no tags';
  const statusText = {new: 'new only', needs: needsText, dupes: 'in duplicate groups'};
  if ($('statusFilter').value) parts.push(statusText[$('statusFilter').value] ?? '');
  if ($('visited').value) parts.push($('visited').value === 'yes' ? 'visited' : 'not visited');
  return parts.join(', ');
}

function filterTags() { return splitTags($('tags').value); }

function dateError() {
  return preset === 'custom' && $('from').value && $('to').value && $('from').value > $('to').value
    ? 'Error: The start date must be on or before the end date.' : '';
}

// A filter change: back to page 1, selection cleared, then a new list.
function changed() {
  page = 1;
  clearSelection();
  // The old list stays on the page until the new one comes. Its selection controls and an open bulk step go away now.
  renderSelection();
  renderFilterState();
  run();
}

function renderFilterState() {
  const n = activeFilterCount();
  $('clearFilters').hidden = n === 0;
  $('filtersBtn').textContent = `Filters (${n})`;
  $('dates').hidden = preset !== 'custom';
  renderNeedsSwitch();
  document.querySelectorAll('[data-tag]').forEach(b => {
    const on = filterTags().some(t => t.toLowerCase() === b.dataset.tag.toLowerCase());
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setFolder(id) {
  folder = id;
  document.querySelectorAll('[data-folder]').forEach(b => setOn(b, b.dataset.folder === folder));
  changed();
}
// The active preset and its button, without a new list.
function showPreset(p) {
  preset = p;
  document.querySelectorAll('[data-preset]').forEach(b => setOn(b, b.dataset.preset === p));
}
function setPreset(p) {
  presetChosen = true;
  showPreset(p);
  changed();
  if (p === 'custom') $('from').focus();
}
function toggleTag(tag) {
  const tags = filterTags();
  const i = tags.findIndex(t => t.toLowerCase() === tag.toLowerCase());
  if (i >= 0) tags.splice(i, 1); else tags.push(tag);
  $('tags').value = tags.slice(0, 10).join(', ');
  changed();
}

document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => setPreset(b.dataset.preset));
document.addEventListener('click', e => {
  const f = e.target.closest('[data-folder]');
  if (f) { setFolder(f.dataset.folder); if (document.body.classList.contains('filters-open')) closeSheet(); return; }
  // A tag chip or a sidebar tag filters the list. The remove button in the editor also carries a tag; it is not a filter.
  const t = e.target.closest('[data-tag]');
  if (t && !t.dataset.act) toggleTag(t.dataset.tag);
});
['q', 'tags', 'from', 'to'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(changed, 250); }));
// This listener is after the one above, so it can stop the delay of that one.
$('q').addEventListener('input', () => { if (syncSearchPreset()) { clearTimeout(timer); changed(); } });
$('q').addEventListener('input', () => { const n = $('q').value.length; $('qCount').textContent = n > 150 ? `${n}/200` : ''; });
['sort', 'visited'].forEach(id => $(id).onchange = changed);
// A duplicate can be years older than its copy, so the duplicate view shows all dates.
$('statusFilter').onchange = () => {
  // A new status starts the switch of "Unsorted or no tags" at "Any of these".
  needsKind = '';
  if ($('statusFilter').value === 'dupes') { presetChosen = true; showPreset('all'); }
  changed();
};
$('clearFilters').onclick = () => {
  ['q', 'tags', 'from', 'to', 'statusFilter', 'visited'].forEach(id => $(id).value = '');
  $('qCount').textContent = '';
  presetChosen = false; showPreset(defaultPreset); folder = ''; needsKind = '';
  searchOn = false; beforeSearch = null;
  document.querySelectorAll('[data-folder]').forEach(b => setOn(b, b.dataset.folder === ''));
  changed();
  $('q').focus();
};

// ---- Folders and tags (sidebar) ----
// The counts set the default preset. With followDefault, a view the user did not choose moves to
// the new default, back on page 1 and with no selection. The caller then reloads the list.
// Without it (a save, a new folder), the view stays, so an open editor or a bulk step is not disturbed.
async function refreshMeta({followDefault = false} = {}) {
  const m = await api('/api/meta?tz=' + encodeURIComponent(TZ));
  metaFolders = m.collections.map(c => ({id: c.id, label: c.label, count: c.count}));
  metaTags = m.tags;
  metaPresets = m.presets;
  renderPresetCounts();
  defaultPreset = defaultPresetOf(m.presets);
  if (followDefault && !presetChosen && preset !== basePreset()) {
    showPreset(basePreset());
    page = 1;
    clearSelection();
  }
  renderFolders();
  renderTags();
  $('taglist').innerHTML = m.tags.map(t => `<option value="${esc(t.name)}">${t.count}</option>`).join('');
}

function renderFolders() {
  const all = {id: '', label: 'All folders', count: pageInfo.total || metaFolders.reduce((s, f) => s + f.count, 0)};
  const items = [all, ...metaFolders];
  $('folders').innerHTML = items.map(f =>
    `<li><button class="nav-item${f.id === '' ? '' : ' fold'}"${f.id === '' ? '' : ` style="--h:${hue(f.id)}"`} data-folder="${esc(f.id)}" aria-pressed="false"><span class="ic" aria-hidden="true">${f.id === '' ? '▤' : '▭'}</span><span class="name">${esc(f.label)}</span><span class="n">${f.count}</span></button></li>`).join('');
  $('folderRow').innerHTML = '<span class="lbl">Folder</span>' + items.map(f =>
    `<button class="chip" data-folder="${esc(f.id)}" aria-pressed="false">${esc(f.label)} (${f.count})</button>`).join('');
  document.querySelectorAll('[data-folder]').forEach(b => setOn(b, b.dataset.folder === folder));
}

function renderTags() {
  const shown = allTags ? metaTags : metaTags.slice(0, 12);
  $('tagList').innerHTML = shown.map(t =>
    `<li><button class="nav-item" data-tag="${esc(t.name)}" aria-pressed="false"><span class="ic" aria-hidden="true">#</span><span class="name">${esc(t.name)}</span><span class="n">${t.count}</span></button></li>`).join('');
  const more = $('moreTags');
  more.hidden = metaTags.length <= 12;
  more.textContent = allTags ? 'Show fewer' : `Show all (${metaTags.length})`;
  more.setAttribute('aria-expanded', String(allTags));
  renderFilterState();
}
$('moreTags').onclick = () => { allTags = !allTags; renderTags(); };

async function createFolder(name) {
  return postJson('/api/folder', {name}); // {id, name}
}

function closeNewFolderBox() {
  $('newFolderBox').hidden = true; $('newFolderName').value = ''; $('newFolderErr').textContent = '';
  $('newFolderName').setAttribute('aria-invalid', 'false');
  $('newFolderBtn').setAttribute('aria-expanded', 'false');
}
$('newFolderBtn').onclick = () => { $('newFolderBox').hidden = false; $('newFolderBtn').setAttribute('aria-expanded', 'true'); $('newFolderName').focus(); };
$('newFolderCancel').onclick = () => { closeNewFolderBox(); $('newFolderBtn').focus(); };
$('newFolderOk').onclick = async () => {
  $('newFolderOk').disabled = true; $('newFolderErr').textContent = '';
  $('newFolderName').setAttribute('aria-invalid', 'false');
  try {
    const created = await createFolder($('newFolderName').value.trim());
    closeNewFolderBox();
    $('status').textContent = `Folder "${created.name}" created.`;
    await refreshMeta();
    $('newFolderBtn').focus();
  } catch (err) {
    $('newFolderErr').textContent = 'Error: ' + err.message;
    $('newFolderName').setAttribute('aria-invalid', 'true');
  } finally {
    $('newFolderOk').disabled = false;
  }
};
$('newFolderName').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('newFolderOk').click();
  if (e.key === 'Escape') { closeNewFolderBox(); $('newFolderBtn').focus(); }
});
