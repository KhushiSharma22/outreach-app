import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign} from '../server/campaigns.mjs';
import {seedResearch,startWeeklyDiscovery} from '../server/lead-pools.mjs';
import {executeDiscovery} from '../server/sourcing.mjs';
import {executeDraftRun,listDrafts,approveDrafts} from '../server/drafts.mjs';
import {launch} from '../server/delivery.mjs';

test('weekly research creates distinct day assignments, drafts, and approved-only send tasks',async()=>{
 const db=await openDb({file:':memory:'}); process.env.AI_PROVIDER='offline';
 try {
  const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>({id:'job'})}};
  let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:30,delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri'],time:'09:00',timezone:'Asia/Kolkata'}}});
  const csv='first_name,last_name,email,company,role,email_status,quality_score\n'+Array.from({length:150},(_,i)=>`Alex,Test,weekly${i}@example.com,Company${i},Founder,valid,95`).join('\n');
  assert.equal((await seedResearch(ctx,c.id,{csv,available_on:'2026-11-23'})).ready,150);
  const started=await startWeeklyDiscovery(ctx,c.id,Date.parse('2026-11-23T00:30:00+05:30'));
  assert.equal(started.assigned,150);
  await assert.rejects(updateCampaign(ctx,c.id,{revision:c.revision,config:{schedule:{time:'10:00'}}}),e=>e.code==='weekly_schedule_locked');
  assert.deepEqual((await db.all('SELECT slot_date,count(*) n FROM weekly_slots GROUP BY slot_date ORDER BY slot_date')).map(r=>Number(r.n)),[30,30,30,30,30]);
  await executeDiscovery(ctx,started.run_id); await executeDraftRun(ctx,{campaign_id:c.id});
  const drafts=await listDrafts(ctx,c.id);assert.equal(drafts.total,150);assert.equal(drafts.items.filter(x=>x.lead.slot_date==='2026-11-24').length,30);
  const first=drafts.items[0].draft;await approveDrafts(ctx,{items:[{draft_id:first.id,revision_id:first.revision_id}]});
  await db.insert('mailboxes',{workspace_id:ctx.ws,sender:user.email,postal_address:'123 Test Street',credentials:'test only',updated_at:new Date().toISOString()});
  const launched=await launch(ctx,c.id,{revision:c.revision});assert.equal(launched.created,1);
  const task=await db.get('SELECT st.due_at,ws.slot_date FROM send_tasks st JOIN weekly_slots ws ON ws.contact_id=st.contact_id WHERE st.workspace_id=?',[ctx.ws]);
  assert.ok(Date.parse(task.due_at)>=Date.parse(task.slot_date+'T03:30:00Z'));
  assert.equal(Number((await db.get('SELECT count(*) n FROM send_tasks WHERE workspace_id=?',[ctx.ws])).n),1);
 }finally{await db.close();}
});
