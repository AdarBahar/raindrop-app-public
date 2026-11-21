// Read helpers for the Raindrop API. The live load (src/bookmarks.js) and the full sync (src/sync.js) use them.
// Each helper takes the call function, so a test can give a fake one. Its form is call(svc, userId, method, path).
import { config } from './config.js';

// All folders: the root folders first, then the child folders, in the order that Raindrop gives them.
export async function fetchCollections(svc, userId, call) {
  const all = [];
  for (const path of ['/collections', '/collections/childrens']) {
    const res = await call(svc, userId, 'GET', path);
    all.push(...(res.items ?? []));
  }
  return all;
}

// The number of bookmarks that Raindrop reports for /raindrops/0 (all except Trash), or null.
export async function remoteCount(svc, userId, call) {
  const stats = await call(svc, userId, 'GET', '/user/stats');
  const count = (stats.items ?? []).find((item) => item._id === 0)?.count;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

// All bookmarks, page by page. beforePage() runs before each request and can throw to stop the fetch.
// onPage(loaded) runs after each page with the number of bookmarks so far.
export async function fetchAllItems(svc, userId, call, { beforePage, onPage } = {}) {
  const items = [];
  for (let page = 0; ; page++) {
    beforePage?.();
    const res = await call(svc, userId, 'GET', `/raindrops/0?perpage=${config.pageSize}&page=${page}`);
    const batch = res.items ?? [];
    items.push(...batch);
    onPage?.(items.length);
    if (batch.length < config.pageSize) break;
  }
  return items;
}
