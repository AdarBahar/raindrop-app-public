// The stored copy of the bookmarks and folders, and the sync state. See src/store.js.

// An ISO time from a database time. A missing time stays null. Other times in the app are ISO text.
const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

// Rows go to the database in groups of this size, so one statement stays small.
const BATCH_SIZE = 1000;

function requireId(value, what) {
  if (!Number.isSafeInteger(value)) throw new Error(`A Raindrop ${what} has no valid _id.`);
}

// The stored copy of the bookmarks and folders (migration 003) and the sync state.
// Nothing here takes a queue. The caller owns the queue turn (docs/bookmark-store-plan.md, section 3).
// q runs one query. inTx(fn) runs fn(q2) in a transaction. Inside a transaction it only runs fn(q).
export function storeOps(q, inTx) {
  // The typed columns come from the object itself, so they cannot differ from raw.
  async function upsertBookmarks(userId, items) {
    for (const item of items) requireId(item?._id, 'bookmark');
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      await q(
        `INSERT INTO bookmarks (user_id, raindrop_id, collection_id, created, raw)
         SELECT $1, (x->>'_id')::bigint, (x->'collection'->>'$id')::bigint, (x->>'created')::timestamptz, x
         FROM jsonb_array_elements($2::jsonb) AS x
         ON CONFLICT (user_id, raindrop_id) DO UPDATE SET
           collection_id = EXCLUDED.collection_id,
           created = EXCLUDED.created,
           raw = EXCLUDED.raw`,
        [userId, JSON.stringify(items.slice(i, i + BATCH_SIZE))],
      );
    }
  }

  return {
    // The stored bookmarks as the objects that Raindrop returned. Newest first.
    async loadBookmarks(userId) {
      const { rows } = await q(
        'SELECT raw FROM bookmarks WHERE user_id = $1 ORDER BY created DESC NULLS LAST, raindrop_id DESC',
        [userId],
      );
      return rows.map((r) => r.raw);
    },

    // The stored folders as the objects that Raindrop returned.
    async loadCollections(userId) {
      const { rows } = await q('SELECT raw FROM collections WHERE user_id = $1 ORDER BY id', [userId]);
      return rows.map((r) => r.raw);
    },

    // The number of stored bookmarks of one user.
    async countBookmarks(userId) {
      const { rows } = await q('SELECT count(*)::int AS n FROM bookmarks WHERE user_id = $1', [userId]);
      return rows[0].n;
    },

    upsertBookmarks,

    async upsertBookmark(userId, item) {
      await upsertBookmarks(userId, [item]);
    },

    async upsertCollections(userId, collections) {
      for (const col of collections) requireId(col?._id, 'folder');
      for (let i = 0; i < collections.length; i += BATCH_SIZE) {
        await q(
          `INSERT INTO collections (user_id, id, title, raw)
           SELECT $1, (x->>'_id')::bigint, COALESCE(x->>'title', ''), x
           FROM jsonb_array_elements($2::jsonb) AS x
           ON CONFLICT (user_id, id) DO UPDATE SET title = EXCLUDED.title, raw = EXCLUDED.raw`,
          [userId, JSON.stringify(collections.slice(i, i + BATCH_SIZE))],
        );
      }
    },

    async deleteBookmarks(userId, ids) {
      const res = await q('DELETE FROM bookmarks WHERE user_id = $1 AND raindrop_id = ANY($2::bigint[])', [userId, ids]);
      return res.rowCount;
    },

    // Delete the bookmarks that are not in the list. An empty list deletes all of them, so the caller
    // must check the snapshot first. Returns the number of rows removed.
    async deleteBookmarksNotIn(userId, ids) {
      const res = await q('DELETE FROM bookmarks WHERE user_id = $1 AND raindrop_id <> ALL($2::bigint[])', [userId, ids]);
      return res.rowCount;
    },

    async deleteCollectionsNotIn(userId, ids) {
      const res = await q('DELETE FROM collections WHERE user_id = $1 AND id <> ALL($2::bigint[])', [userId, ids]);
      return res.rowCount;
    },

    // Change stored bookmarks. patch(raw) returns the new object, or null when nothing changes.
    // The patch must give the same result when it runs twice, and it must keep the _id.
    // Rows that do not exist are skipped. Returns the number of bookmarks that changed.
    async updateBookmarks(userId, ids, patch) {
      return inTx(async (q2) => {
        const { rows } = await q2(
          `SELECT raw FROM bookmarks WHERE user_id = $1 AND raindrop_id = ANY($2::bigint[])
           ORDER BY raindrop_id FOR UPDATE`,
          [userId, ids],
        );
        const changed = [];
        for (const { raw } of rows) {
          const next = patch(structuredClone(raw));
          if (!next) continue;
          // The update below finds each row by the _id of the new object. A patch must never change it.
          // The error rolls the transaction back, so no row changes.
          if (next._id !== raw._id) throw new Error(`The patch changed the _id of bookmark ${raw._id}.`);
          changed.push(next);
        }
        for (let i = 0; i < changed.length; i += BATCH_SIZE) {
          await q2(
            `UPDATE bookmarks AS b SET
               collection_id = (x->'collection'->>'$id')::bigint,
               created = (x->>'created')::timestamptz,
               raw = x
             FROM jsonb_array_elements($2::jsonb) AS x
             WHERE b.user_id = $1 AND b.raindrop_id = (x->>'_id')::bigint`,
            [userId, JSON.stringify(changed.slice(i, i + BATCH_SIZE))],
          );
        }
        return changed.length;
      });
    },

    // The sync state of one user, or null when the user never started a sync.
    async getSyncState(userId) {
      const { rows } = await q(
        `SELECT last_full_at, last_attempt_at, last_error, consecutive_failures, next_retry_at
         FROM sync_state WHERE user_id = $1`,
        [userId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        lastFullAt: isoOrNull(row.last_full_at),
        lastAttemptAt: isoOrNull(row.last_attempt_at),
        lastError: row.last_error,
        consecutiveFailures: row.consecutive_failures,
        nextRetryAt: isoOrNull(row.next_retry_at),
      };
    },

    async recordSyncSuccess(userId, nowIso) {
      await q(
        `INSERT INTO sync_state (user_id, last_full_at, last_attempt_at, consecutive_failures)
         VALUES ($1, $2, $2, 0)
         ON CONFLICT (user_id) DO UPDATE SET
           last_full_at = EXCLUDED.last_full_at,
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_error = NULL,
           consecutive_failures = 0,
           next_retry_at = NULL`,
        [userId, nowIso],
      );
    },

    async recordSyncFailure(userId, nowIso, error, nextRetryIso) {
      await q(
        `INSERT INTO sync_state (user_id, last_attempt_at, last_error, consecutive_failures, next_retry_at)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_error = EXCLUDED.last_error,
           consecutive_failures = sync_state.consecutive_failures + 1,
           next_retry_at = EXCLUDED.next_retry_at`,
        [userId, nowIso, String(error).slice(0, 500), nextRetryIso],
      );
    },

    // Ask for a sync soon, with no failed sync. For example after a failed database write.
    async setRetry(userId, error, nextRetryIso) {
      await q(
        `INSERT INTO sync_state (user_id, last_error, next_retry_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET last_error = EXCLUDED.last_error, next_retry_at = EXCLUDED.next_retry_at`,
        [userId, String(error).slice(0, 500), nextRetryIso],
      );
    },

    // The connected users (a row in raindrop_tokens) with their sync state. The oldest copy is first.
    async listSyncUsers() {
      const { rows } = await q(
        `SELECT t.user_id, s.last_full_at, s.next_retry_at, s.consecutive_failures
         FROM raindrop_tokens t LEFT JOIN sync_state s ON s.user_id = t.user_id
         ORDER BY s.last_full_at NULLS FIRST, t.user_id`,
      );
      return rows.map((row) => ({
        userId: row.user_id,
        lastFullAt: isoOrNull(row.last_full_at),
        nextRetryAt: isoOrNull(row.next_retry_at),
        consecutiveFailures: row.consecutive_failures ?? 0,
      }));
    },

    // The users who have stored rows but no tokens. A crash between the token delete and the row delete
    // (or a revoked authorization) leaves such rows.
    async listStoreOrphans() {
      const { rows } = await q(
        `SELECT u.user_id FROM (
           SELECT DISTINCT user_id FROM bookmarks
           UNION SELECT user_id FROM collections
           UNION SELECT user_id FROM sync_state
         ) u
         WHERE NOT EXISTS (SELECT 1 FROM raindrop_tokens t WHERE t.user_id = u.user_id)
         ORDER BY u.user_id`,
      );
      return rows.map((row) => row.user_id);
    },

    // Delete the stored bookmarks, folders and sync state of one user, for example after a disconnect.
    async deleteBookmarkStore(userId) {
      await inTx(async (q2) => {
        for (const table of STORE_TABLES) await q2(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      });
    },
  };
}

// The tables of the stored copy. Each one has a user_id column.
export const STORE_TABLES = ['bookmarks', 'collections', 'sync_state'];
