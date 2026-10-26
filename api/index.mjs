// Vercel entry point. vercel.json rewrites every non-static request here with the original path in
// ?__path=, and this hands it to the same request listener the Node server uses (server/app.mjs).
import { createApp } from '../server/app.mjs';

let appPromise;
// One app (and database pool) per function instance, reused across requests.
export const getApp = () => (appPromise ??= createApp({ workers: false, serverless: true }).catch(e => { appPromise = undefined; throw e; }));

// Same contract as waitUntil() from @vercel/functions: keeps the function running after the response.
// Outside Vercel it is a no-op and the promise simply runs.
export const waitUntil = p => globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(p);

const SCHEDULE_EVERY_MS = 60e3;
let lastSchedule = 0;
const logBackground = e => console.error(JSON.stringify({ t: new Date().toISOString(), event: 'background_error', error: String(e?.stack || e) }));

export function restorePath(req) {
  const u = new URL(req.url, 'http://x');
  if (!u.searchParams.has('__path')) return;
  const path = '/' + u.searchParams.get('__path').replace(/^\/+/, '');
  u.searchParams.delete('__path');
  req.url = path + (u.searchParams.size ? '?' + u.searchParams : '');
}

export default async function handler(req, res) {
  restorePath(req);
  let app;
  try { app = await getApp(); }
  catch (e) {
    logBackground(e);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'unavailable', message: 'The service could not start. Check the deployment logs and environment variables.' } }));
    return;
  }
  const finished = new Promise(r => { res.once('finish', r); res.once('close', r); });
  await app.handle(req, res);
  await finished;
  // Discovery and drafting queued by this request run after the response; the daily scheduler is also
  // checked here (at most once a minute per instance) so schedules don't depend on the cron alone.
  const work = [];
  if (app.jobs.takeKick()) work.push(app.jobs.runDue());
  if (Date.now() - lastSchedule > SCHEDULE_EVERY_MS) { lastSchedule = Date.now(); work.push(app.scheduler().then(() => app.jobs.runDue())); }
  if (work.length) waitUntil(Promise.all(work).catch(logBackground));
}
