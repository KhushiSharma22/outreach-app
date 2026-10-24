// Copies an existing SQLite database into PostgreSQL (e.g. Supabase).
// Usage: DATABASE_URL=postgres://... node scripts/sqlite-to-postgres.mjs [data/outreach.db]
// Safe to re-run: rows that already exist are skipped. The server should be stopped while it runs.
import { existsSync } from 'node:fs';
import { openDb, TABLES } from '../server/db.mjs';

const file = process.argv[2] || 'data/outreach.db';
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to the target Postgres connection string.'); process.exit(1); }
if (!existsSync(file)) { console.error(`SQLite file not found: ${file}`); process.exit(1); }

const src = await openDb({ file });   // also applies pending SQLite migrations
const dst = await openDb({ url });    // creates the schema and row-level security if needed
let total = 0;
await dst.tx(async () => {
  for (const table of TABLES) {      // schema order respects foreign keys
    const rows = await src.all(`SELECT * FROM ${table}`);
    let added = 0;
    for (const row of rows) {
      const keys = Object.keys(row);
      const r = await dst.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(k => ':' + k).join(',')}) ON CONFLICT DO NOTHING`, row);
      added += r.changes;
    }
    total += added;
    console.log(`${table.padEnd(26)} ${String(rows.length).padStart(6)} rows, ${added} copied`);
  }
  // Continue the audit sequence after the copied rows.
  await dst.run("SELECT setval(pg_get_serial_sequence('audit_events','seq'), greatest(coalesce((SELECT max(seq) FROM audit_events), 0), 1))");
});
console.log(`Done: ${total} rows copied from ${file}.`);
await src.close();
await dst.close();
