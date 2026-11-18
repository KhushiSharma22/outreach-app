import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { seedWorkspace } from '../server/app.mjs';
import { createCampaign, updateCampaign } from '../server/campaigns.mjs';
import { seedResearch } from '../server/lead-pools.mjs';
import { startDiscovery, executeDiscovery } from '../server/sourcing.mjs';
import { executeDraftRun, listDrafts, approveDrafts } from '../server/drafts.mjs';
import { createJobs, registerHandlers, runScheduler } from '../server/jobs.mjs';
import { launch, dispatchApproved, smtpSend } from '../server/delivery.mjs';

test('150 admin leads send in five scheduled batches through the connected SMTP transport', async () => {
 const RealDate=Date; let clock=RealDate.parse('2026-11-16T09:00:00Z');
 globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[clock]));} static now(){return clock;} };
 process.env.AI_PROVIDER='offline'; const db=await openDb({file:':memory:'}); let jobs;
 try {
  const {workspace,user}=await seedWorkspace(db); const base={db,ws:workspace.id,user,publicUrl:'https://test.example'};
  jobs=createJobs(db,()=>{}, {serverless:true}); const system=()=>({...base,user:null,jobs}); const ctx={...base,jobs}; registerHandlers(jobs,db,system);
  let c=await createCampaign(ctx,{name:'Test',brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:30,delivery:'smtp',approval:'rules',writing:{angle:'Company-led'},schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'UTC'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:150},(_,i)=>`Person${i},Test,p${i}@example.com,Company${i},Founder,valid,100`).join('\n');
  assert.equal((await seedResearch(ctx,c.id,{csv})).ready,150);
  const first=await startDiscovery(ctx,c.id); await executeDiscovery(ctx,first.id);
  await executeDraftRun(ctx,{campaign_id:c.id});const drafts=await listDrafts(ctx,c.id);assert.equal(drafts.total,30);
  assert.equal((await approveDrafts(ctx,{items:drafts.items.map(x=>({draft_id:x.draft.id,revision_id:x.draft.revision_id})),confirm:true})).filter(x=>x.status==='approved').length,30);
  await db.insert('mailboxes',{workspace_id:ctx.ws,sender:user.email,postal_address:'123 Test Street',credentials:'test',updated_at:new Date().toISOString()});
  await assert.rejects(launch(ctx,c.id,{revision:c.revision}),/Confirm automatic/);
  await launch(ctx,c.id,{revision:c.revision,authorize_automatic:true});
  const sent=[];const fake=async()=>({row:{sender:user.email,postal_address:'123 Test Street'},client:{sendMail:async message=>sent.push({day:new Date().toISOString().slice(0,10),...message}),close(){}}});
  const send=(...args)=>smtpSend(...args,fake);
  await dispatchApproved(system(),c.id,clock,send);assert.equal(sent.length,30);
  for(let day=1;day<5;day++){
   clock+=86400000-60000;
   await runScheduler(db,system,clock,send);
   assert.equal(sent.length,day*30, 'nothing sends before the scheduled time');
   assert.equal(await db.get('SELECT 1 FROM discovery_runs WHERE campaign_id=? AND occurrence_date=?',[c.id,new Date().toISOString().slice(0,10)]),undefined);
   clock+=60000;
   await runScheduler(db,system,clock,send);
   await jobs.drain();
   assert.equal((await db.get('SELECT status FROM discovery_runs WHERE campaign_id=? AND occurrence_date=?',[c.id,new Date().toISOString().slice(0,10)])).status,'completed');
   await runScheduler(db,system,clock,send);
   assert.equal(sent.length,(day+1)*30);
  }
  assert.equal(new Set(sent.map(x=>x.to)).size,150);
  assert.deepEqual([...new Set(sent.map(x=>x.day))],['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20']);
  assert.ok(sent.every(x=>x.from===user.email&&x.text.includes('https://test.example/unsubscribe/')));
 } finally {jobs?.stop();await db.close();globalThis.Date=RealDate;}
});
