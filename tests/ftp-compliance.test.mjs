import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,updateCampaign,currentContext,saveContext} from '../server/campaigns.mjs';
import {seedResearch} from '../server/lead-pools.mjs';
import {importCsv} from '../server/sourcing.mjs';
import {startDiscovery,executeDiscovery} from '../server/sourcing.mjs';
import {executeDraftRun,listDrafts,approveDrafts} from '../server/drafts.mjs';
import {blockers,launch,listTasks,smtpSend} from '../server/delivery.mjs';
import {draftPrompt} from '../server/ai-prompts.mjs';
import {checkFtpDraft} from '../server/ai.mjs';

test('FTP Canadian sends require a reviewed basis, remain blocked when expired, and include sender and unsubscribe headers',async()=>{
 const db=await openDb({file:':memory:'});process.env.AI_PROVIDER='offline';
 try{
  const {workspace,user}=await seedWorkspace(db,{name:'FTP',userName:'James',email:'james@example.com'});
  const ctx={db,ws:workspace.id,user,publicUrl:'https://app.example.com',jobs:{enqueue:async()=>{}}};
  const initial=await currentContext(ctx);await saveContext(ctx,{version:initial.version,data:{...initial.data,company:'FTP',exclusions:''}});
  let c=await createCampaign(ctx,{preset:'ftp-soccer-tours'});
  c=await updateCampaign(ctx,c.id,{revision:c.revision,config:{delivery:'smtp',schedule:{days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],time:'00:00',timezone:'UTC'}}});
  const csv='first_name,last_name,email,company,role,industry,location,email_status,quality_score,casl_basis,casl_evidence,casl_source_url,casl_expires_on\n'+
   'Alex,Test,alex@example.com,Academy One,Head Coach,Soccer Academy,Canada,valid,100,,,,\n'+
   'Sam,Test,sam@example.com,Academy Two,Head Coach,Soccer Academy,United States,valid,100,,,,';
  const prepared=await seedResearch(ctx,c.id,{csv});assert.equal(prepared.ready,2);
  const run=await startDiscovery(ctx,c.id);await executeDiscovery(ctx,run.id);await executeDraftRun(ctx,{campaign_id:c.id});
  const drafts=await listDrafts(ctx,c.id);await approveDrafts(ctx,{items:drafts.items.map(x=>({draft_id:x.draft.id,revision_id:x.draft.revision_id})),confirm:true});
  await db.insert('mailboxes',{workspace_id:ctx.ws,sender:user.email,postal_address:'123 Test Street',credentials:'not-used',updated_at:new Date().toISOString()});
  assert.ok((await blockers(ctx,c)).some(x=>x.code==='contact_authorization'));
  await assert.rejects(launch(ctx,c.id,{revision:c.revision}),/consent\/exemption/);
  const canadian=await db.get('SELECT id FROM contacts WHERE email=?',['alex@example.com']);
  await db.insert('casl_authorizations',{workspace_id:ctx.ws,contact_id:canadian.id,email:'alex@example.com',basis:'express',evidence:'Explicit opt-in recorded in test',source_url:null,expires_on:null,reviewed_by:user.id,reviewed_at:new Date().toISOString()});
  assert.ok(!(await blockers(ctx,c)).some(x=>x.code==='contact_authorization'));
  await launch(ctx,c.id,{revision:c.revision});
  const task=(await listTasks(ctx,{campaign_id:c.id})).items.find(x=>x.to_email==='alex@example.com');
  await db.run('UPDATE casl_authorizations SET expires_on=? WHERE contact_id=?',['2001-01-01',canadian.id]);
  const sent=[];const fake=async()=>({row:{sender:user.email,postal_address:'123 Test Street'},client:{sendMail:async m=>sent.push(m),close(){}}});
  await assert.rejects(smtpSend(ctx,task.id,ctx.publicUrl,{},fake),e=>e.code==='blocked');assert.equal(sent.length,0);
  await db.run('UPDATE casl_authorizations SET expires_on=NULL WHERE contact_id=?',[canadian.id]);
  await smtpSend(ctx,task.id,ctx.publicUrl,{},fake);assert.equal(sent.length,1);
  assert.match(sent[0].text,/Business marketing message from FTP/);assert.match(sent[0].text,/Contact: james@example.com/);assert.match(sent[0].text,/123 Test Street/);
  assert.match(sent[0].headers['List-Unsubscribe'],/^<https:\/\/app\.example\.com\/unsubscribe\//);assert.equal(sent[0].headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
 }finally{await db.close()}
});

test('FTP drafting guidance is specific while other clients remain generic',()=>{
 const args={context:{company:'FTP',offering:'soccer tours',proof:'',icp:'',signature:'James'},config:{offer:'soccer tours',notes:'',writing:{}},lead:{first_name:'Alex',name:'Alex',role:'Coach',company:'Academy'},evidence:[]};
 const ftp=draftPrompt(args);assert.match(ftp,/North American English/);assert.match(ftp,/tailored quote/);assert.match(ftp,/do not invent personalization/);
 assert.doesNotMatch(draftPrompt({...args,context:{...args.context,company:'Other'}}),/FTP soccer tour outreach/);
});

test('FTP guard catches invented guarantees and blanket package claims',()=>{
 const context={company:'FTP'};
 assert.ok(checkFtpDraft({subject:'Tour',body:'Every trip comes with professional training.'},context).length);
 assert.ok(checkFtpDraft({subject:'Guaranteed tournament access',body:'Hello'},context).length);
 assert.equal(checkFtpDraft({subject:'Tour options',body:'We offer opportunities for professional training.'},context).length,0);
 assert.equal(checkFtpDraft({subject:'Guaranteed delivery',body:'Every trip includes training.'},{company:'Other'}).length,0);
});

test('import records only sufficiently documented Canadian authorization and binds it to the email',async()=>{
 const db=await openDb({file:':memory:'});try{
  const {workspace,user}=await seedWorkspace(db,{name:'FTP'});const ctx={db,ws:workspace.id,user};
  const header='first_name,last_name,email,company,casl_basis,casl_evidence,casl_source_url,casl_expires_on\n';
  const invalid=await importCsv(ctx,{csv:header+'Alex,Test,alex@example.com,Academy,implied_publication,Source reviewed with no opt out notice,,2099-01-01'});
  assert.ok(invalid.rejected.some(x=>x.partial));assert.equal((await db.get('SELECT count(*) n FROM casl_authorizations')).n,0);
  const good=await importCsv(ctx,{csv:header+'Alex,Test,alex@example.com,Academy,implied_publication,Source reviewed with no opt out notice,https://example.com/contact,2099-01-01'});
  assert.equal(good.rejected.length,0);const record=await db.get('SELECT * FROM casl_authorizations');
  assert.equal(record.email,'alex@example.com');assert.equal(record.basis,'implied_publication');assert.equal(record.reviewed_by,user.id);
 }finally{await db.close()}
});
