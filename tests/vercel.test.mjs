// The Vercel function (api/index.mjs, api/cron.mjs) run locally: rewritten paths, background work
// via waitUntil after the response, a request body already buffered by the platform, and cron auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sampleCsv } from '../server/sample.mjs';
import { testDatabase } from './helpers.mjs';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'offline';
process.env.AUTH_MODE = 'dev';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.OPERATOR_EMAILS = 'maya@northstar.example'; // pilot: only operators import leads
const pending = [];
// Vercel's request context, as read by waitUntil().
globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: p => pending.push(p) }) };
let tdb, server, base, mod, cron, app, bufferBodies = false;

before(async () => {
  tdb = await testDatabase();
  if (tdb.databaseUrl) process.env.DATABASE_URL = tdb.databaseUrl; else process.env.DB_FILE = ':memory:';
  mod = await import('../api/index.mjs');
  cron = (await import('../api/cron.mjs')).default;
  app = await mod.getApp();
  server = createServer(async (req, res) => {
    if (bufferBodies && req.method !== 'GET') { // simulate a platform that pre-reads the body
      const chunks = []; for await (const c of req) chunks.push(c);
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    }
    return req.url.startsWith('/api/cron') ? cron(req, res) : mod.default(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); server.close(); await app.close(); await tdb.drop(); });

// Requests arrive the way vercel.json rewrites them: /api/index?__path=<original path>.
async function call(method, path, body, headers = {}) {
  const [p, q] = path.split('?');
  const res = await fetch(`${base}/api/index?__path=${encodeURIComponent(p.slice(1))}${q ? '&' + q : ''}`, { method, headers: { authorization: `Bearer ${app.devToken}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const settle = async () => { while (pending.length) await pending.shift(); };

test('rewritten paths and query strings reach the app', async () => {
  const s = await call('GET', '/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.data.workspace.name, 'Northstar');
  const leads = await call('GET', '/api/contacts?q=nobody&page=0');
  assert.equal(leads.status, 200);
  assert.equal(leads.data.total, 0);
  assert.equal((await fetch(`${base}/api/index?__path=sample-contacts.csv`)).headers.get('content-type'), 'text/csv; charset=utf-8');
});

test('discovery queued by a request finishes after the response via waitUntil', async () => {
  await settle();
  assert.equal((await call('POST', '/api/imports', { filename: 's.csv', csv: sampleCsv().trimEnd().split('\n').slice(0, 31).join('\n') + '\n' })).status, 201); // 30 qualifying people (pilot cap)
  let c = (await call('POST', '/api/campaigns', { name: 'Vercel run', source:'import' })).data;
  c = (await call('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision, config: { filters: { roles: ['Founder', 'Head of Growth'], industries: ['B2B SaaS'] }, signals: ['Hiring', 'Funding', 'New leadership', 'Expansion'] } })).data;
  const run = await call('POST', `/api/campaigns/${c.id}/discovery-runs`);
  assert.equal(run.status, 202);
  assert.ok(pending.length, 'background work was handed to waitUntil');
  await settle();
  const done = (await call('GET', `/api/runs/${run.data.id}`)).data;
  assert.equal(done.status, 'completed');
  assert.ok(done.qualified > 25);
});

test('a request body already read by the platform is used', async () => {
  bufferBodies = true;
  try {
    const c = await call('POST', '/api/campaigns', { name: 'Buffered body' });
    assert.equal(c.status, 201);
    assert.equal(c.data.name, 'Buffered body');
  } finally { bufferBodies = false; }
});

test('cron requires the secret, then runs the scheduler and requeues jobs cut off mid-run', async () => {
  await settle();
  assert.equal((await fetch(`${base}/api/cron`)).status, 401);
  assert.equal((await fetch(`${base}/api/cron`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  // A job left "running" by a function that hit its time limit.
  const c = (await call('POST', '/api/campaigns', { name: 'Stuck job' })).data;
  const job = await app.jobs.enqueue(c.workspace_id, 'drafts', { campaign_id: c.id });
  app.jobs.takeKick();
  await app.db.run("UPDATE jobs SET status='running', locked_at=? WHERE id=?", [new Date(Date.now() - 3600e3).toISOString(), job.id]);
  const r = await fetch(`${base}/api/cron`, { headers: { authorization: 'Bearer test-cron-secret' } });
  assert.equal(r.status, 200);
  assert.equal((await app.db.get('SELECT status FROM jobs WHERE id=?', [job.id])).status, 'done');
});


test('successful approval requests trigger an immediate scheduling check', () => {
  assert.equal(mod.shouldScheduleAfterRequest('POST','/api/approvals',200),true);
  assert.equal(mod.shouldScheduleAfterRequest('POST','/api/approvals?foo=1',200),true);
  assert.equal(mod.shouldScheduleAfterRequest('POST','/api/approvals',403),false);
  assert.equal(mod.shouldScheduleAfterRequest('GET','/api/approvals',200),false);
  assert.equal(mod.shouldScheduleAfterRequest('POST','/api/campaigns',200),false);
});
