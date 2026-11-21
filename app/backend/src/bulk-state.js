// The folder and tags of a bookmark before and after a bulk change. See src/bulk.js.
import { sameTagSet } from './util.js';

// The folder and tags of a bookmark, in the form the undo log and sameState use.
export function stateOf(collection, tags) {
  return { collection_id: collection?.$id ?? -1, tags: [...(tags ?? [])] };
}

export function snapshot(item) {
  return { collection_id: item.collection?.$id ?? null, tags: [...(item.tags ?? [])] };
}

export function apply(item, next) {
  if (next.collectionId !== undefined) item.collection = { $id: next.collectionId };
  if (next.tags !== undefined) item.tags = next.tags;
  if (next.type !== undefined) item.type = next.type;
}

// True when two snapshots have the same folder and the same tags.
export function sameState(a, b) {
  return a.collection_id === b.collection_id && sameTagSet(a.tags, b.tags);
}
