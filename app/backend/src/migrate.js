// Apply the SQL files in migrations/ in order. Each file runs once.
// Run as the admin role: `npm run migrate`, with DATABASE_ADMIN_URL set.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// pool: a pg Pool. Its search_path decides the schema that receives the tables.
export async function migrate(pool) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [file, new Date().toISOString()]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

// Command line entry point. Paths are resolved first, so a symlink such as `current` still matches.
// Without this, the migration would silently do nothing.
const isMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const { default: pg } = await import('pg');
  const { config } = await import('./config.js');
  if (!config.database.adminUrl) {
    console.error('DATABASE_ADMIN_URL is not set. Set it in the environment or in .env.');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: config.database.adminUrl, max: 1 });
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No new migrations.');
  } finally {
    await pool.end();
  }
}
