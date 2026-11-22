import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign,listCampaigns} from '../server/campaigns.mjs';
import {seedResearch,startWeeklyDiscovery,sourceStatus} from '../server/lead-pools.mjs';
import {executeDiscovery} from '../server/sourcing.mjs';
import {executeDraftRun,listDrafts,approveDrafts} from '../server/drafts.mjs';
import {launch,deleteCampaign} from '../server/delivery.mjs';

async function setup(fn){const db=await openDb({file:':memory:'});process.env.AI_PROVIDER='offline';const old=Date.now;try{const {workspace,user}=await seedWorkspace(db);await fn({db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}});}finally{Date.now=old;await db.close();}}
const csv=(prefix,count)=>'first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:count},(_,i)=>`Alex,Test,${prefix}${i}@example.com,Company${prefix}${i},Founder,valid,95`).join('\n');

test('only one non-deleted campaign per workspace, including simultaneous requests',()=>setup(async ctx=>{
 const results=await Promise.allSettled([createCampaign(ctx,{name:'First'}),createCampaign(ctx,{name:'Second'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'campaign_limit');
 const first=results.find(r=>r.status==='fulfilled').value;
 await ctx.db.run("UPDATE campaigns SET status='stopped' WHERE id=?",[first.id]);
 await assert.rejects(createCampaign(ctx,{name:'Another'}),e=>e.code==='campaign_limit');
 await deleteCampaign(ctx,first.id);
 const next=await createCampaign(ctx,{name:'Replacement'});assert.equal((await listCampaigns(ctx)).length,1);assert.equal(next.name,'Replacement');
 const other=await seedWorkspace(ctx.db,{email:'different@example.com'});
 assert.ok(await createCampaign({...ctx,ws:other.workspace.id,user:other.user},{name:'Other workspace'}));
}));

test('after a sent email, replacement campaign shows and reserves the next available scheduled time',()=>setup(async ctx=>{
 const at=Date.parse('2026-11-22T10:00:00+05:30');Date.now=()=>at;
 let old=await createCampaign(ctx,{name:'Old',brief:{filters:{roles:['Founder']},signals:[]}});
 old=await updateCampaign(ctx,old.id,{revision:old.revision,config:{target:1,delivery:'smtp',schedule:{days:['Sun','Mon','Tue'],time:'09:00',timezone:'Asia/Kolkata'}}});
 await seedResearch(ctx,old.id,{csv:csv('old',3),available_on:'2026-11-22'});
 const first=await startWeeklyDiscovery(ctx,old.id,at);assert.equal(first.first_date,'2026-11-22');
 await executeDiscovery(ctx,first.run_id);await executeDraftRun(ctx,{campaign_id:old.id});
 const d=(await listDrafts(ctx,old.id)).items[0].draft;await approveDrafts(ctx,{items:[{draft_id:d.id,revision_id:d.revision_id}]});
 await ctx.db.insert('mailboxes',{workspace_id:ctx.ws,sender:ctx.user.email,postal_address:'123 Test Street',credentials:'test',updated_at:new Date().toISOString()});
 await launch(ctx,old.id,{revision:old.revision});
 await ctx.db.run("UPDATE send_tasks SET status='sent',updated_at=? WHERE campaign_id=?",['2026-11-22T03:30:00.000Z',old.id]);
 await deleteCampaign(ctx,old.id);
 assert.deepEqual((await ctx.db.all('SELECT day FROM research_days ORDER BY day')).map(r=>r.day),['2026-11-22'],'used Sunday stays locked; unused Monday and Tuesday are released');
 // A reservation left by an older version is released as well when the new week is prepared.
 await ctx.db.insert('research_days',{workspace_id:ctx.ws,day:'2026-11-23',campaign_id:old.id,allocated:1});
 let next=await createCampaign(ctx,{name:'New',brief:{filters:{roles:['Founder']},signals:[]}});
 next=await updateCampaign(ctx,next.id,{revision:next.revision,config:{target:1,schedule:{days:['Sun','Mon','Tue'],time:'09:00',times:{Mon:'11:30'},timezone:'Asia/Kolkata'}}});
 const status=await sourceStatus(ctx,next.id,at);
 assert.equal(status.other_campaign_today,true);assert.equal(status.next_window.date,'2026-11-23');
 assert.equal(status.next_window.earliest_at,'2026-11-23T06:00:00.000Z');assert.equal(status.next_window.timezone,'Asia/Kolkata');
 await seedResearch(ctx,next.id,{csv:csv('new',2),available_on:'2026-11-22'});
 const reserved=await startWeeklyDiscovery(ctx,next.id,at);assert.equal(reserved.first_date,status.next_window.date);
 assert.equal((await ctx.db.get('SELECT campaign_id FROM research_days WHERE workspace_id=? AND day=?',[ctx.ws,'2026-11-23'])).campaign_id,next.id);
}));

test('window respects late approval timing and the UTC workspace send cap',()=>setup(async ctx=>{
 const at=Date.parse('2026-11-22T00:15:00+05:30');Date.now=()=>at;
 let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
 c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:2,schedule:{days:['Sun','Mon'],time:'00:00',timezone:'Asia/Kolkata'}}});
 let status=await sourceStatus(ctx,c.id,at);assert.equal(status.next_window.date,'2026-11-22');assert.equal(status.next_window.earliest_at,new Date(at).toISOString());
 await seedResearch(ctx,c.id,{csv:csv('cap',1),available_on:'2026-11-22'});
 const first=await startWeeklyDiscovery(ctx,c.id,at);await executeDiscovery(ctx,first.run_id);await executeDraftRun(ctx,{campaign_id:c.id});
 const item=(await listDrafts(ctx,c.id)).items[0];
 for(let i=0;i<30;i++)await ctx.db.insert('send_tasks',{id:`cap${i}`,workspace_id:ctx.ws,campaign_id:c.id,lead_id:item.lead.id,contact_id:item.lead.contact_id,kind:'initial',draft_revision_id:item.draft.revision_id,enrollment_id:null,step_index:null,to_email:item.lead.email,subject:'Test',body:'Test',due_at:new Date(at).toISOString(),status:'sent',status_reason:null,dedupe_key:`cap-${i}`,confirmed_at:null,confirmed_by:null,created_at:new Date(at).toISOString(),updated_at:new Date(at).toISOString()});
 status=await sourceStatus(ctx,c.id,at);assert.equal(status.next_window.date,'2026-11-22');
 assert.equal(status.next_window.earliest_at,'2026-11-22T00:00:00.000Z','UTC midnight is 05:30 IST');
}));
