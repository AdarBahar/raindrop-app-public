// The undo of a finished bulk job. See src/bulk.js.
import { loadAll } from './bookmarks.js';
import { raindropCall } from './raindrop.js';
import { connectionGeneration, writeThrough } from './sync.js';
import { RequestError, serialize } from './util.js';
import { fail, failJob, getJob, jobs, kept, newJob, pendingOf } from './bulk-jobs.js';
import { apply, sameState, snapshot } from './bulk-state.js';

// Start an undo job. It restores the folder and tags that each change of the original job replaced.
export async function startUndo(svc, userId, jobId, call = raindropCall) {
  const original = getJob(svc, userId, jobId);
  if (!original) throw new RequestError(404, 'job not found');
  if (original.status === 'running') throw new RequestError(409, 'The job is still running.');
  if (original.undoing) throw new RequestError(409, 'An undo of this job is still running.');
  if (original.changes.length === 0) throw new RequestError(409, 'Nothing to undo.');
  const pending = pendingOf(original);
  if (pending.length === 0) throw new RequestError(409, 'This job was already undone.');

  original.undoing = true;
  const job = newJob(userId, 'undo', pending.length, { isUndo: true, origin: original });
  jobs(svc).set(job.id, job);
  runUndo(svc, userId, job, original, pending, call).catch((err) => failJob(job, err));
  return job;
}

// Restore one bookmark at a time, on its own turn for this user, so undo and other jobs do not overlap.
async function runUndo(svc, userId, job, original, pending, call) {
  try {
    for (const change of pending) {
      if (job.cancelled) break;
      await serialize(userId, () => restoreOne(svc, userId, job, original, change, call));
    }
    job.status = job.cancelled ? 'cancelled' : 'done';
  } finally {
    original.undoing = false;
    job.finishedAt = Date.now();
  }
}

async function restoreOne(svc, userId, job, original, change, call) {
  // Cancellation may come while this bookmark waited for its turn.
  if (job.cancelled) return;
  const gen = connectionGeneration(svc, userId);
  const c = await loadAll(svc, userId);
  const item = c.items.find((i) => i._id === change.id);
  const skip = (reason) => fail(job, { _id: change.id, title: change.title }, reason);
  // Read the bookmark from Raindrop. The cache does not see an edit made in Raindrop itself.
  let live;
  try {
    live = (await call(svc, userId, 'GET', `/raindrop/${change.id}`)).item;
  } catch (err) {
    skip(err.message);
    return;
  }
  if (!live || !item) {
    skip('Bookmark not found.');
    return;
  }
  // A bookmark that changed after the job keeps its newer state. The undo must not overwrite it.
  // The bookmark is finished for this undo, so a retry does not restore it later.
  const current = snapshot(live);
  if (!sameState(current, change.after)) {
    original.restored.add(change.id);
    apply(item, { collectionId: current.collection_id ?? -1, tags: current.tags }); // the cache shows the newer state
    skip('Changed after the update. Not restored.');
    return;
  }
  // One single update sets the folder and the tags together. Single updates replace the tags.
  const body = { tags: change.before.tags };
  if (change.before.collection_id !== null) body.collection = { $id: change.before.collection_id };
  let res;
  try {
    res = await call(svc, userId, 'PUT', `/raindrop/${change.id}`, body);
  } catch (err) {
    skip(err.message);
    return;
  }
  await writeThrough(svc, userId, gen, res?.item?._id === change.id
    ? { type: 'upsert', item: res.item }
    : { type: 'update', ids: [change.id], collectionId: change.before.collection_id ?? undefined, tags: change.before.tags });
  // Only a restore that Raindrop accepted counts. A failed one stays pending, so a retry can run it.
  original.restored.add(change.id);
  const before = snapshot(item);
  item.tags = [...change.before.tags];
  if (change.before.collection_id !== null) item.collection = { $id: change.before.collection_id };
  job.done += 1;
  if (!kept(svc, job)) return; // deleted with the user's data: no log row
  try {
    await svc.store.addLog(userId, {
      time: new Date().toISOString(),
      id: change.id,
      title: change.title,
      bulk: job.id,
      undo_of: job.id,
      before,
      after: snapshot(item),
      tags_match: true,
    });
  } catch (err) {
    job.warnings.push({ id: change.id, title: change.title, reason: `Restored in Raindrop. The local log could not be written: ${err.message}` });
  }
}
