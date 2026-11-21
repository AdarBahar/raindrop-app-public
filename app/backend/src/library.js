// The bookmarks and folders of each user, in memory: the load from Raindrop or from the stored copy,
// the cache, and the account name. See src/bookmarks.js.
import { config } from './config.js';
import { raindropCall } from './raindrop.js';
import { fetchAllItems, fetchCollections, remoteCount } from './raindrop-fetch.js';
import { storeVersion, syncProgress } from './sync.js';
import { RequestError } from './util.js';

// Each user has a separate cache of Raindrop bookmarks and folders.
export function userCache(svc, userId) {
  if (!svc.cache.has(userId)) {
    svc.cache.set(userId, {
      at: 0,
      items: [],
      collections: new Map(),
      progress: { loaded: 0, total: 0 },
      loading: null,
    });
  }
  return svc.cache.get(userId);
}

// The bookmarks and folders of one user, in memory. With the stored copy (config.bookmarkStore) they come
// from the database, and a full sync fills it (src/sync.js). Without it, they come from Raindrop.
export function loadAll(svc, userId, force = false) {
  return config.bookmarkStore ? loadFromStore(svc, userId) : loadFromRaindrop(svc, userId, force);
}

// Read the stored copy. It never calls Raindrop and never starts a sync, so it is safe inside a queue turn.
// A user with no copy gets the error 409. Routes call ensureSnapshot() before they take a turn.
// The memory object stays valid until a snapshot commit raises the store version, or the user disconnects.
// A change from this app updates the objects in place, as it did before, and writes the database
// (writeThrough), so the memory and the database stay equal.
function loadFromStore(svc, userId) {
  const c = userCache(svc, userId);
  if (c.stored && c.version === storeVersion(svc, userId)) return Promise.resolve(c);
  if (c.loading) return c.loading;

  c.loading = (async () => {
    const version = storeVersion(svc, userId);
    const state = await svc.store.getSyncState(userId);
    if (!state?.lastFullAt) throw new RequestError(409, 'The bookmarks are not synced yet. Try again in a moment.');
    const [items, folders] = await Promise.all([svc.store.loadBookmarks(userId), svc.store.loadCollections(userId)]);
    const collections = new Map([[-1, 'Unsorted']]);
    for (const folder of folders) collections.set(folder._id, folder.title);
    // A commit that ran during the read makes this data old. The version stays as it was, so the next call reads again.
    Object.assign(c, { at: Date.now(), items, collections, stored: true, version });
    return c;
  })().finally(() => {
    c.loading = null;
  });
  return c.loading;
}

// Load all bookmarks of one user from Raindrop. Concurrent calls share one load.
function loadFromRaindrop(svc, userId, force = false) {
  const c = userCache(svc, userId);
  if (c.loading) return c.loading;
  if (!force && c.items.length && Date.now() - c.at < config.cacheMs) return Promise.resolve(c);

  c.loading = (async () => {
    const collections = new Map([[-1, 'Unsorted']]);
    const totals = new Map();
    for (const col of await fetchCollections(svc, userId, raindropCall)) {
      collections.set(col._id, col.title);
      totals.set(col._id, col.count ?? 0);
    }
    const progress = { loaded: 0, total: await allCount(svc, userId, totals) };
    c.progress = progress;

    const items = await fetchAllItems(svc, userId, raindropCall, {
      onPage: (loaded) => {
        progress.loaded = loaded;
      },
    });
    Object.assign(c, { at: Date.now(), items, collections });
    return c;
  })().finally(() => {
    c.loading = null;
  });
  return c.loading;
}

// The number of bookmarks that /raindrops/0 returns: all of them except Trash.
// Raindrop gives this count in the system collection counts, under _id 0. The named collections
// do not include Unsorted, so their sum is too small. It is used only when the count is missing.
// The count is shown in the progress text only, so a failed call must not stop the load.
async function allCount(svc, userId, totals) {
  try {
    const all = await remoteCount(svc, userId, raindropCall);
    if (all !== null) return all;
  } catch {
    // Fall through to the sum.
  }
  return [...totals.values()].reduce((a, b) => a + b, 0);
}

// Drop the cache of one user, for example after a disconnect.
export function forget(svc, userId) {
  svc.cache.delete(userId);
  svc.profiles.delete(userId);
}

// Name and email of the Raindrop account connected for one user. Cached until disconnect.
export async function account(svc, userId) {
  if (!svc.profiles.has(userId)) {
    const res = await raindropCall(svc, userId, 'GET', '/user');
    svc.profiles.set(userId, { name: res.user?.fullName ?? '', email: res.user?.email ?? '' });
  }
  return svc.profiles.get(userId);
}

export function progress(svc, userId) {
  // A running sync has its own counter. The first sync of a user is what the loading bar shows.
  return (config.bookmarkStore && syncProgress(svc, userId)) || { ...userCache(svc, userId).progress };
}

export async function findItem(svc, userId, rid) {
  const c = await loadAll(svc, userId);
  return c.items.find((item) => item._id === rid) ?? null;
}
