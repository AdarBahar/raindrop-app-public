// The page script, part 8 of 9: The "My context" view: the profile of the user.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- "My context" (docs/ui-elements.md, section 11; docs/profile-plan.md) ----
// The user keeps projects, interests and one text about the user. The server holds the rules and the limits.
// Nothing here writes to Raindrop. The view also works when Raindrop is not connected.
let profile = null;      // the answer of /api/profile: {entries, budget, limits}
let pfEditId = null;     // the entry in the form: null (form closed), '' (a new entry) or the ID of an entry
let pfDirty = false;     // the form has a change that is not saved
let pfAsk = null;        // the ID of the entry whose "Delete" asks for a confirmation
let pfAboutDirty = false; // the text about the user has a change that is not saved
let pfAskErr = '';       // the error of a failed delete. It shows in the row of that entry.
let pfOpener = null;     // the button that opened the view. It gets the focus back.

const PF_KIND = {project: 'Project', interest: 'Interest'};
// The three states of an entry, by name (docs/profile-plan.md, section 5).
function pfStateOf(active, tag) { return !active ? 'Inactive' : tag ? 'Context and tag' : 'Context only'; }
const pfNumber = n => Number(n).toLocaleString('en');

// The default tag for a project: "proj:" and the name in lower case, with "-" for spaces. The user can change it.
function pfDefaultTag(name) {
  const slug = name.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '-');
  return slug ? ('proj:' + slug).slice(0, profile?.limits.tag ?? 50) : '';
}

function pfCounter(input, out, max) {
  const n = input.value.trim().length;
  out.textContent = `${n}/${max}`;
  out.classList.toggle('over', n > max);
}

function renderProfile() {
  const {entries, budget, limits} = profile;
  const about = entries.find(e => e.kind === 'about');
  const rest = entries.filter(e => e.kind !== 'about');
  $('pfBudgetText').textContent = `The active entries use ${pfNumber(budget.used)} of ${pfNumber(budget.max)} characters. This total is the limit for active entries.`;
  $('pfBudgetBar').style.width = `${Math.min(100, Math.round(100 * budget.used / budget.max))}%`;
  // The text about the user. A text with a change that is not saved is never replaced: the list renders
  // again after each save and delete of an entry, and those must not remove what the user typed.
  if (!pfAboutDirty) $('pfAbout').value = about?.description ?? '';
  $('pfAbout').maxLength = limits.about;
  pfCounter($('pfAbout'), $('pfAboutCount'), limits.about);
  $('pfSummary').textContent = rest.length
    ? `${rest.length} ${rest.length === 1 ? 'entry' : 'entries'}. The profile can have at most ${limits.entries} entries. The text about you is one of them.`
    : 'No entries yet. Add a project or an interest.';
  $('pfList').innerHTML = rest.map(e => {
    const state = pfStateOf(e.active, e.tag);
    const tag = e.tag ? `, tag "${esc(e.tag)}"` : '';
    const ask = pfAsk === e.id
      ? `<div class="confirm"><span>Delete "${esc(e.name)}"? A tag that is already on a bookmark stays in Raindrop.</span>
           <button class="btn sm primary" data-pf="deleteOk" data-id="${e.id}">Delete the entry</button>
           <button class="btn sm" data-pf="deleteNo" data-id="${e.id}">Keep the entry</button>
           <span class="err" role="alert">${esc(pfAskErr)}</span></div>`
      : '';
    return `<li>
      <div><span class="pf-name" dir="auto">${esc(e.name)}</span> <span class="pf-meta">${PF_KIND[e.kind]}. ${state}${tag}.</span></div>
      <div class="line">
        <button class="btn sm" data-pf="edit" data-id="${e.id}" aria-label="Edit ${esc(e.name)}">Edit</button>
        <button class="btn sm" data-pf="delete" data-id="${e.id}" aria-label="Delete ${esc(e.name)}">Delete</button>
      </div>
      <div class="pf-desc" dir="auto">${esc(e.description)}</div>${ask}
    </li>`;
  }).join('');
}

async function loadProfile() {
  profile = await api('/api/profile');
  renderProfile();
}
// Load the profile again after a change that the server saved. It never throws: a failed load is not a
// failed save, and a second save would make a second entry. The message says that the change is saved.
async function reloadProfile() {
  try {
    await loadProfile();
    return true;
  } catch (err) {
    $('pfLoadErr').textContent = 'Error: The change is saved, but the view did not load again: ' + err.message + ' Close this view and open it again.';
    $('pfLoadErr').scrollIntoView({block: 'nearest'});
    return false;
  }
}

// ---- The form for one entry ----
function pfShowState() {
  const tag = $('pfTag').value.trim();
  $('pfState').textContent = pfStateOf($('pfActive').checked, tag);
  // The default tag is offered for a project with a name and no tag.
  const offer = $('pfKind').value === 'project' && !tag ? pfDefaultTag($('pfName').value) : '';
  $('pfTagDefaultRow').hidden = !offer;
  $('pfTagDefault').textContent = offer ? `Use the tag "${offer}"` : '';
  $('pfTagDefault').dataset.tag = offer;
  pfCounter($('pfDesc'), $('pfDescCount'), profile.limits.description);
}

function openPfForm(id) {
  const e = id ? profile.entries.find(x => x.id === id) : null;
  pfEditId = id; pfDirty = false;
  $('pfFormH').textContent = e ? `Edit "${e.name}"` : 'New entry';
  $('pfKind').value = e?.kind ?? 'project';
  $('pfName').value = e?.name ?? '';
  $('pfName').maxLength = profile.limits.name;
  $('pfDesc').value = e?.description ?? '';
  $('pfDesc').maxLength = profile.limits.description;
  $('pfActive').checked = e?.active ?? true;
  $('pfTag').value = e?.tag ?? '';
  $('pfTag').maxLength = profile.limits.tag;
  $('pfTagNote').hidden = Boolean(me?.connected);
  $('pfErr').textContent = '';
  $('pfReuse').hidden = true;
  for (const f of ['pfName', 'pfDesc', 'pfTag']) $(f).setAttribute('aria-invalid', 'false');
  pfShowState();
  $('pfForm').hidden = false;
  $('pfAdd').hidden = true;
  $('pfAdd').setAttribute('aria-expanded', 'true');
  $('pfName').focus();
}

// Close the form. The focus goes to the "Edit" button of the entry, or to "+ Add an entry".
function closePfForm(focusId = pfEditId) {
  pfEditId = null; pfDirty = false;
  $('pfForm').hidden = true;
  $('pfAdd').hidden = false;
  $('pfAdd').setAttribute('aria-expanded', 'false');
  (document.querySelector(`[data-pf="edit"][data-id="${focusId}"]`) ?? $('pfAdd')).focus();
}

// Save the entry in the form. reuse: the user confirmed a tag that is already a tag in Raindrop.
async function savePfEntry(reuse = false) {
  const body = {
    kind: $('pfKind').value, name: $('pfName').value, description: $('pfDesc').value,
    tag: $('pfTag').value.trim() || null, active: $('pfActive').checked,
  };
  if (pfEditId) body.id = pfEditId;
  if (reuse) body.reuseTag = true;
  // The page checks the two empty boxes, so the focus can go to the box. The server checks everything again.
  $('pfErr').textContent = ''; $('pfReuse').hidden = true;
  for (const f of ['pfName', 'pfDesc', 'pfTag']) $(f).setAttribute('aria-invalid', 'false');
  const empty = !body.name.trim() ? 'pfName' : !body.description.trim() ? 'pfDesc' : '';
  if (empty) {
    $(empty).setAttribute('aria-invalid', 'true');
    $('pfErr').textContent = empty === 'pfName' ? 'Error: The name is empty.' : 'Error: The description is empty.';
    $(empty).focus();
    return;
  }
  $('pfSave').disabled = $('pfReuseOk').disabled = true;
  let saved = null;
  try {
    saved = (await postJson('/api/profile/entry', body)).entry;
  } catch (err) {
    if (err.tagExists) {
      // The tag is a tag in Raindrop already. The user decides: a different tag, or the same tag.
      $('pfReuseText').textContent = err.message;
      $('pfReuse').hidden = false;
      $('pfTag').setAttribute('aria-invalid', 'true');
      $('pfReuseOk').disabled = false;
      $('pfReuseOk').focus();
    } else {
      $('pfErr').textContent = 'Error: Save failed: ' + err.message;
    }
  } finally {
    $('pfSave').disabled = $('pfReuseOk').disabled = false;
  }
  if (!saved) return;
  // The entry is saved. The form closes also when the list does not load again.
  await reloadProfile();
  closePfForm(saved.id);
}

$('pfAdd').onclick = () => openPfForm('');
$('pfSave').onclick = () => savePfEntry();
$('pfReuseOk').onclick = () => savePfEntry(true);
$('pfCancel').onclick = () => closePfForm();
$('pfTagDefault').onclick = () => {
  $('pfTag').value = $('pfTagDefault').dataset.tag;
  pfDirty = true;
  pfShowState();
  $('pfTag').focus();
};
$('pfForm').addEventListener('input', () => { pfDirty = true; $('pfReuse').hidden = true; pfShowState(); });

// ---- The list: edit and delete. Delete asks first. ----
$('pfList').addEventListener('click', async e => {
  const b = e.target.closest('[data-pf]');
  if (!b) return;
  const id = b.dataset.id, act = b.dataset.pf;
  if (act === 'edit') return openPfForm(id);
  if (act === 'delete') { pfAsk = id; pfAskErr = ''; renderProfile(); return document.querySelector(`[data-pf="deleteNo"][data-id="${id}"]`).focus(); }
  if (act === 'deleteNo') { pfAsk = null; pfAskErr = ''; renderProfile(); return document.querySelector(`[data-pf="delete"][data-id="${id}"]`).focus(); }
  if (act === 'deleteOk') {
    b.disabled = true;
    try {
      await postJson('/api/profile/entry/delete', {id});
    } catch (err) {
      // The error shows in the row, next to the question. The top of the view can be out of sight.
      pfAskErr = 'Error: Delete failed: ' + err.message;
      renderProfile();
      document.querySelector(`[data-pf="deleteNo"][data-id="${id}"]`)?.focus();
      return;
    }
    pfAsk = null;
    if (pfEditId === id) closePfForm('');
    if (await reloadProfile()) $('pfSummary').textContent = 'Entry deleted. ' + $('pfSummary').textContent;
    $('pfAdd').hidden ? $('pfName').focus() : $('pfAdd').focus();
  }
});

// ---- The text about the user. An empty text deletes it. ----
$('pfAbout').addEventListener('input', () => { pfAboutDirty = true; $('pfAboutMsg').textContent = ''; if (profile) pfCounter($('pfAbout'), $('pfAboutCount'), profile.limits.about); });
$('pfAboutSave').onclick = async () => {
  const about = profile.entries.find(e => e.kind === 'about');
  const text = $('pfAbout').value.trim();
  $('pfAboutErr').textContent = ''; $('pfAboutMsg').textContent = '';
  if (!text && !about) return;
  $('pfAboutSave').disabled = true;
  let ok = false;
  try {
    if (text) await postJson('/api/profile/entry', {kind: 'about', description: text, ...(about ? {id: about.id} : {})});
    else await postJson('/api/profile/entry/delete', {id: about.id});
    ok = true;
  } catch (err) {
    $('pfAboutErr').textContent = 'Error: Save failed: ' + err.message;
  } finally {
    $('pfAboutSave').disabled = false;
  }
  if (!ok) return;
  pfAboutDirty = false;
  $('pfAbout').value = text;
  $('pfAboutMsg').textContent = text ? 'Text saved.' : 'Text deleted.';
  await reloadProfile();
};

// ---- Open and close ----
async function openProfile(opener) {
  pfOpener = opener;
  pfAsk = null; pfAskErr = '';
  // The text about the user starts from the stored text each time the view opens.
  pfAboutDirty = false;
  $('pfLoadErr').textContent = ''; $('pfAboutErr').textContent = ''; $('pfAboutMsg').textContent = '';
  // An entry form with a change that is not saved stays as it is. Some browsers close a dialog on a second
  // Escape and the page cannot stop that, so the text must still be there when the view opens again.
  if (!(pfEditId !== null && pfDirty)) {
    pfEditId = null; pfDirty = false;
    $('pfForm').hidden = true;
    $('pfAdd').hidden = false;
    $('pfAdd').setAttribute('aria-expanded', 'false');
  }
  // Nothing can be saved before the profile and its limits are loaded.
  $('pfAdd').disabled = $('pfAboutSave').disabled = true;
  $('profileDlg').showModal();
  $('profileH').focus();
  try {
    await loadProfile();
    $('pfAdd').disabled = $('pfAboutSave').disabled = false;
  } catch (err) {
    $('pfLoadErr').textContent = 'Error: Load failed: ' + err.message + ' Close this view and open it again.';
  }
}
$('profileBtn').onclick = () => openProfile($('profileBtn'));
$('profileGateBtn').onclick = () => openProfile($('profileGateBtn'));
// An entry with a change that is not saved keeps the view open, and the view says why.
function pfBlocked() {
  if (pfEditId === null || !pfDirty) return false;
  $('pfErr').textContent = 'The entry has changes. Select "Save the entry" or "Cancel".';
  $('pfSave').focus();
  return true;
}
$('profileClose').onclick = () => { if (!pfBlocked()) $('profileDlg').close(); };
// Escape closes the form first, then the view.
$('profileDlg').addEventListener('cancel', e => {
  if (pfEditId === null) return;
  e.preventDefault();
  if (!pfBlocked()) closePfForm();
});
$('profileDlg').addEventListener('close', () => pfOpener?.focus());
