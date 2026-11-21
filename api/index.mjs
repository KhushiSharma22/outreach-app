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
let lastSchedule = 0, background = null, pendingKick = false, pendingSchedule = false;
const logBackground = e => console.error(JSON.stringify({ t: new Date().toISOString(), event: 'background_error', error: String(e?.stack || e) }));

export function restorePath(req) {
  const u = new URL(req.url, 'http://x');
  if (!u.searchParams.has('__path')) return;
  const path = '/' + u.searchParams.get('__path').replace(/^\/+/, '');
  u.searchParams.delete('__path');
  req.url = path + (u.searchParams.size ? '?' + u.searchParams : '');
}

export function shouldScheduleAfterRequest(method, path, status) {
  const endpoint = path.split('?')[0];
  return method === 'POST' && status >= 200 && status < 300 && (endpoint === '/api/approvals' || /^\/api\/send-tasks\/[^/]+\/retry-unknown$/.test(endpoint) || /^\/api\/campaigns\/[^/]+\/(launch|resume)$/.test(endpoint));
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
  let markHandled;
  const handled = new Promise(resolve => { markHandled = resolve; });
  // Register before the response ends. Registering after `finish` can leave the
  // platform free to freeze the function while SMTP or draft jobs are running.
  const afterResponse = (async () => {
    await handled;
    await finished;
    const kicked = app.jobs.takeKick();
    pendingKick ||= kicked;
    if (shouldScheduleAfterRequest(req.method, req.url, res.statusCode) || Date.now() - lastSchedule > SCHEDULE_EVERY_MS) { lastSchedule = Date.now(); pendingSchedule = true; }
    if ((pendingKick || pendingSchedule) && !background) {
      background = (async () => {
        while (pendingKick || pendingSchedule) {
          const schedule = pendingSchedule; pendingKick = false; pendingSchedule = false;
          if (schedule) { try { await app.scheduler(); } catch (e) { logBackground(e); } }
          await app.jobs.runDue();
        }
      })().catch(logBackground).finally(() => { background = null; });
    }
    if (background) await background;
  })().catch(logBackground);
  waitUntil(afterResponse);
  try { await app.handle(req, res); } finally { markHandled(); }
  await finished;
}
