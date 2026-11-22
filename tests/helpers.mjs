// Test database: SQLite in memory by default; with TEST_DATABASE_URL, a fresh Postgres database
// per test file (created and dropped here) so files can run in parallel.
import { randomBytes } from 'node:crypto';

// Model workspaces that already had multiple campaigns before the single-campaign policy.
export async function addLegacyCampaign(ctx,body){
  const rows=await ctx.db.all("SELECT id,status FROM campaigns WHERE workspace_id=? AND status<>'deleted'",[ctx.ws]);
  for(const row of rows)await ctx.db.run("UPDATE campaigns SET status='deleted' WHERE id=?",[row.id]);
  try { const {createCampaign}=await import('../server/campaigns.mjs');return await createCampaign(ctx,body); }
  finally { for(const row of rows)await ctx.db.run('UPDATE campaigns SET status=? WHERE id=?',[row.status,row.id]); }
}

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
