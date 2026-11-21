// Test database helpers. Each test run gets its own schema in the test database.
// The admin URL creates and drops the schema. The app uses the runtime URL.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/migrate.js';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? '';
export const TEST_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? '';
export const SKIP_REASON = TEST_URL && TEST_ADMIN_URL
  ? false
  : 'set TEST_DATABASE_URL and TEST_DATABASE_ADMIN_URL to run database tests';

// Create a schema, run the migrations in it, and return its name.
export async function createTestSchema() {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const pool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return schema;
}

export async function dropTestSchema(schema) {
  const pool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}
