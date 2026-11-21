// The effects that the stored copy applies. See src/sync.js and docs/bookmark-store-plan.md.
import { cleanTags } from './util.js';

// An effect is a change that Raindrop accepted. The journal and the write-through use the same
// effects and the same code, so a replay and a later write give the same result.
//   { type: 'upsert', item }                        a created or changed bookmark, as Raindrop returned it
//   { type: 'delete', ids }                         deleted bookmarks
//   { type: 'update', ids, collectionId?, tags? }   a single update: the folder and the tags are set (tags replace)
//   { type: 'move', ids, collectionId }             a bulk move to a folder
//   { type: 'addTags', ids, tags }                  a bulk add of tags (Raindrop appends them)
//   { type: 'upsertCollection', collection }        a created or changed folder

export function moveRaw(raw, collectionId) {
  if (raw.collection?.$id === collectionId) return null;
  const next = { ...raw, collection: { ...raw.collection, $id: collectionId } };
  if ('collectionId' in raw) next.collectionId = collectionId;
  return next;
}

// A single update of Raindrop sets the folder and replaces the tags. A field that is not given stays.
export function updateRaw(raw, { collectionId, tags }) {
  let next = collectionId === undefined ? raw : moveRaw(raw, collectionId) ?? raw;
  if (tags !== undefined && JSON.stringify(next.tags ?? []) !== JSON.stringify(tags)) next = { ...next, tags: [...tags] };
  return next === raw ? null : next;
}

// Same rule as the bulk action: merge, keep the first spelling, and report no change when nothing is new.
export function addTagsRaw(raw, tags) {
  const current = raw.tags ?? [];
  const merged = cleanTags([...current, ...tags]);
  return merged.length === current.length ? null : { ...raw, tags: merged };
}

// Write one effect with the store functions of the caller: the store, or the ops of a transaction.
// The caller owns the queue turn.
export async function applyEffect(ops, userId, effect) {
  switch (effect.type) {
    case 'upsert':
      return ops.upsertBookmark(userId, effect.item);
    case 'delete':
      return ops.deleteBookmarks(userId, effect.ids);
    case 'update':
      return ops.updateBookmarks(userId, effect.ids, (raw) => updateRaw(raw, effect));
    case 'move':
      return ops.updateBookmarks(userId, effect.ids, (raw) => moveRaw(raw, effect.collectionId));
    case 'addTags':
      return ops.updateBookmarks(userId, effect.ids, (raw) => addTagsRaw(raw, effect.tags));
    case 'upsertCollection':
      return ops.upsertCollections(userId, [effect.collection]);
    default:
      throw new Error(`Unknown effect type: ${effect.type}`);
  }
}
