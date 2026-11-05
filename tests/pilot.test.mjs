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
 const run=await startDiscovery(ctx,a.id);await assert.rejects(startDiscovery(ctx,b.id),/30 contact checks/);
 await executeDiscovery(ctx,run.id);
 assert.ok(Number((await db.get('SELECT count(*) n FROM campaign_leads WHERE campaign_id=?',[a.id])).n)<=30);
 await executeDiscovery(ctx,run.id);assert.equal(Number((await db.get('SELECT count(*) n FROM pilot_allocations')).n),1);
 }finally{await db.close();}
});
test('small batches leave daily capacity for later imports and other campaigns',async()=>{
 const db=await openDb({file:':memory:'});process.env.AI_PROVIDER='offline';
 try{
 const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user,jobs:{enqueue:async()=>{}}};
 const a=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
 const b=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
 const csv=(start,n)=>'first_name,email,role,company,employees,location\n'+Array.from({length:n},(_,i)=>`Person${start+i},person${start+i}@example.com,Founder,Company${start+i},5,India`).join('\n');
 await assert.rejects(startDiscovery(ctx,a.id),e=>e.code==='no_new_contacts');
 assert.equal(Number((await db.get('SELECT count(*) n FROM pilot_allocations')).n),0);
 await importCsv(ctx,{csv:csv(0,2)});const r1=await startDiscovery(ctx,a.id);
 assert.equal((await startDiscovery(ctx,a.id)).id,r1.id);
 await executeDiscovery(ctx,r1.id);
 await importCsv(ctx,{csv:csv(2,10)});const r2=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,r2.id);
 assert.equal((await db.get('SELECT candidates FROM discovery_runs WHERE id=?',[r2.id])).candidates,10);
 await importCsv(ctx,{csv:csv(12,30)});
 const outcomes=await Promise.allSettled([startDiscovery(ctx,a.id),startDiscovery(ctx,b.id)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'daily_limit');
 const r3=outcomes.find(x=>x.status==='fulfilled').value;await executeDiscovery(ctx,r3.id);await executeDiscovery(ctx,r3.id);
 assert.equal(Number((await db.get('SELECT count(*) n FROM pilot_contacts')).n),30);
 assert.equal((await db.get('SELECT candidates FROM discovery_runs WHERE id=?',[r3.id])).candidates,18);
 assert.equal(Number((await db.get('SELECT count(*) n FROM pilot_allocations')).n),1);
 }finally{await db.close()}
});
