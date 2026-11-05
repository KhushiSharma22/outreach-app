import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.mjs';
import {createAuth} from '../server/auth.mjs';
test('local signup and existing login skip email confirmation; production still requires it',async()=>{
 const db=await openDb({file:':memory:'});process.env.ALLOWED_EMAILS='local@example.com';process.env.LOCAL_SKIP_EMAIL_VERIFICATION='true';process.env.NODE_ENV='test';
 const auth=createAuth({db,publicUrl:'http://127.0.0.1:4191'}),out={setCookie(){}},req={headers:{},socket:{remoteAddress:'127.0.0.1'}};
 const body={name:'Tester',email:'local@example.com',password:'Different!Password992'};
 try{
 assert.equal((await auth.signup(out,req,body)).status,'signed_in');assert.equal((await auth.login(out,req,body)).status,'signed_in');assert.equal((await auth.signup(out,req,body)).status,'signed_in');
 assert.equal((await db.get('SELECT email_verified_at FROM users')).email_verified_at,null);
 await assert.rejects(auth.signup(out,req,{...body,email:'outsider@example.com'}),/private pilot/);
 process.env.NODE_ENV='production';await assert.rejects(auth.login(out,req,body),/Confirm your email/);
 }finally{process.env.NODE_ENV='test';await db.close();}
});
