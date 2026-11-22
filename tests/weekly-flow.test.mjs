import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign} from '../server/campaigns.mjs';
import {seedResearch,startWeeklyDiscovery,moveUpcomingToToday} from '../server/lead-pools.mjs';
import {executeDiscovery} from '../server/sourcing.mjs';
import {executeDraftRun,listDrafts,approveDrafts} from '../server/drafts.mjs';
import {launch,deleteCampaign} from '../server/delivery.mjs';
import {listCampaigns} from '../server/campaigns.mjs';
import {runScheduler} from '../server/jobs.mjs';
import {workspaceSummary} from '../server/reporting.mjs';
import {addLegacyCampaign} from './helpers.mjs';

test('new research fills an unreserved scheduled day after midnight, before send time',async()=>{
 const db=await openDb({file:':memory:'}),old=Date.now;process.env.AI_PROVIDER='offline';
 Date.now=()=>Date.parse('2026-11-21T22:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db), queued=[];
  const ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async(_ws,type,payload)=>{queued.push({type,payload});return {id:'job'};}}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:2,delivery:'smtp',schedule:{days:['Sat','Sun'],time:'14:00',timezone:'Asia/Kolkata'}}});
  const headers='first_name,last_name,email,company,role,email_status,quality_score\n';
  await seedResearch(ctx,c.id,{csv:headers+'Alex,Test,first@example.com,First,Founder,valid,95',available_on:'2026-11-21'});
  const first=await startWeeklyDiscovery(ctx,c.id,Date.now());await executeDiscovery(ctx,first.run_id);await executeDraftRun(ctx,{campaign_id:c.id});
  await db.run("UPDATE campaigns SET status='active' WHERE id=?",[c.id]);
  Date.now=()=>Date.parse('2026-11-22T00:15:00+05:30');
  await seedResearch(ctx,c.id,{csv:headers+'Alex,Test,second@example.com,Second,Founder,valid,95',available_on:'2026-11-22'});
  await runScheduler(db,()=>ctx,Date.now(),async()=>{throw new Error('must not send');},{weeklyOnly:true});
  const sunday=await db.get("SELECT run_id FROM weekly_slots WHERE campaign_id=? AND slot_date='2026-11-22'",[c.id]);
  assert.ok(sunday,'Sunday assigned immediately after midnight');
  await executeDiscovery(ctx,sunday.run_id);await executeDraftRun(ctx,{campaign_id:c.id});
  assert.equal(Number((await db.get('SELECT count(*) n FROM drafts WHERE campaign_id=?',[c.id])).n),2);
  await runScheduler(db,()=>ctx,Date.now(),async()=>{throw new Error('must not send');},{weeklyOnly:true});
  assert.equal(Number((await db.get("SELECT count(*) n FROM weekly_slots WHERE campaign_id=? AND slot_date='2026-11-22'",[c.id])).n),1);
  assert.equal(Number((await db.get('SELECT count(*) n FROM send_tasks WHERE campaign_id=?',[c.id])).n),0);
 }finally{Date.now=old;await db.close();}
});

test('weekly research creates distinct day assignments, drafts, and approved-only send tasks',async()=>{
 const db=await openDb({file:':memory:'}); process.env.AI_PROVIDER='offline'; const originalNow=Date.now; Date.now=()=>Date.parse('2026-11-23T01:00:00+05:30');
 try {
  const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:30,delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:150},(_,i)=>`Alex,Test,weekly${i}@example.com,Company${i},Founder,valid,95`).join('\n');
  assert.equal((await seedResearch(ctx,c.id,{csv,available_on:'2026-11-23'})).ready,150);
  const started=await startWeeklyDiscovery(ctx,c.id,Date.parse('2026-11-23T00:30:00+05:30'));
  assert.equal(started.assigned,150);
  await assert.rejects(updateCampaign(ctx,c.id,{revision:c.revision,config:{schedule:{days:['Tue']}}}),e=>e.code==='weekly_schedule_locked');
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{schedule:{time:'10:00'}}});
  assert.equal(c.config.schedule.time,'10:00');
  assert.deepEqual((await db.all('SELECT slot_date,count(*) n FROM weekly_slots GROUP BY slot_date ORDER BY slot_date')).map(r=>Number(r.n)),[30,30,30,30,30]);
  await executeDiscovery(ctx,started.run_id);
  let draftJobs=0;ctx.jobs.enqueue=async(_ws,type)=>{if(type==='drafts')draftJobs++;return{id:'test-job'};};
  await runScheduler(db,()=>ctx,Date.now(),undefined,{weeklyOnly:true});
  assert.equal(draftJobs,1,'daily drafts queued after midnight even before campaign launch');
  await executeDraftRun(ctx,{campaign_id:c.id});
  const drafts=await listDrafts(ctx,c.id);assert.equal(drafts.total,30);assert.equal(Number((await db.get('SELECT count(*) n FROM drafts')).n),30);
  const first=drafts.items[0].draft;await approveDrafts(ctx,{items:[{draft_id:first.id,revision_id:first.revision_id}]});
  await db.insert('mailboxes',{workspace_id:ctx.ws,sender:user.email,postal_address:'123 Test Street',credentials:'test only',updated_at:new Date().toISOString()});
  const launched=await launch(ctx,c.id,{revision:c.revision});assert.equal(launched.created,1);
  const task=await db.get('SELECT st.due_at,ws.slot_date FROM send_tasks st JOIN weekly_slots ws ON ws.contact_id=st.contact_id WHERE st.workspace_id=?',[ctx.ws]);
  assert.ok(Date.parse(task.due_at)>=Date.parse(task.slot_date+'T04:30:00Z'));
  assert.equal(Number((await db.get('SELECT count(*) n FROM send_tasks WHERE workspace_id=?',[ctx.ws])).n),1);
  c=await updateCampaign(ctx,c.id,{revision:launched.campaign.revision,config:{schedule:{time:'13:00'}}});
  const movedTask=await db.get('SELECT due_at FROM send_tasks WHERE campaign_id=?',[c.id]);
  assert.equal(movedTask.due_at,task.slot_date+'T07:30:00.000Z');
   Date.now=()=>Date.parse('2026-11-24T01:00:00+05:30');
  await executeDraftRun(ctx,{campaign_id:c.id});
  assert.equal((await listDrafts(ctx,c.id)).total,60);
  assert.equal(Number((await db.get('SELECT count(*) n FROM drafts')).n),60);
  await db.run("UPDATE send_tasks SET status='sending' WHERE campaign_id=?",[c.id]);
  await assert.rejects(deleteCampaign(ctx,c.id),e=>e.code==='sending_in_progress');
  await db.run("UPDATE send_tasks SET status='pending' WHERE campaign_id=?",[c.id]);
  await deleteCampaign(ctx,c.id);
  assert.equal((await listCampaigns(ctx)).length,0);
  const summary=await workspaceSummary(ctx);assert.equal(Number(summary.awaiting_review),0);assert.equal(Number(summary.contacts),0);
  assert.equal((await db.get('SELECT status FROM send_tasks WHERE campaign_id=?',[c.id])).status,'canceled');
 }finally{Date.now=originalNow;await db.close();}
});

test('three per day reserves fifteen and automatically schedules remaining leads the following week',async()=>{
 const db=await openDb({file:':memory:'}),originalNow=Date.now;process.env.AI_PROVIDER='offline';Date.now=()=>Date.parse('2026-11-23T01:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db),queued=[];
  const ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async(_ws,type,payload)=>{queued.push({type,payload});return{id:'test-job'};}}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3,delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:30},(_,i)=>`Alex,Test,small${i}@example.com,Company${i},Founder,valid,95`).join('\n');
  await seedResearch(ctx,c.id,{csv,available_on:'2026-11-23'});
  const first=await startWeeklyDiscovery(ctx,c.id,Date.now());assert.equal(first.assigned,15);assert.equal(first.unassigned,15);
  assert.deepEqual((await db.all('SELECT count(*) n FROM weekly_slots GROUP BY slot_date ORDER BY slot_date')).map(x=>Number(x.n)),[3,3,3,3,3]);
  await executeDiscovery(ctx,first.run_id);await executeDraftRun(ctx,{campaign_id:c.id});
  assert.equal((await listDrafts(ctx,c.id)).total,3);
  await db.run("UPDATE campaigns SET status='active' WHERE id=?",[c.id]);
  Date.now=()=>Date.parse('2026-11-30T00:15:00+05:30');
  await runScheduler(db,()=>ctx,Date.now(),async()=>{}, {weeklyOnly:true});
  const counts=await db.all("SELECT count(*) n FROM weekly_slots WHERE slot_date>='2026-11-30' GROUP BY slot_date ORDER BY slot_date");
  assert.deepEqual(counts.map(x=>Number(x.n)),[3,3,3,3,3]);
  assert.equal(Number((await db.get('SELECT count(*) n FROM weekly_slots')).n),30);
 }finally{Date.now=originalNow;await db.close();}
});

test('weekend preparation reserves next Monday without sending or drafting early',async()=>{
 const db=await openDb({file:':memory:'}),originalNow=Date.now;process.env.AI_PROVIDER='offline';Date.now=()=>Date.parse('2026-11-21T13:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db),ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3,schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:6},(_,i)=>`Alex,Test,weekend${i}@example.com,Company${i},Founder,valid,95`).join('\n');
  await seedResearch(ctx,c.id,{csv,available_on:'2026-11-21'});
  const r=await startWeeklyDiscovery(ctx,c.id,Date.now());
  assert.equal(r.assigned,6);assert.equal(r.first_date,'2026-11-23');assert.equal(r.week_start,'2026-11-23');
  await executeDiscovery(ctx,r.run_id);await executeDraftRun(ctx,{campaign_id:c.id});
  const drafts=await listDrafts(ctx,c.id);assert.equal(drafts.total,0);assert.equal(drafts.scheduled_future,6);
 }finally{Date.now=originalNow;await db.close();}
});

test('another campaign holding this week moves planning to next week',async()=>{
 const db=await openDb({file:':memory:'}),originalNow=Date.now;process.env.AI_PROVIDER='offline';Date.now=()=>Date.parse('2026-11-23T01:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db),ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3,schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\nAlex,Test,blocked@example.com,Company,Founder,valid,95';
  await seedResearch(ctx,c.id,{csv,available_on:'2026-11-23'});
  for(let n=23;n<=27;n++)await db.insert('research_days',{workspace_id:ctx.ws,day:`2026-11-${n}`,campaign_id:'another',allocated:3});
  const r=await startWeeklyDiscovery(ctx,c.id,Date.now());assert.equal(r.first_date,'2026-11-30');
 }finally{Date.now=originalNow;await db.close();}
});

test('Saturday at 10:10pm is usable today even when weekdays are also selected',async()=>{
 const db=await openDb({file:':memory:'}),originalNow=Date.now;process.env.AI_PROVIDER='offline';Date.now=()=>Date.parse('2026-11-21T22:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db),ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3,schedule:{days:['Mon','Tue','Wed','Thu','Fri','Sat'],time:'22:10',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:3},(_,i)=>`Alex,Test,saturday${i}@example.com,Company${i},Founder,valid,95`).join('\n');
  await seedResearch(ctx,c.id,{csv,available_on:'2026-11-21'});
  const r=await startWeeklyDiscovery(ctx,c.id,Date.now());assert.equal(r.first_date,'2026-11-21');assert.equal(r.assigned,3);
 }finally{Date.now=originalNow;await db.close();}
});


test('deleted unused reservation can be released and future leads moved to selected Saturday',async()=>{
 const db=await openDb({file:':memory:'}),old=Date.now;process.env.AI_PROVIDER='offline';Date.now=()=>Date.parse('2026-11-21T22:00:00+05:30');
 try{
  const {workspace,user}=await seedWorkspace(db),ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3,schedule:{days:['Mon','Sat'],time:'22:10',timezone:'Asia/Kolkata'}}});
  const previous=await addLegacyCampaign(ctx,{name:'Deleted campaign'});await db.run("UPDATE campaigns SET status='deleted' WHERE id=?",[previous.id]);
  await db.insert('research_days',{workspace_id:ctx.ws,day:'2026-11-21',campaign_id:previous.id,allocated:3});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\nAlex,Test,movetoday@example.com,Company,Founder,valid,95';
  await seedResearch(ctx,c.id,{csv,available_on:'2026-11-21'});
  // Place the lead in a future slot, as the earlier version did.
  const first=await startWeeklyDiscovery(ctx,c.id,Date.parse('2026-11-22T01:00:00+05:30'));
  await executeDiscovery(ctx,first.run_id);
  assert.equal((await listDrafts(ctx,c.id)).scheduled_future,1);
  const r=await moveUpcomingToToday(ctx,c.id,Date.now());assert.equal(r.moved,1);assert.equal(r.date,'2026-11-21');
  assert.equal((await db.get('SELECT campaign_id FROM research_days WHERE workspace_id=? AND day=?',[ctx.ws,'2026-11-21'])).campaign_id,c.id);
  await executeDraftRun(ctx,{campaign_id:c.id});assert.equal((await listDrafts(ctx,c.id)).total,1);
 }finally{Date.now=old;await db.close();}
});
