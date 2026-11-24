// Pure rules of the browser. The tests run this file without a page.
// The checks match the server limits (config.js). The server still checks every save.
// The review rules (reviewStart and the functions after it) decide what a suggestion card shows and sends.

// The maximum length of a note. The server has the same limit (config.js, noteLength).
const NOTE_MAX = 10000;

// The problem with adding one tag to a bookmark that has these tags. Empty text means the tag can be added.
// A tag that is already in the list is not a problem. It is simply not added twice.
function tagProblem(tag, tags) {
  if (tags.some(t => t.toLowerCase() === tag.toLowerCase())) return '';
  if (tag.length > 50) return 'A tag can have at most 50 characters.';
  if (tag.includes(',')) return 'Tags cannot contain commas.';
  if (tags.length >= 20) return 'A bookmark can have at most 20 tags.';
  return '';
}

// ---- The review of a batch suggestion (docs/ui-elements.md, section 5.6) ----
// A bookmark that is in a folder keeps its folder unless the user selects a different one on its card.
// A bookmark in Unsorted (folder ID -1) starts with the folder of the model, as before.

// True when the bookmark of a suggestion row is in a folder.
function reviewSorted(s) { return s.current_folder_id !== -1; }

// The folder that a card starts with, and the folder that the model suggests in its place.
// folder: a folder ID as text, 'new' for the proposed folder, or '' for no folder.
// suggested: null, or {value, name, isNew}. value is a folder ID as text, or 'new'.
function reviewStart(s) {
  const f = s.folder;
  if (!reviewSorted(s)) return {folder: f.action === 'existing' ? String(f.folderId) : '', suggested: null};
  let suggested = null;
  if (f.action === 'existing' && f.folderId !== s.current_folder_id) suggested = {value: String(f.folderId), name: f.name, isNew: false};
  else if (f.action === 'propose') suggested = {value: 'new', name: f.name, isNew: true};
  return {folder: String(s.current_folder_id), suggested};
}

// True when the two tag lists have the same tags. Letter case and order are ignored.
function sameTags(a, b) {
  const low = list => [...new Set(list.map(t => t.toLowerCase()))].sort();
  const x = low(a), y = low(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

// True when the only suggestion of a card is a different folder, and the user did not decide yet.
// card: {s, folder, suggested, edited}. tags: the tags that Apply would save for the card.
// Such a card changes nothing as it is, so it waits for the user and is not in "Apply all".
function reviewWaits(card, tags) {
  return Boolean(card.suggested) && !card.edited && card.folder === String(card.s.current_folder_id)
    && sameTags(tags, card.s.current_tags);
}

// True when "Apply all" takes the card: it has a folder, it is ready or the user changed it, and it does not wait.
function reviewInApplyAll(card, tags) {
  return Boolean(card.folder) && (card.s.status === 'ready' || card.edited) && !reviewWaits(card, tags);
}

// What Apply sends for a card: {id, folderId, tags}, or {id, newFolder, tags} for a proposed folder.
// A proposed folder is sent only when the card has it selected ('new'), or when the card has no folder and
// the user pressed "Create folder and apply" (create). A card of a sorted bookmark starts with its current folder.
// It has no folder only after the user selects "Choose a folder" in Edit.
function reviewChange(card, tags, create) {
  const folder = card.folder || (create && card.s.folder.action === 'propose' ? 'new' : '');
  return folder === 'new' ? {id: card.s.id, newFolder: card.s.folder.name, tags} : {id: card.s.id, folderId: Number(folder), tags};
}

// ---- The suggestion for one bookmark, in the editor (docs/ui-elements.md, section 5.4) ----

// What the editor shows for the answer of /api/suggest. d: the answer. folderId: the folder that the editor has now.
// Returns {reason, warn, folder, proposed, left, profile}:
//  - reason: the reason of the model. warn: true when the model is not sure.
//  - folder: {id, label, selected} for a suggested folder that is not the folder of the bookmark, or null.
//  - proposed: the name of a new folder that the model proposed, or ''.
//  - left: the text for the suggested tags that are over the tag limit, or ''.
//  - profile: the tags from the profile of the user, as {tag, entryName}. The editor does not select them at first.
function suggestionNote(d, folderId) {
  const n = d.tagsLeftOut || 0, f = d.suggestedFolder;
  return {
    reason: d.reason || '',
    warn: d.status !== 'ready',
    folder: f ? {id: String(f.id), label: f.label, selected: String(folderId) === String(f.id)} : null,
    proposed: d.proposedFolder || '',
    profile: (d.profileTags || []).map(p => ({tag: p.tag, entryName: p.entryName})),
    left: n ? `${n} suggested ${n === 1 ? 'tag was' : 'tags were'} left out: a bookmark can have at most 20 tags.` : '',
  };
}
