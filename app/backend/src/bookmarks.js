import { config } from './config.js';
import { classifyV2 } from './llm.js';
import { raindropCall } from './raindrop.js';
import { connectionGeneration, writeThrough } from './sync.js';
import { cleanTags, RequestError, sameTagSet, titleOf } from './util.js';
import { groupHash } from './dupes.js';
import { checkFolderName, checkTags } from './limits.js';
import { findItem, loadAll, userCache } from './library.js';
import { duplicatesOf, folderOptions, labelFor, tagVocab } from './listing.js';
import { contextFor } from './profile.js';

// The bookmarks of each user. The modules:
//  - library.js: the load of the bookmarks and folders, the cache, and the account.
//  - listing.js: search, filters, folder and tag lists, duplicates and meta.
// This file holds the changes: pull, the quick check, suggest, save, go, new folder and keep duplicates.
// Other code imports from this file only.
export { account, forget, loadAll, progress } from './library.js';
export { dateRange, folderOptions, matchAll, meta, search, tagVocab } from './listing.js';

// Keep a duplicate group ("Keep all"): it does not show again while its bookmarks are the same.
// `keep` false shows it again (Undo). The group must exist now. The server stores the IDs that it has now.
export async function keepDuplicates(svc, userId, section, key, keep = true) {
  if (section !== 'definite' && section !== 'possible') throw new RequestError(400, 'The section must be definite or possible.');
  if (typeof key !== 'string' || !key || key.length > 10000) throw new RequestError(400, 'The group key is not valid.');
  const hash = groupHash(section, key);
  if (!keep) {
    await svc.store.unkeepDuplicates(userId, hash);
    return { ok: true };
  }
  const c = await loadAll(svc, userId);
  const { groups } = await duplicatesOf(svc, userId, c);
  const group = groups.find((g) => g.section === section && g.key === key);
  if (!group) throw new RequestError(404, 'This duplicate group was not found. Reload the list.');
  await svc.store.keepDuplicates(userId, hash, group.ids);
  return { ok: true };
}

// Mark bookmarks that were not seen before as New. The first pull only saves a baseline.
export async function pull(svc, userId) {
  const c = await loadAll(svc, userId, true);
  const current = new Set(c.items.map((item) => item._id));
  if (!(await svc.store.hasBaseline(userId))) {
    await svc.store.replaceStatus(userId, current, new Set());
    return { new: 0, labelled: 0, message: 'Baseline saved. Future pulls will label new bookmarks as New.' };
  }
  const known = await svc.store.known(userId);
  const newIds = [...current].filter((id) => !known.has(id));
  const labelled = new Set([...(await svc.store.newItems(userId)), ...newIds].filter((id) => current.has(id)));
  await svc.store.replaceStatus(userId, current, labelled);
  return {
    new: newIds.length,
    labelled: labelled.size,
    message: `${newIds.length} new bookmark(s) found. They are labelled New.`,
  };
}

// The quick check for new bookmarks (docs/ui-elements.md 4.8). One small Raindrop call gives the newest
// bookmarks. The check counts the ones that are not in memory. It changes nothing.
// It finds new bookmarks only. A bookmark that was moved, tagged or deleted in Raindrop needs the full check.
// The answer is kept for 60 seconds for each user, so two open tabs make one call. A check clears it.
export const QUICK_SIZE = 25;

export async function changes(svc, userId, call = raindropCall) {
  const memo = (svc.quick ??= new Map());
  const hit = memo.get(userId);
  if (hit && Date.now() - hit.at < 60000) return hit.result;
  // Without the stored copy, the bookmarks in memory are used as they are. A reload from Raindrop every few
  // minutes would cost many calls, and it would add the new bookmarks to the memory before the comparison.
  // The memory is loaded only when it was never loaded (`at` is 0). An empty library that loaded is kept.
  const cached = userCache(svc, userId);
  const c = config.bookmarkStore || !cached.at ? await loadAll(svc, userId) : cached;
  const ids = new Set(c.items.map((item) => item._id));
  const res = await call(svc, userId, 'GET', `/raindrops/0?perpage=${QUICK_SIZE}&sort=-created`);
  const newest = res.items ?? [];
  const added = newest.filter((item) => !ids.has(item._id)).length;
  // All of the newest bookmarks are new: there can be more.
  const result = { added, more: added === QUICK_SIZE };
  memo.set(userId, { at: Date.now(), result });
  return result;
}

export function forgetChanges(svc, userId) {
  svc.quick?.delete(userId);
}

// One bookmark as the suggestion prompt takes it (llm.js, contract v2).
export function promptItem(item, c) {
  return {
    id: item._id,
    title: item.title ?? '',
    url: item.link ?? '',
    note: item.note ?? '',
    excerpt: item.excerpt ?? '',
    currentFolder: c.collections.get(item.collection?.$id) ?? 'Unsorted',
    currentTags: item.tags ?? [],
  };
}

// Ask the model for a folder and tags for one bookmark. Nothing is saved.
// The answer fills the editor (docs/ui-elements.md, section 5.4):
//  - folderId, folder, label: the folder that the editor selects. A bookmark in Unsorted gets the folder of the
//    model. A bookmark that is in a folder keeps it.
//  - suggestedFolder: the folder of the model for a bookmark that is in a different folder, or null.
//  - proposedFolder: the name of a new folder that the model proposed, or null. Nothing is created here.
//  - tags: the current tags, then the suggested tags, inside the tag limit. tagsLeftOut: suggested tags over the limit.
//  - profileTags: tags of profile entries, as { tag, entryId, entryName }. The editor does not select them at first.
//    A tag that the bookmark has is not proposed. A tag that does not fit in the tag limit is dropped.
export async function suggest(svc, userId, rid, ask = classifyV2) {
  const item = await findItem(svc, userId, rid);
  if (!item) throw new RequestError(404, 'Bookmark not found.');
  const c = await loadAll(svc, userId);
  const options = folderOptions(c);
  const labels = options.map((o) => o.label);
  if (new Set(labels).size !== labels.length) throw new Error('folder labels are not unique');
  const profile = await contextFor(svc, userId);
  const entry = (await ask([promptItem(item, c)], labels, tagVocab(c), { who: userId, profile })).get(rid);
  // The user sees this text. It says what the model did, not how the request failed.
  if (!entry) throw new RequestError(502, 'The model returned no suggestion.');
  return editorSuggestion(item, c, options, entry);
}

// The answer of suggest() for one entry of the model. scripts/suggest-eval.mjs uses it too.
export function editorSuggestion(item, c, options, entry) {
  const currentId = item.collection?.$id ?? -1;
  const sorted = currentId !== -1;
  // Match on the label, which is unique. A name alone can match two folders.
  const option = entry.folder.action === 'existing' ? options.find((o) => o.label === entry.folder.name) : null;
  const useModel = option && !sorted;
  const label = useModel ? option.label : options.find((o) => o.id === currentId)?.label ?? c.collections.get(currentId) ?? 'Unsorted';
  // The current tags stay. The suggested tags are added while the bookmark stays in the tag limit.
  const current = cleanTags(item.tags);
  const added = cleanTags([...current, ...entry.existingTags, ...entry.newTags]).slice(current.length);
  const room = Math.max(0, config.limits.tagsPerBookmark - current.length);
  const has = (tag) => current.some((t) => t.toLowerCase() === tag.toLowerCase());
  const profileTags = (entry.profileTags ?? []).filter((p) => !has(p.tag)).slice(0, Math.max(0, room - added.length));
  return {
    folderId: useModel ? option.id : currentId,
    folder: label,
    label,
    tags: [...current, ...added.slice(0, room)],
    tagsLeftOut: Math.max(0, added.length - room),
    reason: entry.reason,
    status: entry.status,
    suggestedFolder: option && sorted && option.id !== currentId ? { id: option.id, label: option.label } : null,
    proposedFolder: entry.folder.action === 'propose' ? entry.folder.name : null,
    profileTags,
  };
}

// Write the folder and tags to Raindrop and log the change.
export async function save(svc, userId, rid, folderId, tagsIn) {
  // Check the tags before the bookmarks load, so bad input never causes a Raindrop call.
  const tags = cleanTags(tagsIn);
  checkTags(tags);
  const item = await findItem(svc, userId, rid);
  if (!item) throw new RequestError(404, 'Bookmark not found.');
  const c = await loadAll(svc, userId);
  if (!Number.isInteger(folderId) || !c.collections.has(folderId)) throw new RequestError(400, `Unknown folder: ${folderId}`);
  const folder = c.collections.get(folderId);

  const colId = folderId;
  const gen = connectionGeneration(svc, userId); // before the Raindrop call: a disconnect during the call stops the write
  const before = {
    folder: c.collections.get(item.collection?.$id) ?? 'Unsorted',
    tags: item.tags ?? [],
  };
  const res = await raindropCall(svc, userId, 'PUT', `/raindrop/${rid}`, {
    collection: { $id: colId },
    tags,
  });
  const savedTags = res.item?.tags ?? tags;
  const tagsMatch = sameTagSet(savedTags, tags);
  // Raindrop accepted the change. The stored copy gets the object that Raindrop returned. Without it, the same fields.
  await writeThrough(svc, userId, gen, res.item?._id === rid
    ? { type: 'upsert', item: res.item }
    : { type: 'update', ids: [rid], collectionId: colId, tags: savedTags });

  item.collection = { $id: colId };
  item.tags = savedTags;
  await svc.store.removeNew(userId, rid);
  await svc.store.addLog(userId, {
    time: new Date().toISOString(),
    id: rid,
    title: titleOf(item),
    before,
    after: { folder, tags: savedTags },
    tags_match: tagsMatch,
  });
  return { folderId, folder, label: labelFor(c, folderId), tags: savedTags, tags_match: tagsMatch };
}

// Count one visit and return the bookmark link. Null when the bookmark has no web link.
export async function go(svc, userId, ridText) {
  if (!/^\d+$/.test(ridText)) return null;
  const item = await findItem(svc, userId, Number(ridText));
  if (!item) return null;
  const link = item.link ?? '';
  if (!/^https?:\/\//.test(link)) return null;
  await svc.store.recordVisit(userId, item._id, new Date().toISOString());
  return link;
}

// Create a top-level folder in Raindrop for one user.
export async function createFolder(svc, userId, nameIn) {
  const name = String(nameIn ?? '').trim();
  checkFolderName(name);
  const c = await loadAll(svc, userId);
  if ([...c.collections.values()].some((n) => n.toLowerCase() === name.toLowerCase())) {
    throw new RequestError(409, `A folder named ${name} already exists.`);
  }
  const gen = connectionGeneration(svc, userId);
  const res = await raindropCall(svc, userId, 'POST', '/collection', { title: name });
  const created = res.item ?? {};
  if (created._id === undefined) throw new RequestError(502, 'Raindrop did not return the new folder.');
  await writeThrough(svc, userId, gen, { type: 'upsertCollection', collection: created });
  const title = created.title ?? name;
  c.collections.set(created._id, title);
  return { id: String(created._id), name: title };
}
