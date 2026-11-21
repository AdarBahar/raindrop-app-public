// The checks of the bulk request body. They run before the bookmarks load, so bad input never causes a
// Raindrop call. The folder checks need the loaded folders, so they run after the load. See src/bulk.js.
import { matchAll } from './bookmarks.js';
import { checkFolderName, checkTagFormat, checkTags, tagList } from './limits.js';
import { parseFilter } from './listing.js';
import { cleanTags, RequestError } from './util.js';

const FILTER_KEYS = ['q', 'tags', 'collection', 'sort', 'visited', 'status', 'needs', 'preset', 'from', 'to', 'tz'];

// The tags that add or remove sets. Only the text is checked here. The count is checked
// for each bookmark, against the tags it ends up with (see nextState).
export function tagTargetOf(body) {
  const tags = cleanTags(tagList(body.tags));
  if (tags.length === 0) throw new RequestError(400, 'Enter at least one tag.');
  checkTagFormat(tags);
  return { tags };
}

// The bookmarks of the job, as a list of ids or as a filter. Checks the input. Does not load anything.
export function selectorOf(body) {
  if (Array.isArray(body.ids)) {
    const ids = [...new Set(body.ids.map(Number))];
    if (ids.some((id) => !Number.isInteger(id))) throw new RequestError(400, 'Bookmark ids must be whole numbers.');
    return { ids };
  }
  if (body.filter && typeof body.filter === 'object') {
    const params = {};
    for (const key of FILTER_KEYS) {
      if (body.filter[key] !== undefined) params[key] = String(body.filter[key]);
    }
    // Checks the search text, the tag filter, the zone and the dates. Nothing loads here.
    parseFilter(params);
    return { filter: params };
  }
  throw new RequestError(400, 'Choose bookmarks by ids or by filter.');
}

// The ids of the bookmarks. A filter is resolved from the loaded bookmarks.
export async function resolveIds(svc, userId, selector) {
  if (selector.ids) return selector.ids;
  const { results } = await matchAll(svc, userId, selector.filter);
  return results.map((r) => r.id);
}

// The folder that a move sets. Refuses an unknown folder before any change.
export function folderTargetOf(body, c) {
  const folderId = Number(body.folderId);
  if (!Number.isInteger(folderId) || !c.collections.has(folderId)) {
    throw new RequestError(400, `Unknown folder: ${body.folderId}`);
  }
  return { folderId };
}

// The rows of an apply job. Each row names an existing folder, or a new folder to create, and the final tags.
// A malformed request is refused. A row with a bad folder or bad tags is listed in `rejected`, and the others go on.
// The final tags are sent as the user left them. The app does not add tags on its own.
export function changesOf(body, c) {
  if (!Array.isArray(body.changes) || body.changes.length === 0) throw new RequestError(400, 'No suggestions to apply.');
  const changes = new Map();
  const rejected = [];
  for (const ch of body.changes) {
    const id = Number(ch?.id);
    if (!Number.isInteger(id)) throw new RequestError(400, 'Bookmark ids must be whole numbers.');
    if (changes.has(id) || rejected.some((r) => r.id === id)) throw new RequestError(400, 'A bookmark is listed twice.');
    const reject = (reason) => rejected.push({ id, reason });
    let tags;
    try {
      tags = cleanTags(tagList(ch.tags));
      checkTags(tags);
    } catch (err) {
      reject(err.message);
      continue;
    }
    const newFolder = typeof ch.newFolder === 'string' ? ch.newFolder.trim() : '';
    if (newFolder) {
      try {
        checkFolderName(newFolder);
      } catch (err) {
        reject(err.message);
        continue;
      }
      changes.set(id, { folderId: null, newFolder, tags });
      continue;
    }
    const folderId = Number(ch.folderId);
    if (!Number.isInteger(folderId) || !c.collections.has(folderId)) {
      reject('Choose a folder that exists.');
      continue;
    }
    changes.set(id, { folderId, newFolder: null, tags });
  }
  return { changes, rejected };
}
