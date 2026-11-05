import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {encrypt,decrypt,connect,status,connectionFailure} from '../server/mailbox.mjs';
import {openDb} from '../server/db.mjs';
import {seedWorkspace} from '../server/app.mjs';
test('authenticated encryption rejects swapped tenants, tampering and changed keys',()=>{
 process.env.MAILBOX_KEY=randomBytes(32).toString('base64');const secret={auth:{pass:'never-log-this'}};
 const a=encrypt(secret,'tenant-a'),b=encrypt(secret,'tenant-a');assert.notEqual(a,b);assert.ok(!a.includes('never-log-this'));assert.deepEqual(decrypt(a,'tenant-a'),secret);
 assert.throws(()=>decrypt(a,'tenant-b'));const parts=a.split('.');parts[3]=Buffer.from('tampered').toString('base64');assert.throws(()=>decrypt(parts.join('.'),'tenant-a'));
 process.env.MAILBOX_KEY=randomBytes(32).toString('base64');assert.throws(()=>decrypt(a,'tenant-a'));
 delete process.env.MAILBOX_KEY;assert.throws(()=>encrypt(secret,'tenant-a'));
});
test('SMTP setup protects secrets, verifies sender, and preserves previous connection on failure',async()=>{
 process.env.MAILBOX_KEY=randomBytes(32).toString('base64');process.env.SMTP_ALLOWED_HOSTS='smtp.example.com';
 const db=await openDb({file:':memory:'});try{
 const {workspace,user}=await seedWorkspace(db);const ctx={db,ws:workspace.id,user};
 const body={host:'smtp.example.com',port:587,user:'smtp-user',password:'app-secret',sender:user.email,postal_address:'123 Business Street'};
 let sent;const fake=options=>{assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);return {verify:async()=>{},sendMail:async msg=>{sent=msg;},close(){}};};
 const saved=await connect(ctx,body,fake);assert.equal(saved.sender,user.email);assert.equal(sent.to,user.email);assert.ok(!JSON.stringify(saved).includes('app-secret'));
 const row=await db.get('SELECT * FROM mailboxes WHERE workspace_id=?',[ctx.ws]);assert.ok(!row.credentials.includes('app-secret'));assert.equal(decrypt(row.credentials,ctx.ws).auth.pass,'app-secret');
 await assert.rejects(connect({...ctx,user:{...user,role:'member'}},body,fake),/owner/);
 await assert.rejects(connect(ctx,{...body,sender:'other@example.com'},fake),/Company context/);
 await assert.rejects(connect(ctx,{...body,host:'127.0.0.1'},fake),/approved/);
 await assert.rejects(connect(ctx,{...body,password:'new-secret'},()=>({verify:async()=>{throw Error('raw-secret-error');},close(){}})),e=>!e.message.includes('raw-secret-error'));
 assert.equal((await db.get('SELECT credentials FROM mailboxes WHERE workspace_id=?',[ctx.ws])).credentials,row.credentials);
 assert.equal((await status({...ctx,ws:'different-tenant'})).sender,null);
 }finally{await db.close();}
});

test('SMTP errors explain the failed stage without exposing provider responses',()=>{
 for(const [code,expected] of [['EAUTH',/login was rejected/],['ETIMEDOUT',/Could not reach/],['ETLS',/secure SMTP/]]) {
 const e=connectionFailure({code,message:'secret-password',response:'private-provider-response'},'verify');
 assert.match(e.message,expected);assert.ok(!e.message.includes('secret-password'));assert.ok(!e.message.includes('private-provider-response'));
 }
 assert.match(connectionFailure({},'send').message,/login succeeded/);
 assert.match(connectionFailure({},'verify').message,/verification failed/);
});
