// The timer of the full sync. See src/sync.js.
import { config } from './config.js';
import { NotConnectedError } from './oauth.js';
import { serialize, sleep } from './util.js';
import { SyncDiscarded, syncNow } from './sync.js';

// --- The timer (plan, section 7) -------------------------------------------------------------
// The timer runs in the Node.js process. It reads the sync state from the database, so a restart loses
// nothing. The dirty flags in memory work when the database is the cause of a failure.

// True when a connected user needs a sync now. `user` is a row of listSyncUsers().
//  - A user with a dirty flag is due (a database write failed, and the state may not hold the retry).
//  - A retry time rules: a failed user waits for it, even when the copy is old.
//  - Otherwise a user with a copy is due when the copy is older than config.sync.staleMs.
//  - A user without a copy waits for the first visit. The first visit makes the first sync.
export function isDue(user, now, dirty = false) {
  if (dirty) return true;
  if (user.nextRetryAt) return Date.parse(user.nextRetryAt) <= now.getTime();
  if (user.lastFullAt) return now.getTime() - Date.parse(user.lastFullAt) >= config.sync.staleMs;
  return false;
}

// Sync the users who are due, one at a time. It never throws. Returns the counts, for the tests.
// opts: call, wait, now (as for syncNow), pause (the wait between users).
export async function syncDueUsers(svc, opts = {}) {
  const result = { due: 0, ok: 0, failed: 0 };
  if (!config.bookmarkStore) return result;
  const now = opts.now ?? (() => new Date());
  const pause = opts.pause ?? ((ms) => sleep(Math.random() * ms));
  const dirty = (svc.dirty ??= new Set());
  let users = [];
  try {
    users = await svc.store.listSyncUsers();
  } catch (err) {
    console.error('The timer could not read the users:', err.message);
  }
  // A dirty user may be missing from the list when the database failed. Sync those users too.
  const known = new Set(users.map((u) => u.userId));
  for (const userId of dirty) {
    if (!known.has(userId)) users.push({ userId, lastFullAt: null, nextRetryAt: null, consecutiveFailures: 0 });
  }
  const due = users.filter((u) => isDue(u, now(), dirty.has(u.userId)));
  result.due = due.length;
  for (let i = 0; i < due.length; i++) {
    const { userId } = due[i];
    if (svc.changing?.has(userId)) continue;
    dirty.delete(userId); // a failure puts it back when the state cannot hold the retry
    try {
      await syncNow(svc, userId, opts);
      result.ok++;
    } catch (err) {
      // A user who is not connected or a discarded sync is not a failure of the copy.
      if (!(err instanceof SyncDiscarded || err instanceof NotConnectedError)) result.failed++;
    }
    if (i < due.length - 1) await pause(config.sync.spreadMs);
  }
  return result;
}

// Delete the stored rows of users who have no tokens. The turn checks again, because a user can connect
// between the list and the turn. The connect step of the callback also deletes the rows of an old connection.
export async function sweepOrphans(svc) {
  if (!config.bookmarkStore) return 0;
  let swept = 0;
  let orphans = [];
  try {
    orphans = await svc.store.listStoreOrphans();
  } catch (err) {
    console.error('The timer could not look for orphan rows:', err.message);
    return 0;
  }
  for (const userId of orphans) {
    try {
      await serialize(userId, async () => {
        if (svc.changing?.has(userId) || (await svc.store.getTokens(userId))) return;
        await svc.store.deleteBookmarkStore(userId);
        swept++;
      });
    } catch (err) {
      console.error(`Could not delete the orphan rows of ${userId}:`, err.message);
    }
  }
  if (swept) console.log(`Deleted the stored rows of ${swept} user(s) who have no Raindrop connection.`);
  return swept;
}

// The hourly summary line. It returns the numbers, for the tests.
export async function logStats(svc, now = new Date()) {
  const users = await svc.store.listSyncUsers();
  const times = users.map((u) => u.lastFullAt).filter(Boolean).map(Date.parse);
  const stats = {
    connected: users.length,
    oldestHours: times.length ? Math.round(((now.getTime() - Math.min(...times)) / 3600000) * 10) / 10 : null,
    failing: users.filter((u) => u.consecutiveFailures >= config.sync.failureAlert).length,
  };
  console.log(`sync-stats connected=${stats.connected} oldest_sync_hours=${stats.oldestHours} users_failing=${stats.failing}`);
  return stats;
}

// Start the timer. One tick: sync the due users, then delete orphan rows. The first tick runs at once.
// It returns a function that stops the timer.
export function startSyncTimer(svc, opts = {}) {
  if (!config.bookmarkStore) return () => {};
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a long run must not overlap the next tick
    ticking = true;
    try {
      await syncDueUsers(svc, opts);
      await sweepOrphans(svc);
    } catch (err) {
      console.error('The sync timer failed:', err.message);
    } finally {
      ticking = false;
    }
  };
  const stats = () => logStats(svc).catch((err) => console.error('Could not write the sync summary:', err.message));
  tick();
  stats();
  const timers = [setInterval(tick, config.sync.timerMs), setInterval(stats, config.sync.statsMs)];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}
