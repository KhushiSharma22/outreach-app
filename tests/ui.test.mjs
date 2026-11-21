// Frontend integration: runs dist/api.js + dist/app.js in a stubbed DOM against a live in-memory server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createApp } from '../server/app.mjs';
import { sampleCsv } from '../server/sample.mjs';
import { testDatabase } from './helpers.mjs';

process.env.AI_PROVIDER = 'offline';
process.env.NODE_ENV = 'test';
process.env.OPERATOR_EMAILS = 'maya@northstar.example';
let app, base, ctx, els, tdb;

before(async () => {
  tdb = await testDatabase();
  app = await createApp({ ...tdb, workers: false, authMode: 'dev' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  els = {};
  const el = id => (els[id] ??= { id, innerHTML: '', textContent: '', value: '', checked: true, style: {}, className: '', files: [], focus() {}, setSelectionRange() {} });
  const doFetch = (url, opts) => fetch(url.startsWith('/') ? base + url : url, opts);
  ctx = vm.createContext({ OUTBOUND_BASE: base, OUTBOUND_TOKEN: app.devToken, crypto: globalThis.crypto, scrollTo() {}, addEventListener() {}, fetch: doFetch,
    document: { getElementById: el, querySelector: () => el('q'), querySelectorAll: () => [], addEventListener() {} }, navigator: {}, console, setTimeout, clearTimeout, Date, URLSearchParams, encodeURIComponent, location: {} });
  ctx.window = ctx;
  vm.runInContext(readFileSync('dist/api.js', 'utf8'), ctx);
  vm.runInContext(readFileSync('dist/app.js', 'utf8'), ctx);
  await until(() => !run('S.loading'));
});
after(async () => { await app.close(); await tdb.drop(); });

const run = expr => vm.runInContext(expr, ctx);
const html = () => els.app.innerHTML;
const settle = async () => { await new Promise(r => setTimeout(r, 30)); await app.jobs.drain(); await new Promise(r => setTimeout(r, 30)); };
async function until(fn, ms = 4000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } }

test('every screen renders from the API, and the full manual-send journey works end to end', async () => {
  assert.match(html(), /Your next campaign starts with a conversation/);
  for (const v of ['campaigns', 'contacts', 'sequences', 'outbox', 'account', 'email', 'home']) { await run(`navigate('${v}')`); assert.ok(html().length > 500, v); }

  await run(`navigate('contacts')`);
  await run(`importCsvText('sample.csv', ${JSON.stringify(sampleCsv())}, 'csv')`);
  assert.match(html(), /38 new/);

  // Assistant brief → structured campaign that keeps the prompt
  await run(`navigate('home')`);
  run(`$('prompt').value = 'Find founders and heads of growth at SaaS companies in India that are hiring or raised funding'`);
  await run('sendChat()');
  assert.match(html(), /Here’s how I read your brief/);
  await run('createFromBrief()');
  await until(() => run('S.c') && run('S.view') === 'builder');
  assert.match(html(), /Your original assistant brief/);
  run(`toggleAudienceFilter('sizes','11–50')`); run(`toggleAudienceFilter('sizes','51–200')`);
  await run('flushSave()');
  assert.deepEqual([...run('S.c.config.filters.sizes')], ['11–50', '51–200']);

  await run('continueFlow()');                 // → discovery settings
  assert.match(html(), /Find your next customers/);
  await run(`saveCampaign({config:{source:'import',signals:['Hiring','Funding','New leadership','Expansion']}},{now:true})`);
  await run('continueFlow()');                 // → review leads
  await run('discoverBatch()');
  await settle(); await until(() => run('S.leads && S.leads.selected') > 0 && html().includes('discovery-hero'));
  const selectedCount=run('S.leads.selected');
  assert.ok(selectedCount<=30);
  assert.match(html(), /Quality-checked prospects|Quality first/);

  await run('continueFlow()');                 // → email studio, drafts generated
  await settle(); await until(() => run('S.drafts && S.drafts.items.every(x=>x.draft)'));
  run('render()');
  assert.match(html(), /Emails that sound like you/);
  await run('openBulk()');
  await run('approveAll()');
  assert.equal(run('S.drafts.approved'), selectedCount);

  await run('continueFlow()');                 // → schedule
  assert.match(html(), /Manual send tasks/);
  await run('continueFlow()');                 // → launch summary
  assert.match(html(), /Only emails with approval for their exact wording can be sent/);
  await run('continueFlow()');                 // launch (checkbox stub is checked)
  await until(() => run('S.view') === 'tracking' && run('S.metrics'));
  assert.match(html(), /CAMPAIGN INSIGHTS/);
  assert.equal(run('S.c.status'), 'active');

  await run(`navigate('outbox')`);
  assert.match(html(), /I sent this/);
  const taskId = run('S.tasks.items[0].id');
  await run(`confirmSent('${taskId}')`);
  assert.equal(run('S.tasks.counts.sent'), 1);

  await run(`navigate('sequences')`);
  assert.match(html(), /Day 0 · Initial email/);
  await run('reviewSequenceBatch()');
  await run('approveSequenceBatch()');
  await run('launchSequence()');
  assert.equal(run('S.seq.status'), 'active');
  assert.equal(run('S.seq.enrollments.active'), 1);

  await run(`openCampaign(S.cid,'tracking')`);
  await run(`insightTab('activity')`);
  assert.match(html(), /Follow-up sequence launched/);
});

test('campaign lead screen displays admin-managed leads without customer import controls',async()=>{
 const c=await run(`Api.post('/api/campaigns',{name:'Admin leads',brief:{filters:{roles:['Founder']},signals:[]}})`);
 await run(`openCampaign('${c.id}','builder')`);
 await run('continueFlow()');
 assert.match(html(),/Your admin prepares leads for this campaign/);
 assert.doesNotMatch(html(),/Import your own contacts|Upload your contacts/);
});
