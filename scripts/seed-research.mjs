// Operator-only CLI: prepare a campaign's weekly research pool. Never run from a public endpoint.
import {readFile} from 'node:fs/promises';
import {openDb} from '../server/db.mjs';
import {seedResearch} from '../server/lead-pools.mjs';
const [workspace,campaign,file,available_on]=process.argv.slice(2);
if(!file)throw Error('Usage: node --env-file-if-exists=.env scripts/seed-research.mjs WORKSPACE_ID CAMPAIGN_ID leads.csv [YYYY-MM-DD]');
const db=await openDb(process.env.DATABASE_URL?{url:process.env.DATABASE_URL}:{file:process.env.DB_FILE||'data/outreach.db'});
try{const user=await db.get("SELECT * FROM users WHERE workspace_id=? AND role='owner' LIMIT 1",[workspace]);if(!user)throw Error('Workspace owner not found');console.log(JSON.stringify(await seedResearch({db,ws:workspace,user},campaign,{csv:await readFile(file,'utf8'),...(available_on?{available_on}:{})}),null,2));}finally{await db.close()}
