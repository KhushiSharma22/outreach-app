// Backend acceptance tests (handoff §14). Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, seedWorkspace } from '../server/app.mjs';
import { sampleCsv } from '../server/sample.mjs';
import { runScheduler } from '../server/jobs.mjs';
import { followupDue } from '../server/sequences.mjs';
import { zonedToUtc } from '../server/lib.mjs';
import { testDatabase } from './helpers.mjs';

process.env.AI_PROVIDER = 'offline';
process.env.NODE_ENV = 'test';
let app, base, token, other, tdb;

before(async () => {
  tdb = await testDatabase();
  app = await createApp({ ...tdb, workers: false, authMode: 'dev' });
  token = app.devToken;
  other = await seedWorkspace(app.db, { name: 'Other Co', userName: 'Olu', email: 'olu@other.example' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); await tdb.drop(); });

async function api(method, path, body, { auth = token, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  return { status: res.status, data };
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const drain = () => app.jobs.drain();

async function readyCampaign(name = 'Founders in India') {
  const c = await ok('POST', '/api/campaigns', { name, prompt: 'Find founders of funded SaaS companies in India' });
  return ok('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision, config: { filters: { roles: ['Founder', 'Head of Growth'], industries: ['B2B SaaS'], locations: ['India'], sizes: ['11–50', '51–200'] }, signals: ['Hiring', 'Funding', 'New leadership', 'Expansion'] } });
}
async function discover(c) {
  const run = await ok('POST', `/api/campaigns/${c.id}/discovery-runs`);
  await drain();
  return ok('GET', `/api/runs/${run.id}`);
}
async function approveAll(c) {
  await ok('POST', `/api/campaigns/${c.id}/draft-runs`, {});
  await drain();
  const d = await ok('GET', `/api/campaigns/${c.id}/drafts`);
  return ok('POST', '/api/approvals', { confirm: true, items: d.items.map(x => ({ draft_id: x.draft.id, revision_id: x.draft.revision_id })) });
}
async function launched() {
  let c = await readyCampaign('Launch ' + Math.random());
  await discover(c);
  await approveAll(c);
  c = await ok('GET', `/api/campaigns/${c.id}`);
  return ok('POST', `/api/campaigns/${c.id}/launch`, { revision: c.revision });
}

test('import resolves identities, rejects bad rows, and dedupes repeat imports', async () => {
  const csv = sampleCsv();
  const first = await ok('POST', '/api/imports', { filename: 'sample.csv', csv });
  assert.equal(first.created_count, 38);
  const again = await ok('POST', '/api/imports', { filename: 'sample.csv', csv });
  assert.equal(again.created_count, 0);
  assert.equal(again.updated_count, 38);
  const bad = await ok('POST', '/api/imports', { filename: 'bad.csv', csv: 'first_name,company,email\n,Acme,a@acme.example\nJo,Acme,not-an-email\n' });
  assert.equal(bad.created_count, 0);
  assert.equal(bad.rejected.length, 2);
  const noCols = await api('POST', '/api/imports', { filename: 'x.csv', csv: 'foo,bar\n1,2\n' });
  assert.equal(noCols.status, 422);
  assert.match(noCols.data.error.message, /Missing required column/);
});

test('discovery qualifies with evidence, keeps batches, never re-adds the same prospect, and reports shortfall', async () => {
  const c = await readyCampaign();
  const run1 = await discover(c);
  assert.equal(run1.status, 'completed');
  assert.equal(run1.candidates, 38);
  assert.equal(run1.qualified, 30);
  assert.equal(run1.selected, 28);
  const leads = await ok('GET', `/api/campaigns/${c.id}/leads?decision=all&page_size=100`);
  const by = n => leads.items.find(l => l.name === n);
  assert.equal(by('Ira Banerjee').decision, 'review');          // no email
  assert.equal(by('Manav Arora').decision, 'excluded');         // customer
  assert.equal(by('Tanvi Kulkarni').decision, 'excluded');      // too large
  assert.equal(by('Yash Thakur').decision, 'excluded');         // stale signal
  assert.equal(by('Nisha Pillai').decision, 'review');          // unknown event date
  assert.equal(by('Farhan Qureshi').decision, 'review');        // unverified email
  assert.ok(by('Aarav Mehta').evidence.length);
  const run2 = await discover(c);
  assert.equal(run2.candidates, 0);
  assert.equal(run2.qualified, 0);
  assert.match(run2.shortfall_reason, /No new contacts/);
  const batches = await ok('GET', `/api/campaigns/${c.id}/batches`);
  assert.equal(batches.items.length, 2);
});

test('hard exclusions cannot be overridden; review leads need a reason', async () => {
  const c = await readyCampaign();
  await discover(c);
  const all = (await ok('GET', `/api/campaigns/${c.id}/leads?decision=all&page_size=100`)).items;
  const excluded = all.find(l => l.name === 'Manav Arora'), review = all.find(l => l.name === 'Farhan Qureshi'), noEmail = all.find(l => l.name === 'Ira Banerjee');
  assert.equal((await api('PATCH', `/api/campaign-leads/${excluded.id}`, { decision: 'qualified', reason: 'x' })).status, 409);
  assert.equal((await api('PATCH', `/api/campaign-leads/${noEmail.id}`, { decision: 'qualified', reason: 'x' })).status, 409);
  assert.equal((await api('PATCH', `/api/campaign-leads/${review.id}`, { decision: 'qualified' })).status, 422);
  const q = await ok('PATCH', `/api/campaign-leads/${review.id}`, { decision: 'qualified', reason: 'Verified by phone' });
  assert.equal(q.decision, 'qualified');
});

test('editing after approval blocks launch until the new revision is approved; stale approvals conflict', async () => {
  let c = await readyCampaign();
  await discover(c);
  await approveAll(c);
  const d = (await ok('GET', `/api/campaigns/${c.id}/drafts`)).items[0].draft;
  const edited = await ok('PATCH', `/api/drafts/${d.id}`, { revision_id: d.revision_id, body: d.body + '\n\nP.S. Edited.' });
  assert.equal(edited.approved, false);
  assert.equal((await api('PATCH', `/api/drafts/${d.id}`, { revision_id: d.revision_id, body: 'stale' })).status, 409);
  const stale = await ok('POST', '/api/approvals', { items: [{ draft_id: d.id, revision_id: d.revision_id }] });
  assert.equal(stale.results[0].status, 'conflict');
  c = await ok('GET', `/api/campaigns/${c.id}`);
  assert.ok(c.blockers.some(b => b.code === 'approvals'));
  assert.equal((await api('POST', `/api/campaigns/${c.id}/launch`, { revision: c.revision })).status, 422);
  await ok('POST', '/api/approvals', { items: [{ draft_id: d.id, revision_id: edited.revision_id }] });
  c = await ok('GET', `/api/campaigns/${c.id}`);
  assert.equal(c.blockers.length, 0);
});

test('repeated launch requests create work once; manual sends are labeled as user-confirmed', async () => {
  let c = await readyCampaign();
  await discover(c);
  await approveAll(c);
  c = await ok('GET', `/api/campaigns/${c.id}`);
  const h = { headers: { 'idempotency-key': 'launch-' + c.id } };
  const l1 = await ok('POST', `/api/campaigns/${c.id}/launch`, { revision: c.revision }, h);
  const l2 = await ok('POST', `/api/campaigns/${c.id}/launch`, { revision: c.revision }, h);
  assert.equal(l1.created_tasks, 28);
  assert.equal(l2.created_tasks, 28);
  const l3 = await ok('POST', `/api/campaigns/${c.id}/launch`, { revision: c.revision });
  assert.equal(l3.status, 'active');
  const tasks = await ok('GET', `/api/send-tasks?campaign_id=${c.id}`);
  assert.equal(tasks.total, 28);
  const t = tasks.items[0];
  const s1 = await ok('POST', `/api/send-tasks/${t.id}/confirm-sent`, {});
  const s2 = await ok('POST', `/api/send-tasks/${t.id}/confirm-sent`, {});
  assert.equal(s1.status, 'sent');
  assert.equal(s2.proof, 'user_confirmed');
  const m = await ok('GET', `/api/campaigns/${c.id}/metrics`);
  assert.equal(m.sent, 1);
  assert.match(m.definitions.sent, /manual confirmation/);
});

test('suppressed recipients cannot proceed; paused campaigns block sending', async () => {
  const c = await launched();
  const tasks = (await ok('GET', `/api/send-tasks?campaign_id=${c.id}`)).items;
  await ok('POST', '/api/suppressions', { email: tasks[0].to_email });
  assert.equal((await api('POST', `/api/send-tasks/${tasks[0].id}/confirm-sent`, {})).status, 409);
  await ok('POST', `/api/campaigns/${c.id}/pause`);
  const r = await api('POST', `/api/send-tasks/${tasks[1].id}/confirm-sent`, {});
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /paused/);
  await ok('POST', `/api/campaigns/${c.id}/resume`);
  await ok('POST', `/api/send-tasks/${tasks[1].id}/confirm-sent`, {});
});

test('sequences: approval gate, enrollment from each recipient’s own send, reply stops queued follow-up, no burst on resume', async () => {
  const c = await launched();
  const seq = await ok('GET', `/api/campaigns/${c.id}/sequence`);
  assert.deepEqual(seq.steps.map(s => s.day), [1, 3, 5, 7]);
  assert.equal((await api('POST', `/api/sequences/${seq.id}/launch`, { revision: seq.revision })).status, 409);
  const bad = await api('PATCH', `/api/sequences/${seq.id}`, { revision: seq.revision, steps: [{ day: 3, subject: 'a', body: 'b' }, { day: 1, subject: 'a', body: 'b' }] });
  assert.equal(bad.status, 200);
  assert.ok(bad.data.errors.length);
  let s = await ok('PATCH', `/api/sequences/${seq.id}`, { revision: bad.data.revision, steps: seq.steps.map(({ day, subject, body, title }) => ({ day, subject, body, title })) });
  s = await ok('POST', `/api/sequences/${seq.id}/approvals`, { revision: s.revision, steps: 'all', confirm: true });
  // Two recipients sent at different times; one unsent recipient must not be enrolled.
  const tasks = (await ok('GET', `/api/send-tasks?campaign_id=${c.id}`)).items;
  const longAgo = new Date(Date.now() - 4 * 864e5 + 60e3);
  await app.db.run('UPDATE send_tasks SET created_at=? WHERE id=?', [new Date(longAgo - 120e3).toISOString(), tasks[0].id]);
  await ok('POST', `/api/send-tasks/${tasks[0].id}/confirm-sent`, { sent_at: longAgo.toISOString() });
  await ok('POST', `/api/send-tasks/${tasks[1].id}/confirm-sent`, {});
  s = await ok('POST', `/api/sequences/${seq.id}/launch`, { revision: s.revision });
  assert.equal(s.status, 'active');
  assert.equal(s.enrollments.active, 2);
  const fu = (await ok('GET', `/api/send-tasks?campaign_id=${c.id}&status=all&page_size=200`)).items.filter(t => t.kind === 'followup');
  assert.equal(fu.length, 2);
  const late = fu.find(t => t.contact_id === tasks[0].contact_id), fresh = fu.find(t => t.contact_id === tasks[1].contact_id);
  assert.equal(late.status, 'held');       // sequence added late: overdue step held, not sent
  assert.equal(fresh.status, 'pending');
  assert.ok(Date.parse(fresh.due_at) > Date.now());
  // A reply recorded while the follow-up is queued stops it.
  await ok('POST', `/api/contacts/${tasks[1].contact_id}/outcomes`, { type: 'reply', campaign_id: c.id });
  const after = (await ok('GET', `/api/send-tasks?campaign_id=${c.id}&status=all&page_size=200`)).items.find(t => t.id === fresh.id);
  assert.equal(after.status, 'canceled');
  // Releasing the held step and confirming advances that recipient to the next step only.
  await ok('POST', `/api/send-tasks/${late.id}/release`);
  await ok('POST', `/api/send-tasks/${late.id}/confirm-sent`, {});
  const next = (await ok('GET', `/api/send-tasks?campaign_id=${c.id}&status=open`)).items.filter(t => t.kind === 'followup');
  assert.equal(next.length, 1);
  assert.equal(next[0].day, 3);
  // Opt-out suppresses across campaigns.
  await ok('POST', `/api/contacts/${tasks[0].contact_id}/outcomes`, { type: 'opt_out' });
  const sup = await ok('GET', '/api/suppressions');
  assert.ok(sup.items.some(x => x.email === tasks[0].to_email && x.reason === 'opt_out'));
  // Editing an active sequence requires fresh approval.
  const edit = await ok('POST', `/api/sequences/${seq.id}/edit`);
  assert.equal(edit.status, 'draft');
  assert.ok(edit.steps.every(x => !x.approved));
});

test('scheduler creates one batch per local day and no backlog', async () => {
  const c = await launched();
  const before = (await ok('GET', `/api/campaigns/${c.id}/batches`)).items.length;
  const ctxFor = ws => app.ctxFor(ws);
  // Launch registered today's occurrence; a tick later today must not add another batch.
  await runScheduler(app.db, ctxFor, Date.now());
  await runScheduler(app.db, ctxFor, Date.now());
  assert.equal((await ok('GET', `/api/campaigns/${c.id}/batches`)).items.length, before);
  // Next scheduled weekday at 10:00 local: exactly one new batch even with repeated ticks.
  let t = Date.now() + 864e5;
  while (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(t))) t += 864e5;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(t);
  const at = Date.parse(zonedToUtc(date, '10:00', 'Asia/Kolkata'));
  await runScheduler(app.db, ctxFor, at);
  await runScheduler(app.db, ctxFor, at + 60e3);
  assert.equal((await ok('GET', `/api/campaigns/${c.id}/batches`)).items.length, before + 1);
});

test('follow-up due dates respect timezone, DST, and sending days', () => {
  const s = { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], time: '09:00', timezone: 'America/New_York' };
  // Sent Friday 2026-03-06 15:00 EST; day 2 = Sunday → moved to Monday 2026-03-09, after DST starts (EDT, UTC-4).
  assert.equal(followupDue('2026-03-06T20:00:00Z', 2, s), '2026-03-09T13:00:00.000Z');
  assert.equal(followupDue('2026-03-02T20:00:00Z', 1, s), '2026-03-03T14:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'Asia/Kolkata'), '2026-07-01T03:30:00.000Z');
});

test('workspace isolation and request protections', async () => {
  const c = await readyCampaign();
  assert.equal((await api('GET', `/api/campaigns/${c.id}`, null, { auth: other.token })).status, 404);
  assert.equal((await api('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision, name: 'x' }, { auth: other.token })).status, 404);
  assert.equal((await ok('GET', '/api/contacts', null, { auth: other.token })).total, 0);
  assert.equal((await api('GET', '/api/campaigns', null, { auth: 'nope' })).status, 401);
  // Cookie-authenticated writes need the CSRF header.
  const res = await fetch(base + '/api/campaigns', { method: 'POST', headers: { cookie: `ob_session=${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  // Stale campaign revision conflicts.
  await ok('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision, name: 'Renamed' });
  assert.equal((await api('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision, name: 'Again' })).status, 409);
  assert.equal((await api('PATCH', `/api/campaigns/${c.id}`, { revision: c.revision + 1, config: { approval: 'rules' } })).status, 422);
});

test('brief interpretation keeps the prompt and only proposes detected filters', async () => {
  const b = await ok('POST', '/api/campaign-briefs/interpret', { prompt: 'Find heads of growth at SaaS companies hiring their first sales team in India.' });
  assert.deepEqual(b.filters.roles, ['Head of Growth']);
  assert.deepEqual(b.filters.locations, ['India']);
  assert.ok(b.signals.includes('Hiring'));
  const c = await ok('POST', '/api/campaigns', { prompt: b.prompt, brief: b });
  assert.equal(c.prompt, b.prompt);
  assert.deepEqual(c.config.filters.roles, ['Head of Growth']);
});
