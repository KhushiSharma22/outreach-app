import * as leadPools from './lead-pools.mjs';
// HTTP API and static file server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, id, now, hash } from './db.mjs';
import { AppError, notFound, invalid, json } from './lib.mjs';
import { runAi, getProvider, CATALOG } from './ai.mjs';
import * as campaigns from './campaigns.mjs';
import * as sourcing from './sourcing.mjs';
import * as drafts from './drafts.mjs';
import * as sequences from './sequences.mjs';
import * as mailbox from './mailbox.mjs';
import * as delivery from './delivery.mjs';
import * as reporting from './reporting.mjs';
import { createJobs, registerHandlers, runScheduler } from './jobs.mjs';
import { sampleCsv } from './sample.mjs';
import { createAuth, sessionFromToken, SESSION_COOKIE } from './auth.mjs';
import * as admin from './admin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = join(ROOT, 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const log = (event, data = {}) => (process.env.NODE_ENV !== 'test' || (process.env.DEBUG_ERRORS && /error|failed/.test(event))) && console.log(JSON.stringify({ t: now(), event, ...data }));

export async function seedWorkspace(db, { name = 'Northstar', userName = 'Maya', email = 'maya@northstar.example', token = randomBytes(24).toString('base64url') } = {}) {
  const ws = { id: id(), name, sending_stopped: 0, created_at: now() };
  const user = { id: id(), workspace_id: ws.id, name: userName, email, role: 'owner', token_hash: hash(token), created_at: now(), email_verified_at: now() };
  await db.tx(async () => {
    await db.insert('workspaces', ws);
    await db.insert('users', user);
    await db.insert('memberships', { workspace_id: ws.id, user_id: user.id, role: 'owner', invited_by: null, created_at: now() });
    await db.insert('account_context_versions', { id: id(), workspace_id: ws.id, version: 1, data: JSON.stringify({ ...campaigns.DEFAULT_CONTEXT, company: name, sender: userName, email }), created_by: user.id, created_at: now() });
  });
  return { workspace: ws, user, token };
}

export async function createApp({ databaseUrl = process.env.DATABASE_URL || null, dbFile = process.env.DB_FILE || join(ROOT, 'data', 'outreach.db'), workers = true, serverless = !!process.env.VERCEL, authMode = process.env.AUTH_MODE || 'accounts',
  publicUrl = process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://127.0.0.1:${process.env.PORT || 4173}`) } = {}) {
  if (authMode === 'dev' && (process.env.NODE_ENV === 'production' || process.env.VERCEL)) throw new Error('Development authentication is forbidden in production.');
  if (process.env.VERCEL && !databaseUrl) throw new Error('DATABASE_URL is required on Vercel: serverless functions have no persistent disk for SQLite.');
  const db = await openDb(databaseUrl ? { url: databaseUrl } : { file: dbFile });
  const jobs = createJobs(db, log, { serverless });
  const ctxFor = (ws, user = null) => ({ db, ws, user, jobs });
  registerHandlers(jobs, db, ws => ctxFor(ws));

  publicUrl = publicUrl.replace(/\/+$/, '');
  const auth = createAuth({ db, publicUrl });
  // AUTH_MODE=dev seeds a demo workspace and issues an API bearer token for scripts and tests.
  let devToken = null;
  if (authMode === 'dev') {
    const tokenFile = dbFile === ':memory:' ? null : join(dirname(dbFile), '.dev-token');
    const saved = tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null;
    if (saved && await db.get('SELECT 1 FROM users WHERE token_hash=?', [hash(saved)])) devToken = saved;
    else if (!await db.get('SELECT 1 FROM workspaces LIMIT 1')) { devToken = (await seedWorkspace(db)).token; if (tokenFile) writeFileSync(tokenFile, devToken, { mode: 0o600 }); }
    else { // keep the existing workspace; reissue its owner's token
      devToken = randomBytes(24).toString('base64url');
      await db.run("UPDATE users SET token_hash=? WHERE id=(SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1)", [hash(devToken)]);
      if (tokenFile) writeFileSync(tokenFile, devToken, { mode: 0o600 });
    }
  }

  // Browser sessions use an HttpOnly cookie; API clients may use a bearer token.
  const authenticate = async req => {
    const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      const user = await db.get('SELECT u.*, m.role member_role FROM users u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=u.workspace_id WHERE u.token_hash=?', [hash(bearer)]);
      return user && (authMode === 'dev' || await admin.isApproved(db, user.email)) ? { user: { ...user, role: user.member_role }, ws: user.workspace_id, viaCookie: false } : null;
    }
    const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
    let token = null; try { token = raw && decodeURIComponent(raw); } catch { /* malformed cookie */ }
    const s = await sessionFromToken(db, token);
    return s ? { user: s.user, session: s.session, ws: s.session.workspace_id, viaCookie: true } : null;
  };

  const R = [];
  const route = (method, path, handler, opts = {}) => R.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

  // ---------- Accounts (public routes work without a session) ----------
  route('GET', '/api/auth/config', () => auth.config(), { public: true });
  route('POST', '/api/auth/signup', async (ctx, p, body, q, x) => await auth.signup(x.out, x.req, body), { public: true });
  route('POST', '/api/auth/login', async (ctx, p, body, q, x) => await auth.login(x.out, x.req, body), { public: true });
  route('POST', '/api/auth/logout', async (ctx, p, body, q, x) => await auth.logout(x.out, x.req, x.auth), { public: true });
  route('POST', '/api/auth/verify-email', async (ctx, p, body, q, x) => await auth.verifyEmail(x.out, x.req, body), { public: true });
  route('POST', '/api/auth/resend-verification', async (ctx, p, body, q, x) => await auth.resendVerification(x.req, body), { public: true });
  route('POST', '/api/auth/forgot-password', async (ctx, p, body, q, x) => await auth.forgotPassword(x.req, body), { public: true });
  route('POST', '/api/auth/reset-password', async (ctx, p, body, q, x) => await auth.resetPassword(x.out, x.req, body), { public: true });
  route('POST', '/api/auth/invite-preview', async (ctx, p, body) => await auth.invitePreview(body), { public: true });
  route('POST', '/api/auth/accept-invite', async (ctx, p, body, q, x) => await auth.acceptInvite(ctx, x.auth, body));
  route('POST', '/api/auth/switch-workspace', async (ctx, p, body, q, x) => await auth.switchWorkspace(ctx, x.auth, body));
  route('POST', '/api/auth/change-password', async (ctx, p, body, q, x) => await auth.changePassword(ctx, x.out, x.req, body));
  route('POST', '/api/auth/logout-all', async (ctx, p, body, q, x) => await auth.logoutAll(ctx, x.out));
  route('GET', '/api/team', async ctx => await auth.team(ctx));
  route('POST', '/api/team/invites', async (ctx, p, body) => await auth.invite(ctx, body), { status: 201 });
  route('DELETE', '/api/team/invites/:id', async (ctx, p) => await auth.revokeInvite(ctx, p.id));
  route('DELETE', '/api/team/members/:id', async (ctx, p) => await auth.removeMember(ctx, p.id));

  // ---------- Super-admin portal: pilot access ----------
  route('GET', '/api/admin/people', ctx => admin.listPeople(ctx));
  route('POST', '/api/admin/people', (ctx, p, body) => admin.addPeople(ctx, body, publicUrl), { status: 201 });
  route('PATCH', '/api/admin/people/:email', (ctx, p, body) => admin.updatePerson(ctx, p.email, body));
  route('DELETE', '/api/admin/people/:email', (ctx, p) => admin.removePerson(ctx, p.email));
  route('GET', '/api/admin/log', ctx => admin.adminLog(ctx));

  route('GET', '/api/session', async (ctx, p, b, q, x) => {
    const pr = await getProvider();
    const ws = await db.get('SELECT * FROM workspaces WHERE id=?', [ctx.ws]);
    return { ...await auth.session(ctx, x.auth), workspace: { id: ws.id, name: ws.name, sending_stopped: !!ws.sending_stopped }, ai: { provider: pr.name, model: pr.model }, delivery: 'manual', catalog: CATALOG };
  });
  route('GET', '/api/summary', async ctx => await reporting.workspaceSummary(ctx));
  route('GET', '/api/account-context', async ctx => await campaigns.currentContext(ctx));
  route('PATCH', '/api/account-context', async (ctx, p, body) => await campaigns.saveContext(ctx, body));
  route('POST', '/api/campaign-briefs/interpret', async (ctx, p, body) => {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw invalid('Describe the audience or campaign you have in mind.', { prompt: 'Required.' });
    if (prompt.length > 4000) throw invalid('Keep the brief under 4,000 characters.');
    const context = (await campaigns.currentContext(ctx)).data;
    const { out, provider, model, degraded } = await runAi(db, ctx.ws, 'interpret', pr => pr.interpretBrief({ prompt, context }));
    const arr = v => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12) : [];
    return { prompt, name: String(out.name || '').slice(0, 80), filters: Object.fromEntries(['roles', 'industries', 'locations', 'sizes', 'seniority', 'exclude'].map(k => [k, arr(out.filters?.[k])])), signals: arr(out.signals).filter(s => CATALOG.signals.includes(s)), notes: String(out.notes || '').slice(0, 1000), clarifications: arr(out.clarifications), summary: String(out.summary || ''), provider, model, degraded: degraded || null };
  });

  const campaignView = async (ctx, c) => ({ ...c, blockers: await delivery.blockers(ctx, c), latest_run: await db.get('SELECT * FROM discovery_runs WHERE campaign_id=? ORDER BY batch DESC LIMIT 1', [c.id]) || null, sequence: await db.get('SELECT id, status FROM sequences WHERE campaign_id=?', [c.id]) || null });
  route('GET', '/api/campaigns', async ctx => ({ items: await campaigns.listCampaigns(ctx) }));
  route('POST', '/api/campaigns', async (ctx, p, body) => await campaignView(ctx, await campaigns.createCampaign(ctx, body)), { status: 201 });
  route('GET', '/api/campaigns/:id', async (ctx, p) => await campaignView(ctx, await campaigns.loadCampaign(ctx, p.id)));
  route('PATCH', '/api/campaigns/:id', async (ctx, p, body) => await campaignView(ctx, await campaigns.updateCampaign(ctx, p.id, body)));
  route('GET', '/api/admin/research-campaigns', async ctx=>{
    if(!admin.isSuperAdmin(ctx.user.email))throw new AppError(403,'super_admin_only','Only super admins can prepare research lists.');
    return {items:await db.all("SELECT c.id,c.name,c.workspace_id,w.name workspace,(SELECT u.email FROM users u WHERE u.workspace_id=w.id AND u.role='owner' ORDER BY u.created_at LIMIT 1) owner_email FROM campaigns c JOIN workspaces w ON w.id=c.workspace_id WHERE c.status<>'stopped' ORDER BY c.created_at DESC")};
  });
  route('POST', '/api/admin/campaigns/:id/research-preview', async (ctx,p,body)=>{
    if(!admin.isSuperAdmin(ctx.user.email))throw new AppError(403,'super_admin_only','Only super admins can prepare research lists.');
    const c=await db.get('SELECT workspace_id FROM campaigns WHERE id=?',[p.id]);if(!c)throw notFound('Campaign');
    await campaigns.loadCampaign({...ctx,ws:c.workspace_id},p.id);
    const {accepted,...preview}=leadPools.previewUpload(body);
    if(preview.total>150)throw invalid('Upload at most 150 contacts per weekly file.');
    return preview;
  });
  route('POST', '/api/admin/campaigns/:id/research', async (ctx,p,body)=>{
    if(!admin.isSuperAdmin(ctx.user.email))throw new AppError(403,'super_admin_only','Only super admins can prepare research lists.');
    const c=await db.get('SELECT workspace_id FROM campaigns WHERE id=?',[p.id]);if(!c)throw notFound('Campaign');
    const preview=leadPools.previewUpload(body);
    if(preview.total>150)throw invalid('Upload at most 150 contacts per weekly file.');
    if(preview.errors.length||!preview.valid)throw invalid('Fix invalid rows before uploading research.');
    return leadPools.seedResearch({...ctx,ws:c.workspace_id},p.id,body);
  },{status:201,idem:true});
  route('GET', '/api/campaigns/:id/sources', async (ctx,p)=>leadPools.sourceStatus(ctx,p.id));
  route('POST', '/api/campaigns/:id/import-preview', async (ctx,p,body)=>{await campaigns.loadCampaign(ctx,p.id);const {accepted,...preview}=leadPools.previewUpload(body);return preview;});
  route('POST', '/api/campaigns/:id/imports', async (ctx,p,body)=>leadPools.uploadForCampaign(ctx,p.id,body), {status:201,idem:true});
  route('POST', '/api/campaigns/:id/discovery-runs', async (ctx, p) => await sourcing.startDiscovery(ctx, p.id), { idem: true, status: 202 });
  route('GET', '/api/campaigns/:id/batches', async (ctx, p) => ({ items: await sourcing.listRuns(ctx, p.id) }));
  route('GET', '/api/runs/:id', async (ctx, p) => await sourcing.getRun(ctx, p.id));
  route('GET', '/api/campaigns/:id/leads', async (ctx, p, b, q) => await drafts.listLeads(ctx, p.id, q));
  route('POST', '/api/campaigns/:id/lead-selection', async (ctx, p, body) => await drafts.selectLeads(ctx, p.id, body));
  route('PATCH', '/api/campaign-leads/:id', async (ctx, p, body) => await drafts.updateLead(ctx, p.id, body));
  route('POST', '/api/campaigns/:id/draft-runs', async (ctx, p, body) => { const j = await drafts.startDraftRun(ctx, p.id, body); return { job_id: j.id, status: j.status }; }, { idem: true, status: 202 });
  route('GET', '/api/campaigns/:id/drafts', async (ctx, p) => await drafts.listDrafts(ctx, p.id));
  route('GET', '/api/drafts/:id', async (ctx, p) => await drafts.getDraft(ctx, p.id));
  route('PATCH', '/api/drafts/:id', async (ctx, p, body) => await drafts.editDraft(ctx, p.id, body));
  route('POST', '/api/drafts/:id/rewrites', async (ctx, p, body) => await drafts.rewriteDraft(ctx, p.id, body));
  route('POST', '/api/approvals', async (ctx, p, body) => { const results = await drafts.approveDrafts(ctx, body, delivery.onDraftApproved(ctx)); return { results, approved: results.filter(r => r.status === 'approved').length, failed: results.filter(r => r.status !== 'approved').length }; }, { idem: true });
  route('POST', '/api/campaigns/:id/launch', async (ctx, p, body) => { const r = await delivery.launch(ctx, p.id, body); return { ...await campaignView(ctx, r.campaign), created_tasks: r.created }; }, { idem: true });
  for (const a of ['pause', 'resume', 'stop']) route('POST', `/api/campaigns/:id/${a}`, async (ctx, p) => await campaignView(ctx, await delivery.setCampaignState(ctx, p.id, a)));
  route('GET', '/api/campaigns/:id/metrics', async (ctx, p) => await reporting.campaignMetrics(ctx, p.id));
  route('GET', '/api/campaigns/:id/events', async (ctx, p, b, q) => await reporting.listEvents(ctx, { ...q, campaign_id: p.id }));
  route('GET', '/api/events', async (ctx, p, b, q) => await reporting.listEvents(ctx, q));
  route('GET', '/api/campaigns/:id/sequence', async (ctx, p) => await sequences.getSequence(ctx, p.id));
  route('PATCH', '/api/sequences/:id', async (ctx, p, body) => await sequences.updateSequence(ctx, p.id, body));
  route('POST', '/api/sequences/:id/approvals', async (ctx, p, body) => await sequences.approveSteps(ctx, p.id, body));
  route('POST', '/api/sequences/:id/launch', async (ctx, p, body) => await sequences.launchSequence(ctx, p.id, body), { idem: true });
  for (const a of ['pause', 'resume', 'edit']) route('POST', `/api/sequences/:id/${a}`, async (ctx, p) => await sequences.setSequenceState(ctx, p.id, a));
  route('GET', '/api/send-tasks', async (ctx, p, b, q) => await delivery.listTasks(ctx, q));
  route('POST', '/api/send-tasks/:id/confirm-sent', async (ctx, p, body) => await delivery.confirmSent(ctx, p.id, body), { idem: true });
  route('POST', '/api/send-tasks/:id/skip', async (ctx, p, body) => await delivery.skipTask(ctx, p.id, body));
  route('POST', '/api/send-tasks/:id/release', async (ctx, p) => await delivery.releaseTask(ctx, p.id));
  route('POST', '/api/contacts/:id/outcomes', async (ctx, p, body) => await delivery.recordOutcome(ctx, p.id, body), { status: 201 });
  route('GET', '/api/contacts', async (ctx, p, b, q) => await reporting.listContacts(ctx, q));
  route('POST', '/api/tasks/:id/send-smtp', (ctx,p,body) => delivery.smtpSend(ctx,p.id,publicUrl,body));
  route('DELETE', '/api/mailbox', async ctx => {if(ctx.user.role!=='owner') throw new AppError(403,'owner_only','Owner access required.'); await ctx.db.run('DELETE FROM mailboxes WHERE workspace_id=?',[ctx.ws]); await ctx.db.audit(ctx.ws,null,'mailbox.disconnected','SMTP credentials removed',{},ctx.user.id); return {disconnected:true};});
  route('GET', '/api/mailbox', ctx => mailbox.status(ctx));
  route('POST', '/api/mailbox', (ctx,p,body) => {if((process.env.NODE_ENV==='production'||process.env.VERCEL)&&!publicUrl.startsWith('https://')) throw new AppError(503,'https_required','Configure HTTPS before connecting a mailbox.'); return mailbox.connect(ctx,body);});
  route('GET', '/api/imports', async ctx => ({ items: await reporting.listImports(ctx) }));
  route('POST', '/api/imports', async (ctx, p, body) => { if (!await admin.isOperator(db, ctx.user.email)) throw new AppError(403,'operator_only','Lead imports are managed by the pilot team.'); return sourcing.importCsv(ctx, body); }, { status: 201, idem: true });
  route('GET', '/api/suppressions', async ctx => ({ items: await reporting.listSuppressions(ctx) }));
  route('POST', '/api/suppressions', async (ctx, p, body) => await delivery.addSuppression(ctx, { email: body.email, reason: 'manual', note: body.note }), { status: 201 });
  route('DELETE', '/api/suppressions/:id', async (ctx, p) => await delivery.removeSuppression(ctx, p.id));
  route('POST', '/api/workspace/sending', async (ctx, p, body) => await delivery.setSendingStopped(ctx, !!body.stopped));

  async function handleApi(req, res, url, out) {
    const who = await authenticate(req);
    // Browser writes (and sign-in forms) must carry a header that cross-site forms cannot set.
    if (req.method !== 'GET' && !(req.headers.authorization || '').startsWith('Bearer ') && req.headers['x-requested-with'] !== 'outbound') throw new AppError(403, 'csrf', 'Request blocked.');
    const r = R.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw notFound('Endpoint');
    if (!who && !r.public) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    const params = url.pathname.match(r.re).groups || {};
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const x = { req, out, auth: who };
    if (r.public) return send(res, r.status || 200, await r.handler(who ? ctxFor(who.ws, who.user) : null, params, body, Object.fromEntries(url.searchParams), x), out.headers());
    const ctx = ctxFor(who.ws, who.user);
    const key = req.headers['idempotency-key'];
    const routeKey = `${req.method} ${url.pathname}`;
    if (r.idem && key) {
      const prior = await db.get('SELECT * FROM idempotency_keys WHERE workspace_id=? AND key=?', [ctx.ws, String(key).slice(0, 200)]);
      if (prior) {
        if (prior.route !== routeKey) throw new AppError(422, 'idempotency_mismatch', 'This idempotency key was used for a different request.');
        return send(res, prior.status, json(prior.response));
      }
    }
    const result = await r.handler(ctx, params, body, Object.fromEntries(url.searchParams), x);
    const status = r.status || 200;
    if (r.idem && key) await db.run('INSERT INTO idempotency_keys VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', [ctx.ws, String(key).slice(0, 200), routeKey, status, JSON.stringify(result), now()]);
    send(res, status, result, out.headers());
  }

  async function handleStatic(req, res, url) {
    let path;
    try { path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch { path = '/'; }
    const file = normalize(join(STATIC, path));
    if (!file.startsWith(STATIC + '/')) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
    try {
      if (!(await stat(file)).isFile()) throw new Error();
      const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" };
      res.writeHead(200, headers);
      res.end(await readFile(file));
    } catch { send(res, 404, { error: { code: 'not_found', message: 'Not found.' } }); }
  }

  // One request listener serves both the Node server and the Vercel function (api/index.mjs).
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), started = Date.now();
    const cookies = [], out = { setCookie: c => cookies.push(c), headers: () => cookies.length ? { 'set-cookie': cookies } : {} };
    try {
      if (/^\/unsubscribe\/[a-f0-9]{64}$/.test(url.pathname) && ['GET','POST'].includes(req.method)) {
        const token=url.pathname.split('/').pop();
        const record=await db.get('SELECT * FROM optout_tokens WHERE token=?',[token]);
        if(!record) throw notFound('Unsubscribe link');
        if(req.method==='POST') await delivery.addSuppression(ctxFor(record.workspace_id),{email:record.email,reason:'opt_out'});
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});
        res.end(req.method==='POST' ? '<h1>You are unsubscribed</h1><p>No further marketing emails will be sent by this workspace.</p>' : '<h1>Stop marketing emails</h1><form method="POST"><button>Unsubscribe</button></form>');
      }
      else if (req.method === 'GET' && url.pathname === '/auth/google/start') redirect(res, await auth.googleStart(out, Object.fromEntries(url.searchParams)), out.headers());
      else if (req.method === 'GET' && url.pathname === '/auth/google/callback') redirect(res, await auth.googleCallback(out, req, Object.fromEntries(url.searchParams)), out.headers());
      else if (url.pathname === '/sample-contacts.csv') { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sample-contacts.csv"' }); res.end(sampleCsv()); }
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, out);
      else if (req.method === 'GET') await handleStatic(req, res, url);
      else send(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    } catch (e) {
      if (e instanceof AppError) send(res, e.status, { error: { code: e.code, message: e.message, fields: e.fields, ...e.extra } });
      else { log('error', { path: url.pathname, error: String(e?.stack || e) }); send(res, 500, { error: { code: 'internal', message: 'Something went wrong. Please try again.' } }); }
    }
    if (url.pathname.startsWith('/api/')) log('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
  };
  const server = createServer(handle);
  const scheduler = () => runScheduler(db, ws => ctxFor(ws));

  if (workers && !serverless) await jobs.start({ scheduler, scheduleMs: +(process.env.SCHEDULER_INTERVAL_MS || 30000) });
  return { server, handle, scheduler, db, jobs, ctxFor, devToken, auth, publicUrl, close: async () => { jobs.stop(); const closed = new Promise(r => server.close(r)); server.closeAllConnections(); await closed; await db.close(); } };
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers });
  res.end();
}
function readBody(req) {
  // A platform (e.g. Vercel) may have read the stream already and exposed the parsed body instead.
  if (req.readableEnded) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try { const v = b ? JSON.parse(String(b)) : {}; return Promise.resolve(v && typeof v === 'object' ? v : {}); }
    catch { return Promise.reject(new AppError(400, 'bad_json', 'Request body must be JSON.')); }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 6_000_000) { reject(new AppError(413, 'too_large', 'Request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new AppError(400, 'bad_json', 'Request body must be JSON.')); }
    });
    req.on('error', reject);
  });
}
