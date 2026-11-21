// Authenticated Vercel Schedule: only weekly campaigns can be dispatched.
import { createHash, timingSafeEqual } from 'node:crypto';
import { getApp } from './index.mjs';
const digest = value => createHash('sha256').update(String(value)).digest();
export default async function weeklyCron(req, res) {
 const secret = process.env.CRON_SECRET;
 res.setHeader('content-type','application/json');
 if (!secret || !timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${secret}`))) { res.statusCode=401;res.end(JSON.stringify({error:'Unauthorized'}));return; }
 const app=await getApp();
 await app.scheduler({weeklyOnly:true});
 res.end(JSON.stringify({ok:true}));
}
