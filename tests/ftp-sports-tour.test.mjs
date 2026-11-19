import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
import {createCampaign,saveContext,currentContext,newWorkspaceContext} from '../server/campaigns.mjs';
import {checkCandidate} from '../server/sourcing.mjs';

test('FTP tour preset targets North American soccer decision makers without unrelated filters',async()=>{
 const db=await openDb({file:':memory:'});
 try{
  const {workspace,user}=await seedWorkspace(db,{name:'FTP'});const ctx={db,ws:workspace.id,user};
  const before=await currentContext(ctx);
  await saveContext(ctx,{version:before.version,data:{...before.data,company:'FTP',exclusions:''}});
  const c=await createCampaign(ctx,{preset:'ftp-soccer-tours'});
  assert.deepEqual(c.config.filters.locations,['United States','Canada']);
  assert.deepEqual(c.config.filters.exclude,[]);assert.deepEqual(c.config.filters.sizes,[]);assert.deepEqual(c.config.signals,[]);
  assert.match(c.config.offer,/tournament/);assert.match(c.config.notes,/tailored tour or tournament quote/);
  const lead={role:'Director of Coaching',industry:'Youth Soccer Academy',location:'Toronto, Canada',company:'Example Academy',email:'coach@example.com',email_status:'valid'};
  assert.equal(checkCandidate(ctx,c.config,c.context.data,lead,[],'2026-11-19').decision,'qualified');
  assert.equal(checkCandidate(ctx,c.config,c.context.data,{...lead,role:'Head Coach',location:'Boston, USA'},[],'2026-11-19').decision,'qualified');
  assert.equal(checkCandidate(ctx,c.config,c.context.data,{...lead,location:'London, United Kingdom'},[],'2026-11-19').decision,'excluded');
  assert.equal(checkCandidate(ctx,c.config,c.context.data,{...lead,email_status:'unverified'},[],'2026-11-19').decision,'review');
  assert.equal(checkCandidate(ctx,c.config,c.context.data,{...lead,suppressed:'opt_out'},[],'2026-11-19').decision,'excluded');
  const other=await seedWorkspace(db,{name:'Other',email:'other@example.com'});
  await assert.rejects(createCampaign({db,ws:other.workspace.id,user:other.user},{preset:'ftp-soccer-tours'}),/FTP workspace/);
 }finally{await db.close();}
});

test('FTP onboarding uses the supplied tour context without changing other workspaces',()=>{
 const ftp=newWorkspaceContext({company:'FTP',name:'Alex Example',email:'alex@example.com'});
 assert.match(ftp.offering,/soccer tours/);assert.match(ftp.icp,/United States and Canada/);assert.match(ftp.proof,/dedicated tour manager/);assert.equal(ftp.website,'');assert.equal(ftp.exclusions,'');assert.equal(ftp.signature,'Alex Example\nFTP');
 const other=newWorkspaceContext({company:'Other',name:'Alex Example',email:'alex@example.com'});assert.equal(other.offering,'');assert.equal(other.icp,'');
});
