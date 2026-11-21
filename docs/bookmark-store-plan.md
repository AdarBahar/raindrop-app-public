# Plan: store the bookmarks in the database

Status: PRs 1 to 4 are merged. The stored copy is off in production. Date: 2026-11-10.
Revision 3 added the fixes from the review of revision 2. Revision 4 adds the fixes from the review of revision 3: the queue contract, the bulk tag rules, the connection guard for write-through, and the revoked-authorization rule. The architecture does not change. The review loop of PR 3 added the rules for a new connection (see "PR 3 as built").

## Status

| PR | Content | State |
|---|---|---|
| 1 ([#88](https://github.com/AdarBahar/raindrop-app/pull/88)) | Queue contract, migration 003, store functions | Merged, `f4b5fd5` |
| 2 ([#89](https://github.com/AdarBahar/raindrop-app/pull/89)) | Full sync engine, journal, live API check | Merged, `2a6228d` |
| 3 ([#90](https://github.com/AdarBahar/raindrop-app/pull/90)) | Reads, write-through and route changes, behind `BOOKMARK_STORE` | Merged, `9982de4` |
| 4 ([#92](https://github.com/AdarBahar/raindrop-app/pull/92)) | Timer, persistent retries, orphan sweep, revoke path, monitoring | Merged, `55df267` |

- The flag `BOOKMARK_STORE` is off by default. No PR changed production.
- Do not turn the flag on in production before decision D6 is resolved. Deploy a release that has PR 4 first. The timer of PR 4 then refreshes the copy. A production check with one test user must follow (section 11).

## 1. Problem

The backend keeps the bookmarks of each user in memory (`loadAll` in `app/backend/src/library.js`).
The cache lasts 5 minutes (`cacheMs`). A restart or a deploy erases it.
Each load makes one Raindrop call for each 50 bookmarks. A page load can wait for about 100 calls.

## 2. Goal and limits

- The page opens from a copy in PostgreSQL. A normal page load makes no Raindrop call.
- A full sync keeps the copy equal to Raindrop. Raindrop stays the source of truth.
- A change made in another Raindrop interface appears after the next full sync or after the user selects "Refresh". The owner accepts up to 24 hours (decision D2).
- The design is for fewer than 5,000 bookmarks for each user and one backend instance.
- The expected number of connected users is below 50. The gateway group has two members today.

Not in scope: delta sync, SQL filters, offline edits, a second writer, a new "New" label logic.

## 3. Rules

- Every change goes to Raindrop first. The database copy follows.
- The runtime role cannot create tables. The admin role runs the migration.
- Every table has a `user_id` column. `deleteUserData` removes the rows of the new tables.
- The migration only adds. A rollback keeps the new schema.
- **Queue contract.** The code has two queues for each user:
  - Q1 is `serialize(userId, …)` in `util.js`. Routes and bulk jobs use it for data writes. It is not reentrant. A call inside a Q1 turn that waits for Q1 never ends.
  - Q2 is `locked(userId, …)` in `oauth.js`. It is private and serves token work only.
- The owner of a queue turn is the operation, not the store. These rules apply:
  1. A store function never takes Q1 or Q2. It runs in the turn of its caller.
  2. Only the sync commit (`syncNow`) and the routes take Q1. They take it at the operation boundary.
  3. Code inside a Q1 turn never calls `syncNow` and never waits for a sync. Inside a turn, `loadAll` only reads the database. If the user has no snapshot, it returns the error 409 "Not synced yet".
  4. The order of locks is Q1, then Q2. Never take Q1 while the code holds Q2.
  5. A route that needs data calls `ensureSnapshot` before it takes Q1. `ensureSnapshot` runs the first sync, outside Q1, if the user has no snapshot.
- A regression test fails when code takes Q1 inside a Q1 turn (section 9).

## 4. Schema (migration `003_bookmark_store.sql`)

The default privileges in `001_init.sql` give the runtime role rights on the new tables.

The `raw` column holds the complete Raindrop object. `loadAll` builds its items from `raw` only.
The typed columns exist for later SQL filters and for checks. This keeps the item shape the same as today.
It avoids two known problems: the `pg` driver returns `BIGINT` as a string, and it returns `TIMESTAMPTZ` as a `Date`.

### Table `collections`

| Column | Type | Note |
|---|---|---|
| `user_id` | TEXT | Primary key, part 1 |
| `id` | BIGINT | Raindrop collection ID. Primary key, part 2. `-1` is Unsorted. |
| `title` | TEXT | |
| `raw` | JSONB | The complete collection object, with `count`, `sort`, `color` and the other fields |

### Table `bookmarks`

| Column | Type | Note |
|---|---|---|
| `user_id` | TEXT | Primary key, part 1 |
| `raindrop_id` | BIGINT | Primary key, part 2 |
| `collection_id` | BIGINT | Folder of the bookmark. `-1` is Unsorted. |
| `created` | TIMESTAMPTZ | |
| `raw` | JSONB | The complete Raindrop item, with `_id` and `collection.$id` |

Index: `(user_id, created DESC)`. Add other indexes only when a query needs them.

### Table `sync_state`

| Column | Type | Note |
|---|---|---|
| `user_id` | TEXT | Primary key |
| `last_full_at` | TIMESTAMPTZ | Time of the last successful full sync. Null means the user never synced. |
| `last_attempt_at` | TIMESTAMPTZ | Time of the last try, successful or not |
| `last_error` | TEXT | Short text of the last failure. Null after a success. |
| `consecutive_failures` | INTEGER | Failures since the last success. Zero after a success. |
| `next_retry_at` | TIMESTAMPTZ | Earliest time of the next try. Null when no retry is waiting. |

A library that synced and has 0 bookmarks has a `last_full_at` value. A library that never synced has none.
Whether a sync runs now is kept in memory, not in the table. After a restart, the timer reads `next_retry_at` and `consecutive_failures`.

## 5. Full sync

The sync has a fetch part and a commit part. Only the commit part uses the user queue.

### 5.1 Fetch (no queue, no database lock)

1. Read the connection generation `gen` with `generation(svc, userId)`. Do this before the first await. Record `started_at` and open a journal for this sync (section 5.4).
2. Read the remote count from `/user/stats` (ID `0`).
3. Read `/collections` and `/collections/childrens`.
4. Read `/raindrops/0?perpage=50&page=N` until a page has fewer than 50 items. Use `raindropCall`, which paces the calls and retries a 429.
5. Read the remote count again.
6. Check the snapshot (section 5.2). If a check fails, retry the fetch. Make at most 3 tries.
7. If all tries fail, keep the old rows. Record the failure (section 7). Stop.

### 5.2 Checks before the commit

The snapshot must pass all checks. A failed check never causes a commit.

| Check | Action on failure |
|---|---|
| The IDs of the fetched items are unique | Retry |
| The number of unique fetched IDs equals the remote count | Retry |
| The count before the fetch equals the count after the fetch | Retry |
| The snapshot is empty and the copy has rows | See the empty-library rule below |

After 3 failed tries, keep the old rows and record the error. A real API difference, such as a count that excludes some items, shows as a repeated failure.
Do not add an exception for it now. PR 2 tests the check against a live account. An exception needs an observed case and a test.

**Empty-library rule.** If the snapshot has 0 items and the copy has rows, do not delete anything yet.
Wait 60 seconds. Run the fetch again, with a new `/user/stats` read and a new first page. Commit the empty snapshot only if both fetches return 0 items and a count of 0.
Otherwise keep the old rows and record the error.

### 5.3 Commit (user queue, one short transaction)

1. Take Q1. `syncNow` does this at the operation boundary. The caller of `syncNow` must not hold Q1 (section 3).
2. Check `generation(svc, userId) === gen`. If it is not equal, the user disconnected or connected again. Discard the snapshot. Do not write. Stop.
3. Start a transaction. Upsert the collections and the bookmarks, with the complete object in `raw`.
4. Delete the rows that are not in the snapshot: `DELETE ... WHERE user_id = $1 AND raindrop_id <> ALL($2)`. Do the same for the collections.
5. Apply the journal of this sync in order (section 5.4).
6. Set `last_full_at` and `last_attempt_at`. Set `last_error` and `next_retry_at` to null. Set `consecutive_failures` to 0. Commit.
7. Drop the memory cache of the user. Close the journal.

If the transaction fails, it rolls back. The old rows stay.
The disconnect operation deletes the rows in the same user queue and changes the generation. It runs before or after the commit, never during it.
So a snapshot cannot restore data after a disconnect. A different Raindrop account after a reconnect has a different generation.

### 5.4 Mutations during a sync (the journal)

A user can change a bookmark while the fetch runs. The snapshot then holds the old version.
The journal is a list in memory, for each running sync. It is ordered. It needs no storage and no lock between instances.

Rules:

1. A mutation is captured after Raindrop accepted it. The capture does not depend on the database write. If the database write fails, the entry stays in the journal. Every accepted mutation after `started_at` is captured. The journal takes an entry only when the connection generation of the change equals the generation of the running sync. A change that an old connection made must not enter the sync of a new connection. This includes creates, updates, moves, deletes and bulk actions (section 6).
2. Each journal entry holds the effect: the full item (create, update), the ID (delete), or the IDs with an operation (bulk move, bulk add tags). Every operation is idempotent: a move sets the folder, and add tags merges a set. A replay and a later database write give the same result. A tag is never added twice.
3. The commit applies the entries in the order of capture, after the snapshot rows, in the same transaction.
4. A mutation that finishes while the commit runs waits for the user queue. Its own database write then runs after the commit. The write is safe to repeat.
5. A later entry for the same bookmark wins over an earlier one. An update followed by a delete leaves the bookmark deleted.

## 6. Write-through

Each mutation follows these steps:

1. Read the generation `gen` with `generation(svc, userId)` before the Raindrop call.
2. Call Raindrop. If the call fails, stop.
3. Add the effect to the journal of a running sync.
4. In the Q1 turn of the operation, check `generation(svc, userId) === gen`. If it is not equal, the user disconnected. Skip the database write. The Raindrop change stays.
5. Write the effect to the database, and drop the memory cache.

Every route that writes must run in a Q1 turn. The route `/api/folder` has no turn today. PR 3 adds one.
The raw column and the typed columns change in the same transaction.

| Action | Raindrop call in the code | Database effect |
|---|---|---|
| Save one bookmark (`save`, `apply`, `removeTags`, undo of one bookmark) | `PUT /raindrop/:id`. A single update replaces the tags. | Store the item from the response |
| Create a folder | `POST /collection` | Store the collection from the response |
| Bulk move to a folder | `PUT /raindrops/0` with `ids` and `collection` | Set `collection.$id` and `collection_id` of each ID. The response has no items. |
| Bulk add tags (`addTags`) | `PUT /raindrops/0` with `ids` and `tags`. Raindrop appends the tags to the existing tags. | Merge the sent tags into the tags of each ID. Use `cleanTags` and the same limit as `bulk.js`. Do not replace. |
| Bulk delete | Not used by the app today | If it is added, remove the rows by ID |

The `removeTags` action sends single updates, so it is not a bulk patch. An empty tag list in a bulk call removes all tags in Raindrop. The app does not send it.

The Raindrop documentation says that bulk update and delete are not supported for collection ID 0. The app already uses `PUT /raindrops/0`.

**Live test result, 2026-11-09** (`scripts/live-api-check.mjs`, test account, 32 calls):

- `PUT /raindrops/0` with `ids` and `collection` works. It answers `matched: 3, modified: 3`. It moves all bookmarks and changes `lastUpdate`.
- `PUT /raindrops/0` with `ids` and `tags` **appends** the tags. It does not replace them. A repeated call changes nothing. The `addTags` effect (merge) is correct.
- `PUT /raindrop/:id` with `tags` replaces the tags and returns the item.
- The bulk calls return no items, so the database must apply the change itself, as this section says.
- The `/user/stats` count for ID `0` equals the number of bookmarks that `/raindrops/0` lists. It falls by 1 after a delete to Trash, and the trashed bookmark is not in the list.
- `sort=-lastUpdate` works on `/raindrops/0`, although the documentation does not list it. The first item was the one changed last. This is only for the deferred delta sync (section 10). The first version does not use it.

**Failed database write.** A successful Raindrop save is never reported as failed because of a database error.
Retry the write 3 times, with a short wait between tries.
If it still fails, set `next_retry_at` to 1 minute from now and write the error to `last_error`. The timer then starts a full sync. The page shows that the data can be old.
The database can be the cause of the failure, so the write of `next_retry_at` can fail too. Then write the error to the log and keep a dirty flag in memory. The timer reads the flag, so it needs no database to start the retry.
The failure handler of a sync writes `sync_state` only after the same generation check as a commit. A failed old sync must not create a state row after a disconnect.

## 7. When the sync runs

| Event | Action |
|---|---|
| First visit, no `last_full_at` | Full sync. The page shows the progress counter. |
| Normal page load | Read the database. No Raindrop call. |
| The user selects "Refresh" | Full sync, with the progress counter |
| The user selects "Check for new bookmarks" | Full sync. Then run the existing `pull` logic on the stored rows. The `known_items` and `new_items` behavior stays as it is. |
| Timer: `last_full_at` is older than 20 hours | Full sync in the background |
| A sync fails | Keep the old rows. Add 1 to `consecutive_failures`. Set `last_error`. Set `next_retry_at` after 1 hour, then 2, then 4, with a limit of 6 hours. |
| Token refresh fails for a short time (network error, or an error 5xx) | Not a disconnect. Keep the rows. The sync fails and follows the retry rule. |
| The user disconnects Raindrop (`/api/disconnect`) | First change the generation (`disconnect`). Then cancel the running sync and the bulk jobs of the user (`forgetJobs`). Then, in a Q1 turn, delete the bookmarks, the collections and the sync state. |
| Raindrop revokes the authorization (a refresh gives the error 400 or 401, and `oauth.js` deletes the tokens) | Same as a disconnect. See decision D8. `oauth.js` runs this path inside Q2, so it must not take Q1. After it leaves Q2, it starts the Q1 delete as a separate step. |
| The timer finds rows of a user who has no tokens | Delete them in a Q1 turn. This catches a crash between the two steps above. |
| The server restarts | The timer runs one check at startup. It reads `next_retry_at` and `consecutive_failures`. A sync that was running is lost, and the next check starts it again. |

The timer runs in the Node.js process. It checks every 15 minutes. It picks the connected users who are due, or whose `next_retry_at` has passed. A connected user has a row in `raindrop_tokens`.
It syncs one user at a time, with a small random delay between users.
Capacity: a full sync of 5,000 bookmarks takes 2 to 4 minutes. In 20 hours, one user at a time can sync about 300 users. The expected number is below 50. Use two users at a time if the number grows.

The page shows "Synced N hours ago". If the last attempt failed, it also shows that the data can be old.
When `consecutive_failures` reaches 3, write an error to the log. Add a notification later if needed.

Monitoring: write one log line for each sync with the user, the duration, the number of bookmarks and the result. Write a log line each hour with the number of connected users, the age of the oldest successful sync, and the number of users with repeated failures. Add the age of the last sync to `/api/me`.

## 8. Code changes

- `store.js`: add `loadBookmarks`, `commitSnapshot`, `upsertBookmark`, `patchBookmarks`, `getSyncState` and `setSyncState`. Add the new tables to `deleteUserData`.
- New `src/sync.js`: `fullSync` (fetch, checks, commit), the journal, and the timer.
- `bookmarks.js`: `loadAll` builds the memory object from `raw`. The shape stays the same: `items`, `collections`, `progress`. The `collections` map must keep the synthetic entry `-1 => 'Unsorted'`. Raindrop does not return it, so the store does not hold it, and `loadAll` adds it, as the present code does. When the user has no snapshot, `loadAll` starts a full sync and waits for it.
- `pull` and the route `/api/pull`: today the route holds a Q1 turn and `pull` loads from Raindrop inside it. Change the route. Run `syncNow` first, outside Q1. Then take Q1 for the `known_items` and `new_items` update and for `setLastChecked`. `pull` reads the stored rows inside the turn. The rest of its logic stays.
- `save`, `createFolder` and `bulk.js`: write-through (section 6). They write inside the Q1 turn that they already have. `/api/folder` gets a Q1 turn.
- `/api/disconnect`, the revoke path in `oauth.js` and `/api/delete-data` delete the new rows and cancel a running sync, as in section 7. `/api/disconnect` also calls `forgetJobs`.
- Routes that need data call `ensureSnapshot` before Q1 (section 3).
- A config flag `BOOKMARK_STORE=off` makes `loadAll` use the old load. Keep the flag until the feature is stable.

## 9. Tests

Use a fake Raindrop client and the test schema from `test/helpers`.

**Round trip.** Use a real Raindrop API fixture, with collections and bookmarks. Store it. Load it. The loaded objects must equal the original objects. Check `_id`, `collection.$id`, the dates and the collection fields `count`, `sort`, `view` and `color`.

**Sync checks.**

- A full sync stores all pages and the collections.
- A second sync updates an edited bookmark and deletes a bookmark that is no longer in Raindrop.
- A failure at any page keeps the old rows and records the error.
- A duplicate ID, a fetched count above the remote count, a fetched count below it, and a changed count each cause a retry and then no commit.
- An empty answer for a populated library needs a second confirmation before a delete.
- A snapshot with more than 1,000 bookmarks fails in a later batch of the commit. The whole transaction rolls back, and the old rows stay. The store functions commit each batch alone when they run outside `store.transaction`, so the commit must always use the transaction.
- A rate limit (429) retries and does not cause a partial commit.
- Two concurrent callers share one sync.

**Queues.**

- A regression test fails when code takes Q1 inside a Q1 turn. Wrap `serialize` in the test to detect a nested call.
- `/api/pull` with a user who has no snapshot finishes with no deadlock.
- A `save` and a bulk folder step finish when the user has a snapshot. With no snapshot, they return the error 409.
- A sync commit and a `save` of the same user run one after the other, in both orders.

**Ordering and disconnect.**

- A write-through whose database write fails still adds its entry to the journal. An overlapping sync does not overwrite the change.
- A replay of a bulk add tags entry, and a later database write of the same entry, add each tag once.
- A folder creation that finishes after a disconnect does not create a row.
- A failed old sync does not create a `sync_state` row after a disconnect.
- A disconnect cancels the bulk jobs of the user.
- A revoked authorization (a refresh error 400) deletes the stored rows and starts no deadlock.

- A save during the fetch is not lost at the commit.
- Two saves of the same bookmark during a sync: the last successful save is the final value.
- A bookmark that is deleted during a sync stays deleted.
- A bulk folder move during a sync: all affected bookmarks keep the new folder.
- A write that finishes during the commit runs after the commit.
- A disconnect, then a reconnect with another account, while the old sync runs: the old snapshot is discarded.
- A disconnect while the sync waits for the queue: no rows come back.
- A short token refresh failure keeps the rows.

**Recovery and compatibility.**

- A restart after two failed attempts keeps the failure count and the retry time.
- A failed database write after a Raindrop save: the save succeeds, `next_retry_at` is set, and a sync follows.
- "Check for new bookmarks" keeps the `known_items` and `new_items` behavior.
- The timer picks only the connected users who are due. It runs at startup.
- `deleteUserData` removes the new rows. Two users never see the rows of each other.
- Update `data-retention.test.js` for the new tables.

Measure before the rollout: the time of a full sync of 5,000 bookmarks, and the delay of a save during that sync.

## 10. Deferred: delta sync

The first version has no delta sync, no watermark and no Trash scan. Reasons:

- At fewer than 5,000 bookmarks, a full sync of about 100 calls fits the Raindrop limit as a daily background job.
- The Raindrop documentation does not list `-lastUpdate` as a sort value for the bookmark list. A delta design depends on it.
- A delta sync must also find permanent deletes and prove that the watermark never skips an update.

Build a delta sync only if the owner needs changes to appear in minutes. First test these points with a live account:

1. `sort=-lastUpdate` works for `/raindrops/0`, and `lastUpdate` is in each item.
2. A move to another folder and a restore from Trash change `lastUpdate`.
3. A move to Trash removes the item from `/raindrops/0`.

## 11. Rollout

| PR | Content |
|---|---|
| 1 | The queue contract (section 3) and its regression test. Migration 003 with the `raw` columns and the retry fields. The store functions, which take no queue. The round-trip test. The permission and user isolation tests. |
| 2 | First, the live test of `PUT /raindrops/0` for a move and for add tags. The script is `app/backend/scripts/live-api-check.mjs`. The owner ran it on 2026-11-09. The result is in section 6, and the real objects are in `test/fixtures/raindrop-live-sample.json`. Then the full sync engine in `src/sync.js`: fetch, strict checks, empty-library rule, commit, the journal, the generation check, and their tests. `sync.js` is not connected to the routes. The shared effect functions (`applyEffect`, `recordEffect`) are for the journal and for the write-through in PR 3. |
| 3 | Database reads, `ensureSnapshot`, the route changes for `/api/pull`, `/api/folder` and `/api/disconnect`, write-through for each action in section 6, recovery from a failed write, `pull` compatibility, `synced_at` in the UI, and the config flag. |
| 4 | The timer, persistent retries, the orphan sweep, the revoke path, monitoring, cleanup, and the production check. |

### PR 3 as built

- **The flag.** `BOOKMARK_STORE=on` turns the stored copy on. The default is `off`: the app loads from Raindrop, as before, and the answers of the API do not change. Turn the flag on only after D6 is resolved. Start with the flag on for the test setup only.
- **Reads.** `loadAll` reads the database. It never calls Raindrop and never starts a sync, so it is safe inside a queue turn. A user with no copy gets the error 409 there. `ensureSnapshot` runs the first sync before the queue turn. The routes `/api/progress`, `/api/pull` and `/api/bulk/<id>` do not call it: the loading bar polls the progress route during the first sync, `/api/pull` has its own sync step, and job status reads memory.
- **Memory cache.** The change is different from the text in section 6, and it is cheaper. A write-through does not drop the memory cache. The code that makes the change already updates the cached object in place, and the write-through writes the same change to the database, so both stay equal. A snapshot commit raises a version number, and the next `loadAll` reads the database again. A disconnect drops the cache, as before.
- **Routes.** `/api/pull` runs `syncNow` outside the queue, then takes the queue for `pull`. `/api/folder` has a queue turn. `/api/disconnect` changes the generation, drops the jobs, cancels a running sync, and deletes the stored rows in a queue turn. `/api/delete-data` also cancels a running sync. The OAuth callback deletes the stored rows after a new connection, so rows of an earlier connection never show for another Raindrop account.
- **New connection (added in the review of PR 3).** The OAuth callback runs in one queue turn: it checks the generation, deletes the stored rows of the old connection, checks the generation again, calls `connect()`, and drops the memory cache. A disconnect during the delete cancels the new connection (the callback answers 409). While the turn runs, the user is marked as changing (`beginConnectionChange`), and `syncNow` and `ensureSnapshot` refuse to start (409). `connect()` changes the generation before it saves the tokens. Without the mark, a sync could get the new generation and use the tokens of the old account.
- **Journal and generation.** `recordEffect` takes the generation that the caller read before the Raindrop call. The running sync keeps the entry only when the generations are equal.
- **`/api/me`** has `syncedAt` and `syncError` when the flag is on. With the flag off, the answer has the same fields as before.
- **Not in PR 3: the text in the page.** The footer of the page does not show "Synced N hours ago" yet. `docs/ui-elements.md` is the specification of the page, and a new text needs a new item there. The item is now in `docs/ui-elements.md`, section 6.2 (Proposed), with decision point 20. The text is built (PR #96, `87ff179`). It shows only when the flag is on. The owner confirmed the wording by the merge on 2026-11-10 (decision point 20 of the specification is resolved).
- **Not in PR 3: the revoke path and the orphan sweep.** These stay in PR 4, with the timer. The new-connection delete above covers the risk that rows of a revoked connection show for another account.

### PR 4 as built

- **The timer.** `startSyncTimer` in `src/sync-timer.js` starts at server start, and only when `BOOKMARK_STORE=on`. It runs at once and then every 15 minutes (`config.sync.timerMs`). One run syncs the due users one at a time, with a random wait of up to 5 seconds between users. Runs do not overlap.
- **Who is due (`isDue`).** A user with a dirty flag in memory is due. A retry time rules: a failed user waits for it, even when the copy is old, and is due after it. Without a retry time, a user with a copy is due when the copy is 20 hours old (`config.sync.staleMs`). A connected user with no copy is not due. The first visit makes the first sync. A user whose connection is changing is skipped.
- **Persistent retries.** The retry state is in `sync_state`, so a restart keeps the failure count and the retry time. The in-memory dirty flag covers a database failure. If the failure handler cannot write the state, it sets the dirty flag, and the next run tries again. The list of users can also fail. Then the timer still syncs the dirty users.
- **Revoked authorization.** When a refresh gives 400 or 401, `oauth.js` deletes the tokens inside Q2 and changes the generation. After it leaves Q2, it calls `svc.onRevoked` through `outsideTurns()` (`util.js`). That function runs the call without the queue keys of the caller. The caller can be inside a turn of the same user, and the call must not fail or wait for it. The handler in `server.js` drops the memory cache and the jobs, cancels the running sync, and starts a Q1 turn for the delete. The turn looks at the tokens again. If the user connected again, the rows stay, because the OAuth callback already made a new copy.
- **Orphan sweep.** Each timer run lists the users who have stored rows and no tokens, and deletes the rows in a Q1 turn. The turn looks at the tokens and at the connection mark again. It catches a crash between the token delete and the row delete.
- **Monitoring.** Each sync writes one log line (`sync user=… duration=…ms result=…`). The line is on only when `svc.logSyncs` is true (`index.js` sets it), so the tests stay quiet. Each hour a summary line has the number of connected users, the age in hours of the oldest successful sync, and the number of users with 3 or more failures in a row. The third failure in a row writes an error line.
- **Still open.** The look of the footer text "Synced N hours ago" in a real browser (the text is built in PR #96, and the wording is confirmed), decision D6, and the production check. The check includes the live rate limit headers and the time of a full sync.

The owner approves each merge. Start with one test user. Check the live rate limit headers during the PR 4 check.
Rollback: set `BOOKMARK_STORE=off` and reload PM2. The tables stay and cost nothing.

## 12. Risks

- **Old data.** Changes from other interfaces can take up to 24 hours. The page shows the age of the data, and "Refresh" is always available.
- **Strict count check.** If Raindrop reports a count that never matches the items, the sync fails for that user. The old rows stay and the page shows an error. This is the safe direction. PR 2 tests it with a live account.
- **Long sync.** A full sync of 5,000 bookmarks needs at least 50 seconds at the limit of 120 calls each minute. The progress counter shows this to the user.
- **Privacy and backups.** The database holds the titles, notes and links of each user. The nightly R2 backup of the cluster holds them too. A backup can keep the data after the user disconnects. The privacy statement must say this.
- **Size.** About 1 KB for each bookmark. 5,000 bookmarks use about 5 MB for each user.
- **Not a true snapshot.** Raindrop does not document a point-in-time read. The count checks lower the risk. They cannot remove the risk.
- **Long API outage.** The 24-hour limit cannot hold during an outage. The page shows the age of the data and the error.

## 13. Decisions

| ID | Decision | State |
|---|---|---|
| D1 | `TIMESTAMPTZ` in the new tables | Accepted |
| D2 | Changes from other interfaces can take up to 24 hours | Decided by the owner on 2026-11-09 |
| D3 | Delete the stored database rows at once when the user disconnects. Copies in the existing backups stay until they expire. A short token failure is not a disconnect. | Accepted by the owner on 2026-11-09 |
| D8 | Treat a revoked authorization like a disconnect. Delete the rows. A reconnect then needs one full sync, about 1 to 4 minutes. The alternative is to keep the rows for a limited time, which needs a purge job. | Accepted by the owner on 2026-11-09 |
| D4 | Sync all connected users each day, one at a time | Accepted. PR 4 does it: the timer syncs a user whose copy is 20 hours old, one user at a time. |
| D5 | Keep the memory object for now | Accepted |
| D6 | The privacy statement covers stored titles, notes and links, and the backup retention after a disconnect | Open. The owner must resolve it before the flag is turned on in production. |
| D7 | Expected connected users: below 50 | Assumed. The gateway group has two members. |
