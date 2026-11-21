import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign} from '../server/campaigns.mjs';
import {seedResearch} from '../server/lead-pools.mjs';
import {startDiscovery,executeDiscovery} from '../server/sourcing.mjs';
import {executeDraftRun,approveDrafts,listDrafts} from '../server/drafts.mjs';
import {launch,smtpSend,dispatchApproved,scheduledDue,addSuppression,removeSuppression,listTasks,confirmSent} from '../server/delivery.mjs';
const csv='first_name,last_name,email,company,role,email_status,quality_score\nAlex,One,one@example.com,One,Founder,valid,97\nAlex,Two,two@example.com,Two,Founder,valid,96';
async function setup(fn){const db=await openDb({file:':memory:'});process.env.AI_PROVIDER='offline';try{const {workspace,user}=await seedWorkspace(db);await fn({db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>{}}});}finally{await db.close()}}
test('scheduled time respects selected days, timezone and earliest send time',()=>{
 const config={schedule:{days:['Mon'],time:'09:00',timezone:'Asia/Kolkata'}};
 assert.equal(scheduledDue(config,Date.parse('2026-11-14T12:00:00Z')),'2026-11-16T03:30:00.000Z');
 assert.equal(scheduledDue(config,Date.parse('2026-11-16T04:00:00Z')),'2026-11-16T04:00:00.000Z');
});
test('admin scores persist; approved tasks schedule automatically and opt-outs cancel pending work',()=>setup(async ctx=>{
 let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
 c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{target:2,delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],time:'00:00',timezone:'UTC'}}});
 await seedResearch(ctx,c.id,{csv});const run=await startDiscovery(ctx,c.id);await executeDiscovery(ctx,run.id);
 assert.deepEqual((await ctx.db.all('SELECT score FROM campaign_leads ORDER BY score DESC')).map(x=>x.score),[97,96]);
 await executeDraftRun(ctx,{campaign_id:c.id});const drafts=await listDrafts(ctx,c.id);
 await approveDrafts(ctx,{items:drafts.items.map(l=>({draft_id:l.draft.id,revision_id:l.draft.revision_id})),confirm:true});
 await ctx.db.insert('mailboxes',{workspace_id:ctx.ws,sender:ctx.user.email,postal_address:'123 Test Street',credentials:'test only',updated_at:new Date().toISOString()});
 await launch(ctx,c.id,{revision:c.revision});
 const tasks=await ctx.db.all('SELECT * FROM send_tasks');assert.equal(tasks.length,2);
 const queue=await listTasks(ctx,{campaign_id:c.id});assert.ok(queue.items.every(t=>t.delivery==='smtp'));
 await assert.rejects(confirmSent(ctx,tasks[0].id),e=>e.code==='automatic_delivery');
 const calls=[];await dispatchApproved(ctx,c.id,Date.now(),async(_ctx,id,url,options)=>{calls.push({id,url,options});});assert.equal(calls.length,2);assert.equal(calls[0].options.automatic,true);
 // Suppression is persisted by normalized email and cancels every pending campaign task for it.
 const sup=await addSuppression(ctx,{email:' ONE@example.com ',reason:'opt_out'});
 assert.equal((await ctx.db.get('SELECT status FROM send_tasks WHERE to_email=?',['one@example.com'])).status,'canceled');
 await assert.rejects(removeSuppression(ctx,sup.id));
 await addSuppression(ctx,{email:'one@example.com',reason:'opt_out'});
 assert.equal(Number((await ctx.db.get('SELECT count(*) n FROM suppressions')).n),1);
 const sent=[];const fake=async()=>({row:{sender:ctx.user.email,postal_address:'123 Test Street'},client:{sendMail:async message=>{sent.push(message);},close(){}}});
 const remaining=tasks.find(t=>t.to_email==='two@example.com');
 const outcomes=await Promise.allSettled([smtpSend({...ctx,user:null},remaining.id,ctx.publicUrl,{automatic:true},fake),smtpSend({...ctx,user:null},remaining.id,ctx.publicUrl,{automatic:true},fake)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(sent.length,1);assert.match(sent[0].text,/https:\/\/app.example.com\/unsubscribe\//);
 assert.equal((await ctx.db.get('SELECT recorded_by FROM messages')).recorded_by,'system');
 await dispatchApproved(ctx,c.id,Date.now(),async(...args)=>smtpSend(...args,fake));assert.equal(sent.length,1);

}));

test('per-day times and late approvals use the correct local day', async()=>{
 const {scheduleErrors,normalizeConfig,defaultConfig}=await import('../server/campaigns.mjs');
 const {followupDue}=await import('../server/sequences.mjs');
 const schedule={days:['Mon','Tue'],time:'09:00',times:{Mon:'10:00',Tue:'15:00'},timezone:'America/New_York'};
 const c={schedule};
 assert.equal(scheduledDue(c,Date.parse('2026-11-16T13:00:00Z')),'2026-11-16T15:00:00.000Z');
 assert.equal(scheduledDue(c,Date.parse('2026-11-16T17:00:00Z')),'2026-11-16T17:00:00.000Z');
 assert.equal(scheduledDue(c,Date.parse('2026-11-17T16:00:00Z')),'2026-11-17T20:00:00.000Z');
 assert.equal(followupDue('2026-11-16T15:00:00Z',1,schedule),'2026-11-17T20:00:00.000Z');
 assert.ok(scheduleErrors({...schedule,times:{Mon:'99:00'}}).length);
 const base=defaultConfig({offering:'',tone:'Warm'});
 assert.equal(normalizeConfig(base,{schedule}).schedule.times.Tue,'15:00');
});

test('uncertain SMTP task only retries after mailbox confirmation and successful connection check',()=>setup(async ctx=>{
 const {retryUnknown}=await import('../server/delivery.mjs');
 let c=await createCampaign(ctx,{brief:{filters:{roles:['Founder']},signals:[]}});
 c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],time:'00:00',timezone:'UTC'}}});
 await seedResearch(ctx,c.id,{csv});const run=await startDiscovery(ctx,c.id);await executeDiscovery(ctx,run.id);await executeDraftRun(ctx,{campaign_id:c.id});
 const drafts=await listDrafts(ctx,c.id);await approveDrafts(ctx,{items:drafts.items.map(l=>({draft_id:l.draft.id,revision_id:l.draft.revision_id})),confirm:true});
 await ctx.db.insert('mailboxes',{workspace_id:ctx.ws,sender:ctx.user.email,postal_address:'123 Test Street',credentials:'test',updated_at:new Date().toISOString()});
 await launch(ctx,c.id,{revision:c.revision});const task=await ctx.db.get('SELECT id FROM send_tasks LIMIT 1');
 await ctx.db.run("UPDATE send_tasks SET status='unknown' WHERE id=?",[task.id]);
 await assert.rejects(retryUnknown(ctx,task.id,{},async()=>{}),/Sent mailbox/);
 await assert.rejects(retryUnknown(ctx,task.id,{mailbox_checked:true},async()=>{throw Error('connection failed')}),/connection failed/);
 assert.equal((await ctx.db.get('SELECT status FROM send_tasks WHERE id=?',[task.id])).status,'unknown');
 await retryUnknown(ctx,task.id,{mailbox_checked:true},async()=>{});
 assert.equal((await ctx.db.get('SELECT status FROM send_tasks WHERE id=?',[task.id])).status,'pending');
 await assert.rejects(retryUnknown(ctx,task.id,{mailbox_checked:true},async()=>{}),/uncertain emails/);
}));
