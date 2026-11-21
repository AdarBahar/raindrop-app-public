// A live check of the Raindrop API behavior that the stored copy depends on.
// See docs/bookmark-store-plan.md, section 6 and section 10. Run it by hand, with a TEST account.
//
//   RAINDROP_TEST_TOKEN=<test token> EXPECT_EMAIL=<email of the test account> node scripts/live-api-check.mjs [report.json]
//
// The test token is on the Raindrop developer page of your app. It never expires. Do not use it for another purpose.
//
// Safety:
//  - The script stops if the email of the token is not EXPECT_EMAIL.
//  - It creates two folders and three bookmarks with the prefix "zz-sync-check". It changes only these.
//  - It never empties the Trash and never uses a bulk delete.
//  - At the end it deletes what it created. If this fails, it prints the IDs to delete by hand.
// The report has the observed answers and the objects that Raindrop returned for the items it created.
// The objects can replace test/fixtures/raindrop-sample.json after you read them.
import { writeFile } from 'node:fs/promises';

const BASE = process.env.RAINDROP_API_BASE ?? 'https://api.raindrop.io/rest/v1';
const TOKEN = process.env.RAINDROP_TEST_TOKEN ?? '';
const EXPECT_EMAIL = (process.env.EXPECT_EMAIL ?? '').toLowerCase();
const REPORT = process.argv[2] ?? 'live-api-check-report.json';
const PREFIX = 'zz-sync-check';
const PAUSE_MS = 700; // keeps the script under 120 calls each minute

if (!TOKEN || !EXPECT_EMAIL) {
  console.error('Set RAINDROP_TEST_TOKEN and EXPECT_EMAIL. See the comment at the top of this file.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function api(method, path, body) {
  await sleep(PAUSE_MS);
  calls += 1;
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
  return { status: res.status, ok: res.ok, json, text: json ? undefined : text.slice(0, 200), headers: res.headers };
}

const must = (res, what) => {
  if (!res.ok) throw new Error(`${what} failed with ${res.status}: ${JSON.stringify(res.json ?? res.text).slice(0, 200)}`);
  return res.json;
};

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const observed = {};
const created = { folders: [], bookmarks: [] };
const record = (name, value) => {
  observed[name] = value;
  console.log(`${name}: ${JSON.stringify(value)}`);
};

async function getItem(id) {
  return must(await api('GET', `/raindrop/${id}`), `GET /raindrop/${id}`).item;
}

async function countAllPages(limitPages = 100) {
  const ids = [];
  for (let page = 0; page < limitPages; page++) {
    const res = must(await api('GET', `/raindrops/0?perpage=50&page=${page}`), 'GET /raindrops/0');
    ids.push(...res.items.map((i) => i._id));
    if (res.items.length < 50) return { ids, complete: true };
  }
  return { ids, complete: false };
}

async function statsCount() {
  const stats = must(await api('GET', '/user/stats'), 'GET /user/stats');
  return stats.items.find((i) => i._id === 0)?.count ?? null;
}

async function main() {
  const me = must(await api('GET', '/user'), 'GET /user').user;
  const email = String(me.email ?? '').toLowerCase();
  console.log(`Account: ${me.fullName ?? '(no name)'} <${email}>`);
  if (email !== EXPECT_EMAIL) throw new Error(`The token belongs to ${email}, not to ${EXPECT_EMAIL}. Nothing was changed.`);

  const stamp = Date.now();
  const startCount = await statsCount();
  record('stats count at the start', startCount);

  // Set up: two folders and three bookmarks in folder A.
  for (const name of ['A', 'B']) {
    const res = must(await api('POST', '/collection', { title: `${PREFIX}-${name}-${stamp}` }), 'create folder');
    created.folders.push(res.item._id);
  }
  const [folderA, folderB] = created.folders;
  for (let n = 1; n <= 3; n++) {
    const res = must(await api('POST', '/raindrop', {
      link: `https://example.com/${PREFIX}-${stamp}-${n}`,
      title: `${PREFIX} ${n}`,
      tags: ['t1'],
      collection: { $id: folderA },
      pleaseParse: {},
    }), 'create bookmark');
    created.bookmarks.push(res.item._id);
  }
  const ids = created.bookmarks;

  // 1. The stats count. It must equal the number of items that /raindrops/0 returns.
  const afterCreate = await statsCount();
  record('stats count grew by the 3 created bookmarks', afterCreate === startCount + 3);
  const all = await countAllPages();
  record('stats count equals the items of /raindrops/0', all.complete ? afterCreate === all.ids.length : 'not checked: more than 5,000 bookmarks');

  // 2. Bulk move on collection 0.
  const before = await Promise.all(ids.map(getItem));
  const move = await api('PUT', '/raindrops/0', { ids, collection: { $id: folderB } });
  record('bulk move: status and body', { status: move.status, body: move.json });
  const afterMove = await Promise.all(ids.map(getItem));
  record('bulk move changed the folder of all ids', afterMove.every((i) => i.collection?.$id === folderB));
  record('bulk move changed lastUpdate', afterMove.every((it, k) => it.lastUpdate !== before[k].lastUpdate));

  // 3. Bulk tags on collection 0: append or replace.
  const tags = await api('PUT', '/raindrops/0', { ids, tags: ['t2'] });
  record('bulk tags: status and body', { status: tags.status, body: tags.json });
  const afterTags = await Promise.all(ids.map(getItem));
  record('bulk tags result for the first bookmark', afterTags[0].tags);
  record('bulk tags APPEND (expected t1 and t2)', afterTags.every((i) => sameSet(i.tags, ['t1', 't2'])));
  record('bulk tags REPLACE (only t2)', afterTags.every((i) => sameSet(i.tags, ['t2'])));
  const again = await api('PUT', '/raindrops/0', { ids, tags: ['t2'] });
  const afterAgain = await Promise.all(ids.map(getItem));
  record('a repeated bulk tags call changes nothing', again.ok && afterAgain.every((i, k) => sameSet(i.tags, afterTags[k].tags)));

  // 4. A single update replaces the tags and returns the item.
  const single = await api('PUT', `/raindrop/${ids[0]}`, { tags: ['only'] });
  record('single update returns the item', Boolean(single.json?.item?._id === ids[0]));
  record('single update REPLACES the tags', sameSet(single.json?.item?.tags ?? [], ['only']));

  // 5. Information for a later delta sync (deferred in the plan, section 10).
  const sorted = await api('GET', '/raindrops/0?sort=-lastUpdate&perpage=5');
  record('sort=-lastUpdate: status', sorted.status);
  record('sort=-lastUpdate: first id is the item changed last', sorted.json?.items?.[0]?._id === ids[0]);

  // 6. Delete to Trash: the count and the list.
  const trashed = await api('DELETE', `/raindrop/${ids[2]}`);
  record('delete to Trash: status', trashed.status);
  const afterDelete = await statsCount();
  record('stats count fell by 1 after the delete to Trash', afterDelete === afterCreate - 1);
  const stillThere = (await countAllPages()).ids.includes(ids[2]);
  record('a trashed bookmark is not in /raindrops/0', !stillThere);

  // The objects that Raindrop returned, for a fixture. Only the created items. Account data is replaced.
  const objects = {
    collections: must(await api('GET', '/collections'), 'GET /collections').items.filter((c) => created.folders.includes(c._id)),
    bookmarks: (await Promise.all(ids.slice(0, 2).map(getItem))),
  };
  const scrub = (value) => JSON.parse(JSON.stringify(value, (key, v) => {
    if (key === 'user' && v && typeof v === 'object') return { $ref: 'user', $id: 1 };
    if (key === 'creatorRef') return { _id: 1, name: 'Test User' };
    return v;
  }));
  await writeFile(REPORT, JSON.stringify({ account: 'scrubbed', calls, observed, objects: scrub(objects) }, null, 2));
  console.log(`Report written to ${REPORT}`);
}

// Delete what the script created. A bookmark moves to the Trash first, and the second delete removes it.
async function cleanup() {
  const left = [];
  for (const id of created.bookmarks) {
    try {
      await api('DELETE', `/raindrop/${id}`);
      await api('DELETE', `/raindrop/${id}`);
    } catch { left.push(`bookmark ${id}`); }
  }
  for (const id of created.folders) {
    try {
      const res = await api('DELETE', `/collection/${id}`);
      if (!res.ok) left.push(`folder ${id}`);
    } catch { left.push(`folder ${id}`); }
  }
  if (left.length) console.error(`Delete these by hand in Raindrop (look for "${PREFIX}"): ${left.join(', ')}`);
  else console.log('Cleanup done.');
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
