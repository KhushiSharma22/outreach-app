// Run from a trusted operator terminal; never expose this command as a customer endpoint.
import {readFile} from 'node:fs/promises';
import {openDb} from '../server/db.mjs';
import {importCsv} from '../server/sourcing.mjs';
const [workspace,file]=process.argv.slice(2);
if(!workspace||!file) throw new Error('Usage: node --env-file-if-exists=.env scripts/import-pilot.mjs WORKSPACE_ID leads.csv');
const db=await openDb(process.env.DATABASE_URL?{url:process.env.DATABASE_URL}:{file:process.env.DB_FILE||'data/outreach.db'});
try {
 const user=await db.get("SELECT * FROM users WHERE workspace_id=? AND role='owner' LIMIT 1",[workspace]);
 if(!user) throw new Error('Workspace owner not found');
 console.log(JSON.stringify(await importCsv({db,ws:workspace,user},{filename:'Curated pilot pool',csv:await readFile(file,'utf8')})));
} finally {await db.close();}
