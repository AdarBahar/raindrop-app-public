import { config } from './config.js';
import { loadAll } from './bookmarks.js';
import { classifyV2 } from './llm.js';
import { raindropCall } from './raindrop.js';
import { typeForLink } from './rules.js';
import { connectionGeneration, writeThrough } from './sync.js';
import { cleanTags, RequestError, sameTagSet, serialize, titleOf } from './util.js';
import { fail, failJob, finishJob, getJob, jobs, kept, newJob, pruneJobs, runningSuggest } from './bulk-jobs.js';
import { changesOf, folderTargetOf, resolveIds, selectorOf, tagTargetOf } from './bulk-input.js';
import { apply, sameState, snapshot, stateOf } from './bulk-state.js';
import { runSuggest } from './bulk-suggest.js';

// Bulk edits of many bookmarks. A job runs in the background on the server.
// Jobs are kept in memory. A server restart ends them.
// Each batch reads the current tags and folders. Batches of one user run one at a time,
// so two jobs cannot overwrite each other's changes.

// The modules of the bulk feature:
//  - bulk-jobs.js: the job registry, the job shape and the job end states.
//  - bulk-input.js: the checks of the request body.
//  - bulk-state.js: the folder and tags of a bookmark before and after a change.
//  - bulk-suggest.js: the suggest job. bulk-undo.js: the undo job.
// This file starts the jobs and runs the move, tag and apply changes. Other code imports from this file only.
export { cancelJob, forgetJobs, getJob, jobView } from './bulk-jobs.js';
export { startUndo } from './bulk-undo.js';

// suggest asks the model and saves nothing. apply saves the reviewed suggestions.
const ACTIONS = new Set(['move', 'addTags', 'removeTags', 'suggest', 'apply']);

// Start a job for the bookmarks in the body. Returns the job at once. Work continues in the background.
// `call` makes the Raindrop request. Tests pass a fake.
export async function startJob(svc, userId, body, call = raindropCall, ask = classifyV2) {
  if (!ACTIONS.has(body.action)) throw new RequestError(400, 'Unknown bulk action.');
  // Tag input and the selection are checked before the bookmarks load, so bad input never causes a Raindrop call.
  const tagChange = body.action === 'addTags' || body.action === 'removeTags' ? tagTargetOf(body) : null;
  const selector = body.action === 'apply' ? null : selectorOf(body);
  const c = await loadAll(svc, userId);
  let change = tagChange;
  if (body.action === 'move') change = folderTargetOf(body, c);
  // A bad row in an apply job is reported on its own. Only a bad request is refused.
  const plan = body.action === 'apply' ? changesOf(body, c) : null;
  let baseline = null;
  if (plan && body.from !== undefined) {
    const review = getJob(svc, userId, String(body.from));
    if (!review || review.action !== 'suggest' || !review.reviewed) {
      throw new RequestError(400, 'The review is no longer available. Run the suggestion again.');
    }
    baseline = review.reviewed;
    for (const id of [...plan.changes.keys()]) {
      if (!baseline.has(id)) {
        plan.changes.delete(id);
        plan.rejected.push({ id, reason: 'This bookmark was not in the review.' });
      }
    }
  }
  const ids = plan ? [...plan.changes.keys()] : await resolveIds(svc, userId, selector);
  if (plan) change = plan.changes;
  if (ids.length === 0 && !(plan && plan.rejected.length)) throw new RequestError(400, 'No bookmarks are selected.');
  if (ids.length > config.bulkMax) {
    throw new RequestError(400, `A bulk action can change at most ${config.bulkMax} bookmarks.`);
  }

  // One suggest job for each user at a time, because all users share the model endpoint.
  // Checked here, with no await before the job is stored, so two requests cannot both pass.
  if (body.action === 'suggest' && runningSuggest(svc, userId)) {
    throw new RequestError(409, 'A suggestion job is already running. Wait for it to finish, or cancel it.');
  }
  pruneJobs(svc);
  const job = newJob(userId, body.action, ids.length + (plan ? plan.rejected.length : 0), {
    restored: new Set(), // ids of bookmarks whose undo finished: restored, or skipped because they changed again
    undoing: false, // true while an undo job runs
    isUndo: false,
    suggestions: [], // proposals of a suggest job. Nothing is saved for them.
    reviewed: null, // suggest job: the state of each bookmark when it was reviewed
    baseline, // apply job: the reviewed state that Raindrop is compared with. Null compares with the cache.
  });
  jobs(svc).set(job.id, job);
  // Rows refused in the apply plan are reported first, so the job shows them with the others.
  if (plan) for (const { id, reason } of plan.rejected) fail(job, bookmarkOf(c, id), reason);
  const work = body.action === 'suggest'
    ? runSuggest(svc, userId, job, ids, ask)
    : body.action === 'apply'
      ? runApply(svc, userId, job, ids, change, call)
      : run(svc, userId, job, ids, change, call);
  work.catch((err) => failJob(job, err));
  return job;
}

// The bookmark for a row, for the job list. A bookmark that is not loaded has no title.
function bookmarkOf(c, id) {
  return c.items.find((item) => item._id === id) ?? { _id: id, title: '' };
}

// Create the new folders of the approved rows, then run the moves. A folder is created once, even when
// several rows share it. A name that matches an existing folder, ignoring case, uses that folder.
// A folder that cannot be created fails its rows. Those rows are not moved.
async function runApply(svc, userId, job, ids, change, call) {
  const wanted = new Map(); // lower-case name -> the rows that want it
  for (const id of ids) {
    const row = change.get(id);
    if (row.newFolder === null) continue;
    const key = row.newFolder.toLowerCase();
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(id);
  }
  const failedIds = new Set();
  for (const [key, rowIds] of wanted) {
    // A cancel stops the folder step. The rows of the folders not yet made are not moved.
    if (job.cancelled) break;
    const name = change.get(rowIds[0]).newFolder;
    try {
      // The lookup and the creation run in one queue turn. A folder that another job made is found here.
      const folderId = await serialize(userId, async () => {
        if (job.cancelled) return null; // a cancel may come while this step waits in the queue
        const c = await loadAll(svc, userId);
        const existing = [...c.collections].find(([, n]) => n.toLowerCase() === key);
        if (existing) return existing[0];
        const gen = connectionGeneration(svc, userId);
        const res = await call(svc, userId, 'POST', '/collection', { title: name });
        const created = res.item ?? {};
        if (created._id === undefined) throw new Error('Raindrop did not return the new folder.');
        await writeThrough(svc, userId, gen, { type: 'upsertCollection', collection: created });
        c.collections.set(created._id, created.title ?? name);
        return created._id;
      });
      if (folderId === null) break;
      for (const id of rowIds) change.get(id).folderId = folderId;
    } catch (err) {
      const c = await loadAll(svc, userId);
      for (const id of rowIds) {
        failedIds.add(id);
        fail(job, bookmarkOf(c, id), `The folder ${name} could not be created: ${err.message}`);
      }
    }
  }
  // Only rows with a folder are moved. A row without one was cancelled before its folder was made.
  await run(svc, userId, job, ids.filter((id) => !failedIds.has(id) && change.get(id).folderId !== null), change, call);
}

// The state that one bookmark must have after the action. Null means no change is needed.
function nextState(action, item, change) {
  if (action === 'move') {
    return item.collection?.$id === change.folderId ? null : { collectionId: change.folderId };
  }
  if (action === 'apply') {
    // Each bookmark has its own folder and tags. Only the parts that differ are sent.
    const want = change.get(item._id);
    const next = {};
    if (want.folderId !== item.collection?.$id) next.collectionId = want.folderId;
    if (!sameTagSet(item.tags ?? [], want.tags)) next.tags = want.tags;
    // The type comes from the link (rules.js): an image or a video. Other links keep their type.
    const kind = typeForLink(item.link);
    if (kind && kind !== item.type) next.type = kind;
    return Object.keys(next).length === 0 ? null : next;
  }
  const current = item.tags ?? [];
  if (action === 'addTags') {
    const merged = cleanTags([...current, ...change.tags]);
    if (merged.length === current.length) return null;
    if (merged.length > config.limits.tagsPerBookmark) {
      throw new Error(`The bookmark would have more than ${config.limits.tagsPerBookmark} tags.`);
    }
    return { tags: merged };
  }
  const remove = new Set(change.tags.map((t) => t.toLowerCase()));
  const kept = current.filter((t) => !remove.has(t.toLowerCase()));
  return kept.length === current.length ? null : { tags: kept };
}

// Process the bookmarks in chunks. Each chunk runs on its own turn for this user.
async function run(svc, userId, job, ids, change, call) {
  // Raindrop's bulk call can only append tags or remove all of them. Each bookmark gets its own call.
  const size = job.action === 'removeTags' || job.action === 'apply' ? 1 : config.bulkBatch;
  for (let i = 0; i < ids.length; i += size) {
    if (job.cancelled) break;
    const chunk = ids.slice(i, i + size);
    await serialize(userId, () => runChunk(svc, userId, job, chunk, change, call));
  }
  finishJob(job);
}

// Read the current state, send one Raindrop call, and update the cache. Then write the log.
async function runChunk(svc, userId, job, ids, change, call) {
  // The job may have been cancelled while this chunk waited in the queue.
  if (job.cancelled) return;
  const gen = connectionGeneration(svc, userId); // before the Raindrop calls: a disconnect during a call stops the database write
  const c = await loadAll(svc, userId);
  const byId = new Map(c.items.map((item) => [item._id, item]));
  const work = [];
  // Apply and removeTags replace the tags of one bookmark. The cache can be up to five minutes old, so
  // the bookmark is read from Raindrop first. The decision and the undo snapshot then use the live state.
  const replacing = job.action === 'apply' || job.action === 'removeTags';
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) {
      fail(job, { _id: id, title: '' }, 'Bookmark not found.');
      continue;
    }
    if (replacing) {
      let live;
      try {
        live = (await call(svc, userId, 'GET', `/raindrop/${id}`)).item;
      } catch (err) {
        fail(job, item, err.message);
        continue;
      }
      if (!live) {
        fail(job, item, 'Bookmark not found.');
        continue;
      }
      // Apply sends the whole reviewed set of tags and folder. If Raindrop changed the bookmark after the
      // list was loaded, that write would undo the change, so the bookmark is left as it is.
      const reviewed = job.baseline?.get(id) ?? stateOf(item.collection, item.tags);
      const changed = !sameState(reviewed, stateOf(live.collection, live.tags));
      // The cached bookmark is brought up to date, so the rest of the job sees the live state too.
      item.collection = live.collection ?? item.collection;
      item.tags = live.tags ?? item.tags;
      // The type follows the live link, so an old cached link cannot set the type.
      item.link = live.link ?? item.link;
      item.type = live.type ?? item.type;
      if (job.action === 'apply' && changed) {
        fail(job, item, 'Changed in Raindrop after the list was loaded. Not updated.');
        continue;
      }
    }
    try {
      const next = nextState(job.action, item, change);
      if (next) work.push({ item, next, before: snapshot(item) });
      else {
        // Already in the target state. It counts as done, but the result says that it did not change.
        job.done += 1;
        job.unchanged += 1;
      }
    } catch (err) {
      fail(job, item, err.message);
    }
  }
  if (work.length === 0) return;

  const bookmarkIds = work.map((e) => e.item._id);
  let request;
  if (job.action === 'removeTags' || job.action === 'apply') {
    // One single update sets the folder and the tags of this bookmark. Single updates replace the tags.
    const body = {};
    if (work[0].next.tags !== undefined) body.tags = work[0].next.tags;
    if (work[0].next.collectionId !== undefined) body.collection = { $id: work[0].next.collectionId };
    if (work[0].next.type !== undefined) body.type = work[0].next.type;
    request = () => call(svc, userId, 'PUT', `/raindrop/${bookmarkIds[0]}`, body);
  } else if (job.action === 'move') {
    request = () => call(svc, userId, 'PUT', '/raindrops/0', { ids: bookmarkIds, collection: { $id: change.folderId } });
  } else {
    request = () => call(svc, userId, 'PUT', '/raindrops/0', { ids: bookmarkIds, tags: change.tags });
  }

  let res;
  try {
    res = await request();
  } catch (err) {
    for (const { item } of work) fail(job, item, err.message);
    return;
  }

  // Raindrop accepted the change. The stored copy follows (plan, section 6). The bulk calls return no items,
  // so the stored copy gets the same change as the request. A single update returns the item.
  if (job.action === 'removeTags' || job.action === 'apply') {
    const { item, next } = work[0];
    await writeThrough(svc, userId, gen, res?.item?._id === item._id
      ? { type: 'upsert', item: res.item }
      : { type: 'update', ids: [item._id], collectionId: next.collectionId, tags: next.tags });
  } else if (job.action === 'move') {
    await writeThrough(svc, userId, gen, { type: 'move', ids: bookmarkIds, collectionId: change.folderId });
  } else {
    await writeThrough(svc, userId, gen, { type: 'addTags', ids: bookmarkIds, tags: change.tags });
  }

  // Raindrop has changed these bookmarks. Update the cache and count them before the log is written.
  for (const { item, next } of work) {
    apply(item, next);
    job.done += 1;
  }
  for (const entry of work) await record(svc, userId, job, entry);
}

// Write the removed "New" label and the log entry. A failure here does not undo the change.
// The job keeps the state before and after each change. Undo compares the current state with "after".
async function record(svc, userId, job, { item, before }) {
  if (!kept(svc, job)) return;
  const after = snapshot(item);
  job.changes.push({ id: item._id, title: titleOf(item), before, after });
  try {
    await svc.store.removeNew(userId, item._id);
    if (!kept(svc, job)) return; // deleted while the change was sent: no log row
    await svc.store.addLog(userId, {
      time: new Date().toISOString(),
      id: item._id,
      title: titleOf(item),
      bulk: job.id,
      before,
      after,
      tags_match: true,
    });
  } catch (err) {
    job.warnings.push({
      id: item._id,
      title: titleOf(item),
      reason: `Changed in Raindrop. The local log could not be written: ${err.message}`,
    });
  }
}
