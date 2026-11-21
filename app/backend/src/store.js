import pg from 'pg';
import { STORE_TABLES, storeOps } from './store-bookmarks.js';

// Data access for all users. The database holds the tables from migrations/.
// Every table except users has a user_id column.

// openStore({ url, schema }): url is a PostgreSQL connection string for the runtime role.
// schema is optional. Tests use it to keep each test run apart. It must be a plain name.
export function openStore({ url, schema = '' }) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid schema name.');
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // A request that waits longer than this for a free connection fails.
    connectionTimeoutMillis: 5000,
    options: schema ? `-c search_path=${schema}` : undefined,
  });
  pool.on('error', (err) => console.error('Database pool error:', err.message));
  return createStore(pool);
}

// The oldest change-log time that is kept, as ISO text. Times are stored as ISO text, so they sort as text.
export function retentionCutoff(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

const ids = (rows, col = 'raindrop_id') => new Set(rows.map((r) => Number(r[col])));

const PROFILE_COLUMNS = 'id, kind, name, description, tag, active, source, source_ref, updated_at';
const profileRow = (r) => ({
  id: String(r.id),
  kind: r.kind,
  name: r.name,
  description: r.description,
  tag: r.tag,
  active: r.active,
  source: r.source,
  sourceRef: r.source_ref,
  updatedAt: r.updated_at,
});

function createStore(pool) {
  const run = (sql, params) => pool.query(sql, params);
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;

  // Run a function inside one transaction on a single connection.
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // The stored-copy functions on the pool, and on one connection inside a transaction.
  const poolOps = storeOps(
    (sql, params) => pool.query(sql, params),
    (fn) => inTransaction((client) => fn((sql, params) => client.query(sql, params))),
  );

  return {
    ...poolOps,

    // Run fn(ops) in one transaction. ops has the stored-copy functions, bound to the transaction.
    // The caller owns the queue turn. Do not take a queue inside fn.
    transaction(fn) {
      return inTransaction((client) => {
        const q = (sql, params) => client.query(sql, params);
        return fn(storeOps(q, (inner) => inner(q)));
      });
    },

    async ensureUser(id) {
      await run(
        'INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [id, new Date().toISOString()],
      );
    },

    async hasBaseline(id) {
      return Boolean((await one('SELECT baseline FROM users WHERE id = $1', [id]))?.baseline);
    },

    async getTokens(id) {
      const row = await one(
        'SELECT access_enc, refresh_enc, expires_at FROM raindrop_tokens WHERE user_id = $1',
        [id],
      );
      return row ? { ...row, expires_at: Number(row.expires_at) } : null;
    },

    async saveTokens(id, accessEnc, refreshEnc, expiresAt) {
      await run(
        `INSERT INTO raindrop_tokens (user_id, access_enc, refresh_enc, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           access_enc = EXCLUDED.access_enc,
           refresh_enc = EXCLUDED.refresh_enc,
           expires_at = EXCLUDED.expires_at`,
        [id, accessEnc, refreshEnc, expiresAt],
      );
    },

    async deleteTokens(id) {
      await run('DELETE FROM raindrop_tokens WHERE user_id = $1', [id]);
    },

    // Map of raindrop_id to { count, last }.
    async visits(id) {
      const { rows } = await run(
        'SELECT raindrop_id, visit_count, last_visit FROM visits WHERE user_id = $1',
        [id],
      );
      const map = new Map();
      for (const r of rows) {
        map.set(Number(r.raindrop_id), { count: r.visit_count, last: r.last_visit });
      }
      return map;
    },

    async recordVisit(id, rid, iso) {
      await run(
        `INSERT INTO visits (user_id, raindrop_id, visit_count, last_visit) VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, raindrop_id) DO UPDATE SET
           visit_count = visits.visit_count + 1,
           last_visit = EXCLUDED.last_visit`,
        [id, rid, iso],
      );
    },

    async known(id) {
      return ids((await run('SELECT raindrop_id FROM known_items WHERE user_id = $1', [id])).rows);
    },

    async newItems(id) {
      return ids((await run('SELECT raindrop_id FROM new_items WHERE user_id = $1', [id])).rows);
    },

    // Replace the known and new lists for one user. Also marks the baseline as saved.
    async replaceStatus(id, knownIds, newIds) {
      const known = [...knownIds];
      const fresh = [...newIds];
      await inTransaction(async (client) => {
        // Serialize the writes of one user. Two pulls at once must not insert the same IDs.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
        await client.query('DELETE FROM known_items WHERE user_id = $1', [id]);
        await client.query('DELETE FROM new_items WHERE user_id = $1', [id]);
        await client.query(
          'INSERT INTO known_items (user_id, raindrop_id) SELECT $1, unnest($2::bigint[])',
          [id, known],
        );
        await client.query(
          'INSERT INTO new_items (user_id, raindrop_id) SELECT $1, unnest($2::bigint[])',
          [id, fresh],
        );
        await client.query(
          'INSERT INTO users (id, baseline, created_at) VALUES ($1, 1, $2) ON CONFLICT (id) DO UPDATE SET baseline = 1',
          [id, new Date().toISOString()],
        );
      });
    },

    // The duplicate groups that the user kept: a list of { hash, ids }. See migrations/004_kept_duplicates.sql.
    async keptDuplicates(id) {
      const { rows } = await run('SELECT group_hash, raindrop_ids FROM kept_duplicates WHERE user_id = $1', [id]);
      return rows.map((r) => ({ hash: r.group_hash, ids: r.raindrop_ids.map(Number) }));
    },

    // Keep one duplicate group with the bookmarks that it has now. A second call replaces the IDs.
    async keepDuplicates(id, hash, rids) {
      await run(
        `INSERT INTO kept_duplicates (user_id, group_hash, raindrop_ids, kept_at) VALUES ($1, $2, $3::bigint[], $4)
         ON CONFLICT (user_id, group_hash) DO UPDATE SET raindrop_ids = EXCLUDED.raindrop_ids, kept_at = EXCLUDED.kept_at`,
        [id, hash, rids, new Date().toISOString()],
      );
    },

    async unkeepDuplicates(id, hash) {
      await run('DELETE FROM kept_duplicates WHERE user_id = $1 AND group_hash = $2', [id, hash]);
    },

    async removeNew(id, rid) {
      await run('DELETE FROM new_items WHERE user_id = $1 AND raindrop_id = $2', [id, rid]);
    },

    async addLog(id, entry) {
      await run(
        'INSERT INTO classify_log (user_id, time, raindrop_id, entry) VALUES ($1, $2, $3, $4)',
        [id, entry.time, entry.id, JSON.stringify(entry)],
      );
    },

    // The time of the last successful check for new bookmarks, or null.
    async setLastChecked(id, iso) {
      await run('UPDATE users SET last_checked = $2 WHERE id = $1', [id, iso]);
    },

    async lastChecked(id) {
      return (await one('SELECT last_checked FROM users WHERE id = $1', [id]))?.last_checked ?? null;
    },

    // The profile entries of one user, oldest first. See migrations/005_profile.sql.
    // id stays text: it is a BIGINT, and a JavaScript number cannot hold every BIGINT.
    async profile(id) {
      const { rows } = await run(`SELECT ${PROFILE_COLUMNS} FROM profile_entries WHERE user_id = $1 ORDER BY id`, [id]);
      return rows.map(profileRow);
    },

    // Create an entry (no entry.id), or change the entry of this user with that ID.
    // Returns the saved entry, or null when the user has no entry with that ID.
    // The source of an entry is set when it is created and does not change.
    async saveEntry(id, entry) {
      const values = [entry.kind, entry.name, entry.description, entry.tag, entry.active, new Date().toISOString()];
      const row = entry.id
        ? await one(
          `UPDATE profile_entries SET kind = $3, name = $4, description = $5, tag = $6, active = $7, updated_at = $8
           WHERE user_id = $1 AND id = $2 RETURNING ${PROFILE_COLUMNS}`,
          [id, entry.id, ...values],
        )
        : await one(
          `INSERT INTO profile_entries (user_id, kind, name, description, tag, active, updated_at, source, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${PROFILE_COLUMNS}`,
          [id, ...values, entry.source ?? 'manual', entry.sourceRef ?? null],
        );
      return row ? profileRow(row) : null;
    },

    // Delete one entry of this user. Returns false when the user has no entry with that ID.
    async deleteEntry(id, entryId) {
      const res = await run('DELETE FROM profile_entries WHERE user_id = $1 AND id = $2', [id, entryId]);
      return res.rowCount > 0;
    },

    // Check that the database answers. Throws when it does not.
    async ping() {
      await run('SELECT 1', []);
    },

    // Delete every row of one user. Tokens are removed first by the caller. Runs in one transaction.
    async deleteUserData(id) {
      await inTransaction(async (client) => {
        for (const table of ['raindrop_tokens', 'visits', 'known_items', 'new_items', 'classify_log', 'kept_duplicates', 'profile_entries', ...STORE_TABLES]) {
          await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]);
        }
        await client.query('DELETE FROM users WHERE id = $1', [id]);
      });
    },

    // Delete change-log rows older than the cutoff (an ISO time). Returns the number removed.
    async pruneLog(cutoffIso) {
      const res = await run('DELETE FROM classify_log WHERE time < $1', [cutoffIso]);
      return res.rowCount;
    },

    async close() {
      await pool.end();
    },

    // The pool. Used by the migration runner in tests.
    pool,
  };
}
