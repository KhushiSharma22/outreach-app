import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp,seedWorkspace} from '../server/app.mjs';
process.env.NODE_ENV='test';
test('public unsubscribe requires deliberate POST and cannot cross workspaces',async()=>{
 const app=await createApp({dbFile:':memory:',workers:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
 const a=await seedWorkspace(app.db);const b=await seedWorkspace(app.db,{email:'other@example.com'});
 const token='a'.repeat(64);await app.db.insert('optout_tokens',{token,workspace_id:a.workspace.id,email:'person@example.com'});
 assert.equal((await fetch(base+'/unsubscribe/'+token)).status,200);
 assert.equal(Number((await app.db.get('SELECT count(*) n FROM suppressions')).n),0);
 for(let i=0;i<2;i++) assert.equal((await fetch(base+'/unsubscribe/'+token,{method:'POST'})).status,200);
 assert.equal(Number((await app.db.get('SELECT count(*) n FROM suppressions WHERE workspace_id=?',[a.workspace.id])).n),1);
 assert.equal(Number((await app.db.get('SELECT count(*) n FROM suppressions WHERE workspace_id=?',[b.workspace.id])).n),0);
 assert.equal((await fetch(base+'/auth/google/start')).status,404);
 assert.equal((await fetch(base+'/auth/google/callback')).status,404);
 assert.equal((await fetch(base+'/api/mailbox')).status,401);
 }finally{await app.close();}
});
