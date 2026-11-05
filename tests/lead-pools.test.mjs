import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign} from '../server/campaigns.mjs';
import {seedResearch,uploadForCampaign,previewUpload,sourceStatus} from '../server/lead-pools.mjs';
import {startDiscovery,executeDiscovery} from '../server/sourcing.mjs';
const csv=(n,offset=0,status='valid')=>'first_name,last_name,email,company,role,employees,location,email_status\n'+Array.from({length:n},(_,i)=>`Person${i+offset},Test,p${i+offset}@example.com,C${i+offset},Founder,5,India,${status}`).join('\n');
async function setup(fn){process.env.AI_PROVIDER='offline';const db=await openDb({file:':memory:'});try{const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user,jobs:{enqueue:async()=>{}}};const make=async(source='research')=>{let c=await createCampaign(ctx,{source,brief:{filters:{roles:['Founder'],locations:['India'],sizes:['1–10']},signals:[]}});return updateCampaign(ctx,c.id,{revision:c.revision,config:{target:3}})};await fn(ctx,make);}finally{await db.close()}}
test('research is prequalified, scoped, target-limited, and limited to one campaign each day',()=>setup(async(ctx,make)=>{
 const a=await make(),b=await make();
 assert.equal(a.config.source,'research');
 await seedResearch(ctx,a.id,{csv:csv(8)});await seedResearch(ctx,b.id,{csv:csv(3,100)});
 assert.equal((await sourceStatus(ctx,a.id)).research_ready,8);
 const run=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,run.id);
 assert.equal((await ctx.db.get('SELECT candidates FROM discovery_runs WHERE id=?',[run.id])).candidates,3);
 await assert.rejects(startDiscovery(ctx,a.id),e=>e.code==='daily_limit');
 await assert.rejects(startDiscovery(ctx,b.id),e=>e.code==='research_campaign_limit');
 assert.equal((await sourceStatus(ctx,b.id)).other_campaign_today,true);
 await executeDiscovery(ctx,run.id);assert.equal(Number((await ctx.db.get('SELECT count(*) n FROM campaign_contact_claims')).n),3);
}));
test('research rejects unverified supply and rechecks changed filters and suppression',()=>setup(async(ctx,make)=>{
 let a=await make();const bad=await seedResearch(ctx,a.id,{csv:csv(1,200,'unverified')});assert.equal(bad.ready,0);
 await seedResearch(ctx,a.id,{csv:csv(2)});
 await ctx.db.insert('suppressions',{id:'s',workspace_id:ctx.ws,email:'p0@example.com',reason:'opt_out',created_at:new Date().toISOString()});
 assert.equal((await sourceStatus(ctx,a.id)).research_ready,1);
 a=await updateCampaign(ctx,a.id,{revision:a.revision,config:{filters:{locations:['United States']}}});
 await assert.rejects(startDiscovery(ctx,a.id),e=>e.code==='no_new_contacts');
 assert.equal(Number((await ctx.db.get('SELECT count(*) n FROM research_days')).n),0);
}));
test('customer uploads preview, deduplicate and remain unverified and campaign-specific',()=>setup(async(ctx,make)=>{
 const a=await make('upload'),b=await make('upload');const data=csv(2);
 const p=previewUpload({csv:data+'\n'+data.split('\n')[1]});assert.equal(p.valid,2);assert.equal(p.duplicates,1);
 assert.throws(()=>previewUpload({csv:'first_name,email\nA,a@example.com'}),/Required columns/);
 assert.equal(previewUpload({csv:csv(1).replace('p0@example.com','bad')}).errors.length,1);
 const imported=await uploadForCampaign(ctx,a.id,{csv:data,filename:'Mine.csv'});assert.equal(imported.linked,2);
 assert.equal((await sourceStatus(ctx,b.id)).uploaded_ready,0);
 await assert.rejects(startDiscovery(ctx,b.id),e=>e.code==='no_new_contacts');
 const run=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,run.id);
 assert.equal(Number((await ctx.db.get("SELECT count(*) n FROM campaign_leads WHERE decision='review'")).n),2);
 assert.equal(Number((await ctx.db.get('SELECT count(*) n FROM research_days')).n),0);
 const other=await seedWorkspace(ctx.db,{email:'other@tenant.example'});
 await assert.rejects(uploadForCampaign({...ctx,ws:other.workspace.id},a.id,{csv:data}));
}));

test('partial research batches can be topped up without exceeding target; future supply stays hidden',()=>setup(async(ctx,make)=>{
 const a=await make();await seedResearch(ctx,a.id,{csv:csv(1)});
 const r=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,r.id);
 await seedResearch(ctx,a.id,{csv:csv(4,10)});
 const r2=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,r2.id);
 assert.equal(Number((await ctx.db.get('SELECT allocated FROM research_days')).allocated),3);
 assert.equal((await sourceStatus(ctx,a.id)).daily_remaining,0);
 const b=await make();await seedResearch(ctx,b.id,{csv:csv(1,30),available_on:'2099-01-01'});
 assert.equal((await sourceStatus(ctx,b.id)).research_ready,0);
}));

test('simultaneous research requests only allocate one campaign',()=>setup(async(ctx,make)=>{
 const a=await make(),b=await make();await seedResearch(ctx,a.id,{csv:csv(3)});await seedResearch(ctx,b.id,{csv:csv(3,10)});
 const outcomes=await Promise.allSettled([startDiscovery(ctx,a.id),startDiscovery(ctx,b.id)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'research_campaign_limit');
 assert.equal(Number((await ctx.db.get('SELECT count(*) n FROM campaign_contact_claims')).n),3);
}));

test('prepared discovery does not call AI; general company research reaches email drafts',()=>setup(async(ctx,make)=>{
 const {shapeLead,getLead}=await import('../server/drafts.mjs');
 const a=await make();
 await seedResearch(ctx,a.id,{csv:csv(1)+''});
 const {importCsv}=await import('../server/sourcing.mjs');
 await importCsv(ctx,{csv:'first_name,last_name,email,company,research_fact,research_url\nPerson0,Test,p0@example.com,C0,Offers refillable skincare packaging,https://example.com/products'});
 const run=await startDiscovery(ctx,a.id);await executeDiscovery(ctx,run.id);
 assert.equal(Number((await ctx.db.get("SELECT count(*) n FROM ai_calls WHERE operation='assess'")).n),0);
 const l=await ctx.db.get('SELECT id,assessed_by FROM campaign_leads WHERE campaign_id=?',[a.id]);assert.equal(l.assessed_by,'rules');
 const shaped=await shapeLead(ctx,await getLead(ctx,l.id));
 assert.ok(shaped.evidence.some(e=>e.fact==='Offers refillable skincare packaging'));
}));
