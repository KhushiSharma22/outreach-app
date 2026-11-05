import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {emailAllowed,requireAllowed,googleEnabled,createSession,sessionFromToken} from '../server/auth.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {addSuppression,removeSuppression} from '../server/delivery.mjs';
test('closed allowlist, disabled Google, and revocation of existing sessions',async()=>{
 process.env.ALLOWED_EMAILS=''; assert.equal(emailAllowed('pilot@example.com'),false); assert.throws(()=>requireAllowed('pilot@example.com'));
 process.env.ALLOWED_EMAILS=' Pilot@Example.com '; assert.equal(emailAllowed('pilot@example.com'),true);
 process.env.GOOGLE_CLIENT_ID='configured';process.env.GOOGLE_CLIENT_SECRET='configured';assert.equal(googleEnabled(),false);
 const db=await openDb({file:':memory:'});
 try {const {user}=await seedWorkspace(db,{email:'pilot@example.com'});const token=await createSession(db,user,{method:'password'});assert.ok(await sessionFromToken(db,token));process.env.ALLOWED_EMAILS='';assert.equal(await sessionFromToken(db,token),null);await assert.rejects(createSession(db,user,{method:'password'}));} finally{await db.close();}
});
test('opt-outs cannot be removed and remain idempotent',async()=>{
 const db=await openDb({file:':memory:'});try{const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user};const a=await addSuppression(ctx,{email:' Test@Example.com ',reason:'opt_out'});const b=await addSuppression(ctx,{email:'test@example.com',reason:'opt_out'});assert.equal(a.id,b.id);await assert.rejects(removeSuppression(ctx,a.id));}finally{await db.close();}
});
import {createCampaign} from '../server/campaigns.mjs';
import {startDiscovery,executeDiscovery,importCsv} from '../server/sourcing.mjs';
import {sampleCsv} from '../server/sample.mjs';
test('pilot allocation is shared across campaigns and exposes at most 30 candidates',async()=>{
 process.env.AI_PROVIDER='offline'; const db=await openDb({file:':memory:'});
 try {const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user,jobs:{enqueue:async()=>{}}};
 await importCsv(ctx,{csv:sampleCsv()});
 const a=await createCampaign(ctx,{brief:{filters:{industries:['B2B SaaS']}}});
 const b=await createCampaign(ctx,{brief:{filters:{industries:['B2B SaaS']}}});
 const run=await startDiscovery(ctx,a.id);await assert.rejects(startDiscovery(ctx,b.id),/already been allocated/);
 await executeDiscovery(ctx,run.id);
 assert.ok(Number((await db.get('SELECT count(*) n FROM campaign_leads WHERE campaign_id=?',[a.id])).n)<=30);
 await executeDiscovery(ctx,run.id);assert.equal(Number((await db.get('SELECT count(*) n FROM pilot_allocations')).n),1);
 }finally{await db.close();}
});
