// Test database: SQLite in memory by default; with TEST_DATABASE_URL, a fresh Postgres database
// per test file (created and dropped here) so files can run in parallel.
import { randomBytes } from 'node:crypto';

export async function testDatabase() {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return { databaseUrl: null, dbFile: ':memory:', drop: async () => {} };
  const { default: pg } = await import('pg');
  const name = 'outbound_test_' + randomBytes(6).toString('hex');
  const c = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 });
  await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  const url = new URL(admin); url.pathname = '/' + name;
  return {
    databaseUrl: url.toString(), dbFile: ':memory:',
    drop: async () => { const d = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 5000 }); await d.connect(); await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await d.end(); },
  };
}
