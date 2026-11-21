// The full sync of one user: Raindrop to the stored copy in PostgreSQL.
// The rules are in docs/bookmark-store-plan.md, sections 3, 5 and 6. In short:
//  - The fetch runs outside the queue. Only the short commit takes the queue of the user (Q1).
//  - A snapshot that fails a check is never committed. The old rows stay.
//  - The commit checks the connection generation. A snapshot of an old connection is discarded.
//  - A mutation that Raindrop accepted during the fetch is in the journal. The commit applies the
//    journal after the snapshot, so the snapshot cannot overwrite it.
// Code inside a Q1 turn must never call syncNow(). The commit would wait for the turn that waits for it.
import { config } from './config.js';
import { generation, NotConnectedError } from './oauth.js';
import { raindropCall } from './raindrop.js';
import { fetchAllItems, fetchCollections, remoteCount } from './raindrop-fetch.js';
import { RequestError, serialize, sleep } from './util.js';
import { applyEffect } from './effects.js';

// The sync stopped because the user disconnected, the connection changed, or someone cancelled it.
// It is not a failure of Raindrop or of the database, so it writes no state.
export class SyncDiscarded extends Error {}

const syncsOf = (svc) => (svc.syncs ??= new Map());

// The effects are in src/effects.js, and the timer is in src/sync-timer.js.
export { addTagsRaw, applyEffect, moveRaw, updateRaw } from './effects.js';

// Call this when Raindrop accepted a change, and before the database write. It does not depend on the
// database write, so a failed write is still in the journal. Only a running sync keeps the entry.
// `gen` is the connection generation that the caller read before the Raindrop call. The running sync takes
// the entry only when it belongs to the same connection. A change that an old connection made must not
// enter the journal of a sync of the new connection: the commit would write it into the new copy.
export function recordEffect(svc, userId, effect, gen) {
  const run = syncsOf(svc).get(userId);
  if (run && !run.closed && run.gen === gen) run.journal.push(structuredClone(effect));
}

// The write-through of a change that Raindrop accepted (plan, section 6). Call it inside the queue turn of
// the operation, after the Raindrop call succeeded. `gen` is the connection generation that the caller read
// before the Raindrop call. It never throws: Raindrop has the change, so the request has not failed.
//  1. The journal of a sync of the same connection gets the change, whatever happens to the database write.
//  2. A changed generation means a disconnect or a new connection. The write is skipped.
//  3. The write runs up to config.sync.writeTries times. If all fail, the user is marked for a sync soon.
export async function writeThrough(svc, userId, gen, effect) {
  if (!config.bookmarkStore) return;
  recordEffect(svc, userId, effect, gen);
  if (generation(svc, userId) !== gen) return;
  let failure;
  for (let attempt = 1; attempt <= config.sync.writeTries; attempt++) {
    try {
      await applyEffect(svc.store, userId, effect);
      return;
    } catch (err) {
      failure = err;
      if (attempt < config.sync.writeTries) await sleep(config.sync.writeRetryMs);
    }
  }
  console.error(`Could not write a change of ${userId} to the stored copy:`, failure.message);
  // The timer reads this flag in PR 4. It works when the database is the cause of the failure.
  (svc.dirty ??= new Set()).add(userId);
  try {
    await svc.store.setRetry(userId, `The database write failed: ${failure.message}`, new Date(Date.now() + 60 * 1000).toISOString());
  } catch (inner) {
    console.error(`Could not record the retry of ${userId}:`, inner.message);
  }
}

// The version of the stored copy of one user in memory. A snapshot commit raises it. A memory cache that
// was loaded under an older version is not valid.
export function storeVersion(svc, userId) {
  return (svc.storeVersions ??= new Map()).get(userId) ?? 0;
}

function bumpStoreVersion(svc, userId) {
  const next = storeVersion(svc, userId) + 1; // this also creates the map
  svc.storeVersions.set(userId, next);
}

// The connection generation that a caller reads before a Raindrop call and gives to writeThrough().
// Without the stored copy, nothing uses it, so it is 0.
export function connectionGeneration(svc, userId) {
  return config.bookmarkStore ? generation(svc, userId) : 0;
}

// Make sure the user has a stored copy. The first call of a user runs the first sync. Call it before the
// queue turn of a request, never inside a turn (plan, section 3). Without the stored copy it does nothing.
export async function ensureSnapshot(svc, userId, opts = {}) {
  if (!config.bookmarkStore) return;
  const state = await svc.store.getSyncState(userId);
  if (state?.lastFullAt) return;
  await syncNow(svc, userId, opts);
}

// --- Connection change -------------------------------------------------------------------------
// While a user connects a Raindrop account, the generation changes before the new tokens are saved. In that
// time a sync would get the new generation and still use the tokens of the old account. So no sync starts
// while the connection changes. A sync that runs already has the old generation, and its commit is discarded.
// Call it inside the queue turn that makes the change. It returns the function that ends the change.
export function beginConnectionChange(svc, userId) {
  const changing = (svc.changing ??= new Set());
  changing.add(userId);
  return () => changing.delete(userId);
}

function refuseDuringChange(svc, userId) {
  if (svc.changing?.has(userId)) {
    throw new RequestError(409, 'The Raindrop connection is changing. Try again in a moment.');
  }
}

// --- Retry times ---------------------------------------------------------------------------

// The wait before the next sync after the n-th failure in a row: 1, 2, 4, then 6 hours.
export function retryDelayMs(failures) {
  const hours = [1, 2, 4, 6];
  return hours[Math.min(Math.max(failures, 1), hours.length) - 1] * 60 * 60 * 1000;
}

// --- Fetch ---------------------------------------------------------------------------------

async function fetchSnapshot(svc, userId, run, call) {
  const before = await remoteCount(svc, userId, call);
  run.progress.total = before ?? 0;
  run.progress.loaded = 0;

  const collections = new Map();
  for (const col of await fetchCollections(svc, userId, call)) collections.set(col._id, col);

  const items = await fetchAllItems(svc, userId, call, {
    beforePage: () => {
      if (run.cancelled) throw new SyncDiscarded('The sync was cancelled.');
    },
    onPage: (loaded) => {
      run.progress.loaded = loaded;
    },
  });

  const after = await remoteCount(svc, userId, call);
  return { before, after, collections: [...collections.values()], items };
}

// The text of the first failed check, or null when the snapshot is good (plan, section 5.2).
function checkSnapshot({ before, after, items }) {
  if (before === null || after === null) return 'Raindrop gave no count of the bookmarks.';
  if (items.some((item) => !Number.isSafeInteger(item?._id))) return 'A bookmark has no valid _id.';
  const unique = new Set(items.map((item) => item._id)).size;
  if (unique !== items.length) return `The snapshot has ${items.length - unique} duplicate bookmark(s).`;
  if (unique !== after) return `The snapshot has ${unique} bookmarks. Raindrop reports ${after}.`;
  if (before !== after) return `The number of bookmarks changed during the fetch, from ${before} to ${after}.`;
  return null;
}

// Fetch until the checks pass, with a limit on the tries.
async function fetchChecked(svc, userId, run, opts) {
  let reason = '';
  for (let attempt = 1; attempt <= config.sync.tries; attempt++) {
    const snapshot = await fetchSnapshot(svc, userId, run, opts.call);
    reason = checkSnapshot(snapshot);
    if (!reason) return snapshot;
    if (attempt < config.sync.tries) await opts.wait(config.sync.retryWaitMs);
  }
  throw new Error(`The snapshot failed a check after ${config.sync.tries} tries: ${reason}`);
}

// --- Commit --------------------------------------------------------------------------------

async function commit(svc, userId, run, snapshot, now) {
  await serialize(userId, async () => {
    if (run.cancelled || generation(svc, userId) !== run.gen) {
      throw new SyncDiscarded('The Raindrop connection changed during the sync.');
    }
    // One transaction. If any step fails, the old rows stay.
    await svc.store.transaction(async (tx) => {
      await tx.upsertCollections(userId, snapshot.collections);
      await tx.deleteCollectionsNotIn(userId, snapshot.collections.map((c) => c._id));
      await tx.upsertBookmarks(userId, snapshot.items);
      await tx.deleteBookmarksNotIn(userId, snapshot.items.map((i) => i._id));
      for (const effect of run.journal) await applyEffect(tx, userId, effect);
      await tx.recordSyncSuccess(userId, now().toISOString());
    });
    // A later change writes to the database after this turn, so it needs no journal entry.
    run.closed = true;
    // The memory cache of the user was loaded before this commit. It is not valid now.
    bumpStoreVersion(svc, userId);
  });
}

async function recordFailure(svc, userId, run, err, now) {
  try {
    await serialize(userId, async () => {
      // A failed old sync must not create a state row after a disconnect.
      if (generation(svc, userId) !== run.gen) return;
      const state = await svc.store.getSyncState(userId);
      const failures = (state?.consecutiveFailures ?? 0) + 1;
      const next = new Date(now().getTime() + retryDelayMs(failures));
      await svc.store.recordSyncFailure(userId, now().toISOString(), err.message, next.toISOString());
      if (failures === config.sync.failureAlert) {
        console.error(`The sync of ${userId} failed ${failures} times in a row. Last error: ${err.message}`);
      }
    });
  } catch (inner) {
    // The database can be the cause of the failure. The in-memory flag makes the timer try again.
    console.error(`Could not record the sync failure of ${userId}:`, inner.message);
    (svc.dirty ??= new Set()).add(userId);
  }
}

// --- The sync ------------------------------------------------------------------------------

// One log line for each sync. Only a service that sets logSyncs writes it, so the tests stay quiet.
function logSync(svc, userId, started, result) {
  if (svc.logSyncs) console.log(`sync user=${userId} duration=${Date.now() - started}ms result=${result}`);
}


async function runSync(svc, userId, run, opts) {
  try {
    let snapshot = await fetchChecked(svc, userId, run, opts);

    // An empty answer for a populated library may be an error of Raindrop. Ask again before a delete.
    if (snapshot.items.length === 0 && (await svc.store.countBookmarks(userId)) > 0) {
      await opts.wait(config.sync.emptyRecheckMs);
      snapshot = await fetchChecked(svc, userId, run, opts);
      if (snapshot.items.length !== 0) {
        throw new Error('Raindrop first returned an empty library, and then returned bookmarks. The stored rows stay.');
      }
    }

    await commit(svc, userId, run, snapshot, opts.now);
    return { bookmarks: snapshot.items.length, collections: snapshot.collections.length };
  } catch (err) {
    if (err instanceof SyncDiscarded || err instanceof NotConnectedError) throw err;
    await recordFailure(svc, userId, run, err, opts.now);
    throw err;
  }
}

// Run a full sync of one user. Callers at the same time share one sync.
// Do not call this inside a queue turn of the same user (plan, section 3).
// opts: call (the Raindrop call), wait (the wait function), now (the clock). Tests replace them.
export function syncNow(svc, userId, opts = {}) {
  const syncs = syncsOf(svc);
  const existing = syncs.get(userId);
  if (existing) return existing.promise;
  refuseDuringChange(svc, userId);

  const run = {
    gen: generation(svc, userId), // read before the first await
    journal: [],
    closed: false,
    cancelled: false,
    progress: { loaded: 0, total: 0 },
    promise: null,
  };
  const started = Date.now();
  run.promise = runSync(svc, userId, run, {
    call: opts.call ?? raindropCall,
    wait: opts.wait ?? sleep,
    now: opts.now ?? (() => new Date()),
  }).then(
    (result) => {
      logSync(svc, userId, started, `ok, ${result.bookmarks} bookmarks`);
      return result;
    },
    (err) => {
      logSync(svc, userId, started, `${err instanceof SyncDiscarded ? 'discarded' : 'failed'}: ${err.message}`);
      throw err;
    },
  ).finally(() => {
    run.closed = true;
    if (syncs.get(userId) === run) syncs.delete(userId);
  });
  syncs.set(userId, run);
  return run.promise;
}

// Stop a running sync at its next step. The old rows stay.
export function cancelSync(svc, userId) {
  const run = syncsOf(svc).get(userId);
  if (run) run.cancelled = true;
}

// The progress of a running sync, or null when no sync runs.
export function syncProgress(svc, userId) {
  const run = syncsOf(svc).get(userId);
  return run ? { ...run.progress } : null;
}
