// Vercel Cron endpoint (schedule in vercel.json): runs the daily scheduler and any queued jobs.
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is rejected.
import { createHash, timingSafeEqual } from 'node:crypto';
import { getApp } from './index.mjs';

const digest = v => createHash('sha256').update(String(v)).digest();

export default async function cron(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !!secret && timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${secret}`));
  res.setHeader('content-type', 'application/json');
  if (!ok) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'unauthorized', message: secret ? 'Unauthorized.' : 'Set CRON_SECRET.' } })); return; }
  const app = await getApp();
  const started = Date.now();
  await app.scheduler();
  await app.jobs.runDue(250e3);
  res.end(JSON.stringify({ ok: true, ms: Date.now() - started }));
}
