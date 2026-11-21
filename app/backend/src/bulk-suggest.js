// The suggest job: ask the model for a folder and tags for each bookmark. Nothing is saved. See src/bulk.js.
import { config } from './config.js';
import { folderOptions, loadAll, promptItem, tagVocab } from './bookmarks.js';
import { fail, finishJob } from './bulk-jobs.js';
import { stateOf } from './bulk-state.js';
import { checkTags } from './limits.js';
import { contextFor } from './profile.js';
import { cleanTags, titleOf } from './util.js';

// Ask the model for a folder and tags, a few bookmarks at a time. Nothing is saved.
// The model calls are paced by llm.js, so a long batch takes several minutes.
export async function runSuggest(svc, userId, job, ids, ask) {
  const c = await loadAll(svc, userId);
  // The profile of the user, read one time. A later edit of the profile does not change this job or its review.
  const profile = await contextFor(svc, userId);
  // The state each bookmark had when the suggestions were made. Apply compares Raindrop with this, not
  // with the cache, which can refresh while the review is open and then contain the external change too.
  const wanted = new Set(ids);
  job.reviewed = new Map(c.items.filter((item) => wanted.has(item._id)).map((item) => [item._id, stateOf(item.collection, item.tags)]));
  const options = folderOptions(c);
  const folders = options.map((o) => o.label);
  if (new Set(folders).size !== folders.length) throw new Error('folder labels are not unique');
  const vocab = tagVocab(c);
  const byId = new Map(c.items.map((item) => [item._id, item]));
  for (let i = 0; i < ids.length; i += config.suggestBatch) {
    if (job.cancelled) break;
    const items = [];
    for (const id of ids.slice(i, i + config.suggestBatch)) {
      const item = byId.get(id);
      if (item) items.push(item);
      else fail(job, { _id: id, title: '' }, 'Bookmark not found.');
    }
    if (items.length === 0) continue;
    const batch = items.map((item) => promptItem(item, c));
    try {
      const found = await ask(batch, folders, vocab, { who: userId, profile });
      for (const item of items) addSuggestion(job, item, found.get(item._id), c, options);
    } catch (err) {
      for (const item of items) fail(job, item, err.message);
    }
  }
  finishJob(job);
}

// Keep one review row. Every bookmark gets a row. A row without an answer needs review, and changes nothing.
// A proposed folder is kept as a proposal. Nothing is approved here.
function addSuggestion(job, item, entry, c, options) {
  const row = {
    id: item._id,
    title: titleOf(item),
    current_folder: c.collections.get(item.collection?.$id) ?? 'Unsorted',
    current_folder_id: item.collection?.$id ?? -1,
    current_tags: [...(item.tags ?? [])],
  };
  if (!entry) {
    job.suggestions.push({ ...row, status: 'needs_review', reason: 'The model gave no answer for this bookmark.', folder: { action: 'none', name: null, folderId: null }, tags: row.current_tags, new_tags: [], profile_tags: [] });
  } else {
    // An existing folder keeps its ID. A proposed folder has no ID until apply creates it.
    const option = entry.folder.action === 'existing' ? options.find((o) => o.label === entry.folder.name) : null;
    // The current tags stay on the bookmark. The suggested tags are added while the bookmark stays in the
    // tag limit, the known tags first. The review selects the new tags, so apply must accept all of them.
    const has = (list, t) => list.some((x) => x.toLowerCase() === t.toLowerCase());
    const addedAll = entry.existingTags.filter((t) => !has(row.current_tags, t));
    const newAll = entry.newTags.filter((t) => !has(row.current_tags, t));
    let room = Math.max(0, config.limits.tagsPerBookmark - row.current_tags.length);
    const added = addedAll.slice(0, room);
    room -= added.length;
    const newTags = newAll.slice(0, room);
    room -= newTags.length;
    // A profile tag that the bookmark already has is not proposed. One that does not fit in the limit is dropped.
    const profileTags = (entry.profileTags ?? []).filter((p) => !has(row.current_tags, p.tag)).slice(0, room);
    // "none" always needs review, even when the reply says ready.
    let status = entry.folder.action === 'none' ? 'needs_review' : entry.status;
    let reason = entry.reason;
    const left = addedAll.length + newAll.length - added.length - newTags.length;
    if (left) {
      reason += ` ${left} suggested ${left === 1 ? 'tag was' : 'tags were'} left out: a bookmark can have at most ${config.limits.tagsPerBookmark} tags.`;
    }
    // The current tags can already break a limit (too many tags, or a tag that is too long). Apply would
    // refuse the card, so the card needs review and does not go in "Apply all".
    try {
      checkTags(cleanTags([...row.current_tags, ...added, ...newTags, ...profileTags.map((p) => p.tag)]));
    } catch (err) {
      status = 'needs_review';
      reason = `${err.message} Edit the tags, then apply. ${reason}`;
    }
    job.suggestions.push({
      ...row,
      status,
      reason,
      folder: { action: entry.folder.action, name: entry.folder.name, folderId: option ? option.id : null },
      // tags: the current tags and the known tags. new_tags: the new tags, selected in the review at first.
      tags: [...row.current_tags, ...added],
      new_tags: newTags,
      // profile_tags: tags of profile entries, each with the entry that it comes from. Not selected in the review at first.
      profile_tags: profileTags,
    });
  }
  job.done += 1;
}
