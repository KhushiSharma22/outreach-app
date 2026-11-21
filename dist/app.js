/* Outbound campaign studio — screens and interactions, backed by the API in api.js. */
const icons = { grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', campaign: '<path d="m3 11 18-8-8 18-3-8-7-2Z"/><path d="m10 13 5-5"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>', spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm8-2v4m-2-2h4"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>', linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 10v7m0-10v.1M11 17v-7m0 3a3 3 0 0 1 6 0v4"/>', check: '<path d="m5 12 4 4L19 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', chart: '<path d="M4 4v16h17M8 15l4-5 4 2 5-7"/>', settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>', home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>', copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>', calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>', pause: '<path d="M8 5v14m8-14v14"/>', plus: '<path d="M12 4v16M4 12h16"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>' };
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const flowSteps = ['Campaign brief', 'Lead discovery', 'Review leads', 'Email studio', 'Schedule', 'Launch'];
const FILTER_GROUPS = [['Job roles', 'roles'], ['Industry', 'industries'], ['Location', 'locations'], ['Company size · employees', 'sizes'], ['Seniority', 'seniority'], ['Exclude from outreach', 'exclude']];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

let S = {
  view: 'home', loading: true, fatal: '', session: null, context: null, summary: null, campaigns: [],
  cid: null, c: null, runs: [], runId: 'all', leads: null, lq: { decision: 'qualified', q: '', page: 0 }, leadId: null,
  drafts: null, messageLead: null, weekDay: 'all', metrics: null, events: [], insightTab: 'overview',
  tasks: null, taskFilter: 'open', taskCampaign: null,
  seq: null, seqActive: 0, seqRecipient: 0, seqLeads: [],
  contacts: null, cq: '', cpage: 0, imports: [], suppressions: [], lastImport: null,
  chat: { prompt: '', brief: null, busy: false }, modal: null, modalData: null, error: '', busy: false,
};
let toastTimer, pollTimer, saveChain = Promise.resolve(), pendingSave = null, saveTimer = null;

// ---------- Utilities ----------
function badge(text, type = '') { return `<span class="badge ${type}">${esc(text)}</span>`; }
function toast(text) { const el = $('toast'); if (!el) return; el.className = 'toast'; el.textContent = text; el.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.style.display = 'none', 3800); }
function fail(e) { if (e?.status === 401) return showAuth('signin', { error: 'Your session ended. Sign in again.' }); toast(e?.message || String(e)); if (e?.status === 409 && S.cid) refreshCampaign(); }
const fmtDate = iso => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fmtDay = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
const initials = name => esc(String(name || '?').split(' ').map(x => x[0]).join('').slice(0, 2));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clone = v => JSON.parse(JSON.stringify(v));
function stat(label, value, note, i) { return `<div class="stat-card"><div class="stat-top">${esc(label)}${icon(i)}</div><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`; }
function loadingPanel(text = 'Loading…') { return `<div class="panel empty"><div class="progress-track"></div><p>${esc(text)}</p></div>`; }
function poll(fn, ms = 1000) { clearTimeout(pollTimer); pollTimer = setTimeout(async () => { try { if (await fn()) poll(fn, ms); } catch (e) { fail(e); } }, ms); }
const AI_NAMES = { claude: 'Claude', gemini: 'Gemini' };
const aiLabel = () => AI_NAMES[S.session?.ai.provider] ? `${AI_NAMES[S.session.ai.provider]} · ${S.session.ai.model}` : 'Offline templates';
function generatorLabel(g) { return !g ? '' : AI_NAMES[g.provider] ? `Written by ${AI_NAMES[g.provider]} (${g.model})` : g.provider === 'user' ? 'Edited by you' : (AI_NAMES[S.session?.ai.provider] ? 'Template draft' : 'Template draft (no AI provider configured)'); }
const emailBadge = s => ({ valid: badge('Verified', 'green'), unverified: badge('Unverified', 'amber'), unknown: badge('Unknown', 'amber'), catch_all: badge('Catch-all', 'amber'), invalid: badge('Invalid', 'red'), missing: badge('Missing', 'amber') }[s] || badge(s || 'Unknown', 'amber'));

// ---------- Boot and navigation ----------
async function boot() {
  if (await handleAuthLink()) return;
  try {
    const [session, context, summary, list] = await Promise.all([Api.get('/api/session'), Api.get('/api/account-context'), Api.get('/api/summary'), Api.get('/api/campaigns')]);
    Object.assign(S, { session, context, summary, campaigns: list.items, loading: false, auth: null });
  } catch (e) {
    S.loading = false;
    if (e.status === 401) return showAuth(/^#\/signup/.test(String(location.hash || '')) ? 'signup' : 'signin', { error: googleError(String(location.hash || '')) });
    S.fatal = e.message;
  }
  if (!S.fatal && !S.context?.data?.offering) return navigate('account');
  render();
  // Restore the screen from the URL so a refresh keeps your place.
  const h = String(location.hash || ''), m = h.match(/^#\/campaign\/([\w-]+)(?:\/(builder|tracking|emails))?/);
  if (!S.fatal && m) openCampaign(m[1], m[2]);
  else if (!S.fatal && /^#\/(campaigns|outbox|sequences|contacts|account|email|team|admin)$/.test(h)) navigate(h.slice(2));
  else if (!S.fatal && /^#\/(signin|signup)/.test(h)) setHash('#/');
}
function setHash(h) { try { if (location.hash !== h) history.replaceState(null, '', h); } catch { /* no history API (tests) */ } }
async function refreshSummary() { try { const [summary, list] = await Promise.all([Api.get('/api/summary'), Api.get('/api/campaigns')]); S.summary = summary; S.campaigns = list.items; } catch (e) { fail(e); } }
async function navigate(next) {
  clearTimeout(pollTimer); S.view = next; S.modal = null; S.error = ''; setHash(next === 'home' ? '#/' : '#/' + next);
  render(); window.scrollTo(0, 0);
  try {
    if (next === 'home' || next === 'campaigns') await refreshSummary();
    if (next === 'outbox') { S.taskCampaign = null; await loadTasks(); }
    if (next === 'contacts') await loadContacts();
    if (next === 'sequences') await loadSequenceView();
    if (next === 'email') S.mailbox = await Api.get('/api/mailbox');
    if (next === 'account') S.context = await Api.get('/api/account-context');
    if (next === 'team') S.team = await Api.get('/api/team');
    if (next === 'admin') await loadAdmin();
  } catch (e) { fail(e); }
  render();
}
async function openCampaign(id, view) {
  clearTimeout(pollTimer);
  Object.assign(S, { cid: id, c: null, leads: null, drafts: null, metrics: null, runs: [], sources: null, uploadPreview: null, uploadFile: null, uploadBusy: false, importResult: null, runId: 'all', lq: { decision: 'qualified', q: '', page: 0 }, messageLead: null, weekDay: 'all', insightTab: 'overview', error: '', modal: null });
  S.view = view || 'builder'; render(); window.scrollTo(0, 0);
  try {
    await refreshCampaign();
    if (!view) S.view = S.c.status === 'draft' ? 'builder' : 'tracking';
    setHash(`#/campaign/${id}/${S.view}`);
    await loadViewData();
  } catch (e) { fail(e); }
  render();
}
async function refreshCampaign() { if (S.cid) S.c = await Api.get(`/api/campaigns/${S.cid}`); }
async function loadViewData() {
  const c = S.c;
  if (S.view === 'builder') {
    if ([1,2].includes(c.step)) await loadSourceStatus();
    if (c.step === 2) { await loadRuns(); await loadLeads(); }
    if (c.step === 3) await loadDrafts(true);
    if (c.step === 5) S.drafts = await Api.get(`/api/campaigns/${c.id}/drafts`);
  }
  if (S.view === 'emails') await loadDrafts(true);
  if (S.view === 'tracking') {
    const tab = S.insightTab;
    if (tab === 'overview') { const [m, ev] = await Promise.all([Api.get(`/api/campaigns/${c.id}/metrics`), Api.get(`/api/campaigns/${c.id}/events?limit=8`)]); S.metrics = m; S.events = ev.items; await loadRuns(); }
    if (tab === 'leads') { await loadRuns(); await loadLeads(); }
    if (tab === 'queue') { S.taskCampaign = c.id; await loadTasks(); }
    if (tab === 'activity') S.events = (await Api.get(`/api/campaigns/${c.id}/events?limit=50`)).items;
  }
}
const current = () => S.c;

// ---------- Shell ----------
function shell(body) {
  const v = S.view, name = S.context?.data.company || 'Workspace', sender = S.context?.data.sender || '';
  const due = S.summary?.tasks_due || 0;
  return `<div class="app"><aside class="sidebar"><div class="brand"><span class="logo">↗</span>outbound<span style="color:#c8e99b">.</span></div><div class="workspace"><span class="avatar">${esc(name[0] || 'W')}</span><div class="grow">${esc(S.session?.workspace.name || name)}<small style="display:block;color:#789583;font-size:10px">${S.session?.user.role === 'owner' ? 'Owner' : 'Member'} · email workspace</small>${(S.session?.workspaces || []).length > 1 ? `<select class="ws-switch" aria-label="Switch workspace" onchange="switchWorkspace(this.value)">${S.session.workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === S.session.workspace.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>` : ''}</div></div><div class="nav-label">WORKSPACE</div><nav class="nav">
    <button class="${v === 'home' ? 'active' : ''}" onclick="navigate('home')">${icon('home')}Home</button>
    <button class="${['campaigns', 'builder', 'tracking', 'emails'].includes(v) ? 'active' : ''}" onclick="navigate('campaigns')">${icon('campaign')}Campaigns <span class="count">${S.campaigns.length}</span></button>
    <button class="${v === 'outbox' ? 'active' : ''}" onclick="navigate('outbox')">${icon('send')}Send queue ${due ? `<span class="count">${due}</span>` : ''}</button>
    <button class="${v === 'sequences' ? 'active' : ''}" onclick="navigate('sequences')">${icon('clock')}Sequences</button>
    <button class="${v === 'contacts' ? 'active' : ''}" onclick="navigate('contacts')">${icon('people')}Contacts</button>
    <button class="${v === 'account' ? 'active' : ''}" onclick="navigate('account')">${icon('settings')}Company context</button>
    <button class="${v === 'team' ? 'active' : ''}" onclick="navigate('team')">${icon('shield')}Team & account</button></nav>
    ${S.session?.user.super_admin ? `<button class="admin-toggle ${v === 'admin' ? 'on' : ''}" role="switch" aria-checked="${v === 'admin'}" onclick="toggleAdmin()"><span class="switch"><i></i></span>Super admin</button>` : ''}
    <div class="sidebar-bottom"><div class="workspace-note"><strong>${icon('spark')} Quality over volume</strong>Every prospect should have a reason to be on your list.</div><div class="user"><span class="avatar">${esc((S.session?.user.name || sender)[0] || 'U')}</span><div class="grow">${esc(S.session?.user.name || sender)}<small>${esc(S.session?.user.email || '')}</small></div><button class="small ghost signout" onclick="signOut()" title="Sign out">Sign out</button></div></div></aside>
    <main class="main"><header class="topbar"><span class="mobile-brand">↗ outbound.</span><div class="breadcrumbs">Workspace <span>/</span><strong>${({ home: 'Home', campaigns: 'Campaigns', builder: 'Campaign studio', tracking: 'Campaign insights', emails: 'Email studio', email: 'Email setup', account: 'Company context', team: 'Team & account', admin: 'Super admin', contacts: 'Contacts', sequences: 'Sequences', outbox: 'Send queue' })[v]}</strong></div>
    <div class="top-actions">${S.summary?.sending_stopped ? badge('Sending stopped', 'red') : ''}<span class="preview-pill" title="AI provider">${icon('spark')} ${esc(aiLabel())}</span><span class="preview-pill" title="Delivery mode">${S.c?.config.delivery==='smtp'?'Scheduled SMTP':'Campaign delivery'}</span><button class="small ghost" onclick="navigate('account')">${icon('mail')} ${esc(S.context?.data.email || '')}</button></div></header>
    <div class="content">${body}</div></main></div>${overlay()}`;
}
function render() {
  if (S.auth) { $('app').innerHTML = authView(); return; }
  const views = { home: homeView, campaigns: campaignsView, builder: builderView, tracking: trackingView, emails: emailsView, account: accountView, email: emailSetupView, team: teamView, admin: adminView, contacts: contactsView, sequences: sequencesView, outbox: outboxView };
  let body;
  if (S.loading) body = loadingPanel('Loading your workspace…');
  else if (S.fatal) body = `<div class="panel empty"><h3>We couldn’t load your workspace</h3><p>${esc(S.fatal)}</p><button class="primary" onclick="location.reload()">Try again</button></div>`;
  else if (['builder', 'tracking', 'emails'].includes(S.view) && !S.c) body = loadingPanel('Loading campaign…');
  else body = views[S.view]();
  $('app').innerHTML = shell(body);
  if (S.modal) { document.querySelector('.app').inert = true; document.querySelector('.overlay textarea,.overlay input,.overlay button,.modal textarea,.modal input,.modal button')?.focus(); }
}

// ---------- Home ----------
function homeView() {
  const ctx = S.context.data, sm = S.summary || {}, b = S.chat.brief;
  return `<div class="heading"><div><div class="eyebrow">YOUR OUTBOUND WORKSPACE</div><h1>Hello, ${esc(ctx.sender)}.</h1><p>Let’s find the people who should hear from you.</p></div><button class="ghost" onclick="newCampaign()">${icon('plus')} Create manually</button></div>
  <div class="notice" style="margin-bottom:18px"><span><button class="small" onclick="navigate('account')">1. Company context</button> → <button class="small" onclick="navigate('email')">2. Email setup</button></span></div>
  ${sm.sending_stopped ? `<div class="notice amber" style="margin-bottom:18px">${icon('shield')}Sending is stopped for this workspace. Re-enable it from the Send queue.</div>` : ''}
  ${!ctx.offering ? `<div class="notice amber" style="margin-bottom:18px">${icon('spark')}<span><strong>Welcome! Start with your company context.</strong> Tell us what you offer and who you help; it guides lead qualification and every email. <button class="small" onclick="navigate('account')">Set up company context</button></span></div>` : ''}
  ${(sm.failed_jobs || []).length ? `<div class="notice amber" style="margin-bottom:18px">${icon('shield')}Some background work failed recently: ${esc(sm.failed_jobs.map(j => j.type).join(', '))}. Open the campaign to retry.</div>` : ''}
  <div class="home-grid"><div><section class="assistant-panel"><div class="assistant-title"><span class="ai-mark">${icon('spark')}</span><div><h2>Your next campaign starts with a conversation.</h2><p>Campaign assistant · ${esc(aiLabel())}</p></div></div><p class="assistant-intro">Who would you like to reach,<br>and what’s your reason to connect?</p>
  <div class="prompt-box"><textarea id="prompt" aria-label="Describe your campaign" placeholder="Find founders of recently funded SaaS companies in India. Help me introduce our outbound service…" oninput="S.chat.prompt=this.value">${esc(S.chat.prompt)}</textarea><div class="prompt-footer"><span>${icon('shield')} Grounded in your company context</span><button class="primary" onclick="sendChat()" ${S.chat.busy ? 'disabled' : ''}>${S.chat.busy ? 'Interpreting…' : 'Build my campaign'} ${icon('arrow')}</button></div></div>
  <div class="suggestions"><button onclick="usePrompt('Reach founders at B2B SaaS companies in India that recently raised funding. Introduce our outbound service.')">${icon('spark')} Recently funded founders</button><button onclick="usePrompt('Find heads of growth at SaaS companies hiring their first sales team in India.')">${icon('people')} Teams hiring in sales</button></div>
  ${b ? `<div class="conversation"><div class="bubble-user">${esc(b.prompt)}</div><div class="inline"><span class="ai-mark" style="height:28px;width:28px">${icon('spark')}</span><strong style="font-size:13px">Here’s how I read your brief</strong></div><p>${esc(b.summary || 'Confirm these filters before discovery.')}</p>
    <div class="review-grid" style="margin:12px 0">${FILTER_GROUPS.filter(([, k]) => b.filters[k]?.length).map(([l, k]) => `<div class="review-item"><small>${esc(l)}</small><strong>${esc(b.filters[k].join(' or '))}</strong></div>`).join('')}${b.signals.length ? `<div class="review-item"><small>Signals</small><strong>${esc(b.signals.join(', '))}</strong></div>` : ''}</div>
    ${b.clarifications.length ? `<div class="notice amber">${icon('shield')}<span>${b.clarifications.map(esc).join('<br>')}</span></div>` : ''}
    <p class="helper">${b.degraded ? `${esc(AI_NAMES[S.session?.ai.provider] || 'The AI')} was busy, so keywords were used instead. Try again for an AI reading.` : AI_NAMES[b.provider] ? `Interpreted by ${AI_NAMES[b.provider]} (${esc(b.model)}).` : 'Keyword interpretation — no AI provider configured.'} Nothing is applied until you confirm it in the campaign brief.</p><button class="primary small" onclick="createFromBrief()">Review campaign brief ${icon('arrow')}</button></div>` : ''}</section>
  <div class="stat-strip">${stat('Active campaigns', sm.active_campaigns ?? 0, 'Across your workspace', 'campaign')}${stat('Awaiting your review', sm.awaiting_review ?? 0, 'Selected leads without approved emails', 'people')}${stat('Emails due to send', sm.tasks_due ?? 0, `${sm.replies_7d ?? 0} replies recorded · last 7 days`, 'mail')}</div></div>
  <aside class="home-context"><div class="panel"><div class="panel-header"><h2 style="font-size:14px">Your company context</h2><button class="icon-btn ghost" aria-label="Edit company context" onclick="navigate('account')">${icon('settings')}</button></div><div class="context-list"><div><span>COMPANY</span><p>${esc(ctx.company)}</p></div><div><span>WHAT YOU DO</span><p>${esc(ctx.offering)}</p></div><div><span>IDEAL CUSTOMER</span><p>${esc(ctx.icp)}</p></div><div><span>YOUR VOICE</span><p>${esc(ctx.tone)}, clear, and relevant</p></div></div><div class="context-foot"><div class="inline">${icon('check')}<span style="font-size:11px">Version ${S.context.version} · used to qualify leads and write emails</span></div></div></div>
  <div class="note">${icon('shield')}<span>${sm.contacts ? `${plural(sm.contacts, 'contact')} in your workspace.` : 'Your admin can prepare leads for your campaign.'} Emails use your connected mailbox according to your campaign delivery settings.</span></div>${!sm.contacts ? `<button class="small" style="margin-top:12px" onclick="navigate('campaigns')">${icon('campaign')} View campaigns</button>` : ''}</aside></div>
  <section class="panel"><div class="panel-header"><div><h2>Your campaigns</h2><p>A clear view of what’s running and what needs you.</p></div><button class="small ghost" onclick="navigate('campaigns')">View all ${icon('arrow')}</button></div>${S.campaigns.slice(0, 3).map(campaignRow).join('') || '<p class="subtle">No campaigns yet.</p>'}</section>`;
}
function campaignRow(c) {
  const st = { active: ['Active', 'green'], paused: ['Paused', 'amber'], stopped: ['Stopped', ''], draft: ['Draft', ''] }[c.status];
  return `<div class="campaign-row"><span class="campaign-icon">${icon('campaign')}</span><div class="grow"><h3>${esc(c.name)}</h3><p>${c.status === 'draft' ? 'Draft · ' + flowSteps[c.step] : `${c.config.target} leads/day · ${esc(scheduleSummary(c.config.schedule))} · ${c.config.approval === 'rules' ? 'Automatic eligible drafts' : 'Daily review'}`}</p></div>${badge(st[0], st[1])}<div class="compact-metrics"><span><strong>${c.selected_count}</strong>leads</span><span><strong>${c.sent_count}</strong>sent</span><span><strong>${c.reply_count}</strong>replies</span></div><button class="small ghost" onclick="openCampaign('${esc(c.id)}')">${c.status === 'draft' ? 'Continue' : 'View campaign'} ${icon('chevron')}</button><button class="small ghost" data-campaign-id="${esc(c.id)}" data-campaign-name="${esc(c.name)}" onclick="confirmDeleteCampaign(this.dataset.campaignId,this.dataset.campaignName)">Delete</button></div>`;
}
function usePrompt(s) { S.chat.prompt = s; $('prompt').value = s; $('prompt').focus(); }
async function sendChat() {
  const prompt = ($('prompt')?.value ?? S.chat.prompt).trim();
  S.chat.prompt = prompt;
  if (!prompt) return toast('Describe the audience or campaign you have in mind.');
  S.chat.busy = true; render();
  try { S.chat.brief = await Api.post('/api/campaign-briefs/interpret', { prompt }); }
  catch (e) { fail(e); }
  S.chat.busy = false; render();
}
async function createFromBrief() {
  const b = S.chat.brief;
  try { const c = await Api.post('/api/campaigns', { prompt: b.prompt, brief: b, name: b.name }); S.chat = { prompt: '', brief: null, busy: false }; S.campaigns.unshift(c); openCampaign(c.id); }
  catch (e) { fail(e); }
}
async function newFtpTourCampaign() {
  try { const c = await Api.post('/api/campaigns', {preset:'ftp-soccer-tours'}); S.campaigns.unshift(c); openCampaign(c.id); } catch (e) { fail(e); }
}
async function newCampaign() {
  try { const c = await Api.post('/api/campaigns', {}); S.campaigns.unshift(c); openCampaign(c.id); } catch (e) { fail(e); }
}
function campaignsView() {
  return `<div class="heading"><div><div class="eyebrow">CAMPAIGNS</div><h1>A little structure. Better conversations.</h1><p>Manage your discovery, outreach, and follow-up in one place.</p></div><div class="inline">${S.context?.data?.company?.trim().toLowerCase()==='ftp'?`<button onclick="newFtpTourCampaign()">${icon('plus')} FTP soccer tours</button>`:''}<button class="primary" onclick="newCampaign()">${icon('plus')} New campaign</button></div></div><div class="panel">${S.campaigns.map(campaignRow).join('') || '<div class="empty"><h3>No campaigns yet</h3><p>Start from the assistant on Home, or create one manually.</p></div>'}</div>`;
}

// ---------- Campaign saving ----------
// Edits are applied locally right away and saved in order with the campaign's expected revision.
function saveCampaign(patch, { now = false } = {}) {
  const c = current();
  if (patch.config) for (const [k, v] of Object.entries(patch.config)) c.config[k] = clone(v);
  if ('name' in patch) c.name = patch.name;
  pendingSave = { ...(pendingSave || {}), ...('name' in patch ? { name: patch.name } : {}), config: { ...(pendingSave?.config || {}), ...(patch.config || {}) } };
  clearTimeout(saveTimer);
  setSaving('Saving…');
  if (now) return flushSave();
  saveTimer = setTimeout(flushSave, 450);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(async () => {
    if (!pendingSave) return;
    const body = pendingSave; pendingSave = null;
    if (!Object.keys(body.config).length) delete body.config;
    try {
      const fresh = await Api.patch(`/api/campaigns/${S.cid}`, { ...body, revision: S.c.revision });
      Object.assign(S.c, { revision: fresh.revision, config_version: fresh.config_version, blockers: fresh.blockers, latest_run: fresh.latest_run });
      setSaving('All changes saved');
    } catch (e) {
      setSaving('');
      if (e.status === 409) { toast('This campaign changed elsewhere. Reloaded the latest version.'); await refreshCampaign(); render(); }
      else { S.error = e.message; render(); }
    }
  });
  return saveChain;
}
function setSaving(text) { const el = $('save-state'); if (el) el.textContent = text; }

// ---------- Campaign wizard ----------
function builderView() {
  const c = current();
  if (c.status !== 'draft') return `<div class="panel empty"><h3>This campaign is ${esc(c.status)}</h3><p>Open its insights to manage leads, emails, and sending.</p><button class="primary" onclick="openCampaign('${esc(c.id)}','tracking')">View campaign</button></div>`;
  const full = c.step === 2 || c.step === 3;
  return `<button class="back-link" onclick="navigate('campaigns')">← All campaigns</button><div class="heading"><div><div class="eyebrow">CAMPAIGN STUDIO</div><h1>${esc(c.name)}</h1><p>Find the right people. Give them a reason to reply.</p></div><div class="inline"><span class="helper" id="save-state" style="margin:0"></span>${badge('Email campaign', 'green')}</div></div>
  <div class="step-nav">${flowSteps.map((s, i) => `<button class="${c.step === i ? 'active' : i < c.step ? 'done' : ''}" onclick="goStep(${i})" ${i > c.step ? 'disabled' : ''}><span class="step-num">${i < c.step ? '✓' : i + 1}</span><span class="step-label">${s}</span></button>`).join('')}</div>
  <div class="${full ? '' : 'wizard-grid'}"><div>${[briefView, discoveryView, reviewView, studioView, scheduleView, launchView][c.step](c)}${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ''}</div>${full ? '' : summaryView(c)}</div>
  <div class="footer-actions"><span class="helper">${icon('shield')} ${c.config.delivery==='smtp'?'Approved initial emails send automatically after launch, on your schedule.':'Manual delivery selected: you control every send.'}</span><div class="inline">${c.step ? '<button onclick="goStep(current().step-1)">Back</button>' : ''}<button class="primary" onclick="continueFlow()" ${S.busy || (c.step === 2 && (!S.leads?.selected || S.runs.some(r=>['queued','running'].includes(r.status)))) ? 'disabled' : ''}>${['Configure discovery', 'Review leads', 'Create emails', 'Set schedule', 'Review campaign', 'Launch campaign'][c.step]} ${icon('arrow')}</button></div></div>`;
}
async function goStep(n) {
  await flushSave();
  const c = current(); c.step = n; S.error = ''; clearTimeout(pollTimer);
  render(); window.scrollTo(0, 0);
  try { const fresh = await Api.patch(`/api/campaigns/${c.id}`, { step: n }); if (n === 5) S.c = fresh; await loadViewData(); } catch (e) { fail(e); }
  render();
}
async function continueFlow() {
  const c = current(); S.error = '';
  await flushSave();
  const f = c.config.filters;
  if (c.step === 0 && (!c.name.trim() || !c.config.offer.trim())) S.error = 'Complete the campaign name and offering.';
  else if (c.step === 0 && !f.roles.length && !f.industries.length) S.error = 'Choose at least one job role or industry.';
  else if (c.step === 2 && !S.leads?.selected) S.error = 'Discover and select qualified leads first.';
  else if (c.step === 3 && (!S.drafts?.total || S.drafts.approved < S.drafts.total)) S.error = 'Approve the emails individually or review and approve all.';
  else if (c.step === 4 && (!c.config.schedule.days.length || !c.config.schedule.time)) S.error = 'Choose at least one day and a time.';
  else if (c.step === 5) return launchCampaign();
  if (S.error) return render();
  return goStep(c.step + 1);
}
function summaryView(c) {
  return `<aside class="wizard-aside"><div class="panel"><h2 style="font-size:14px">Campaign at a glance</h2>${[['Workspace', S.context.data.company], ['Context', `${c.prompt ? 'Assistant brief + ' : ''}company context v${c.context.version}`], ['Lead source', c.config.source === 'research' ? 'Research Leads' : 'Your contacts'], ['Daily goal', `${c.config.target} leads · up to 30 per day`], ['Quality threshold', `${c.config.quality}/100 minimum fit`], ['Sender identity', c.context.data.email]].map(([k, v]) => `<div class="summary-row"><small>${k}</small><p>${esc(v)}</p></div>`).join('')}${c.context.version !== S.context.version ? `<button class="small ghost" onclick="useLatestContext()">Use latest company context (v${S.context.version})</button>` : ''}</div><div class="note">${icon('spark')}<span>Strong fit comes first. If fewer than your target qualify, you’ll see the shortfall instead of a lower bar.</span></div></aside>`;
}
async function useLatestContext() {
  try { await flushSave(); S.c = await Api.patch(`/api/campaigns/${S.cid}`, { revision: S.c.revision, context: 'latest' }); toast('Campaign now uses your latest company context. Regenerate drafts to apply it.'); render(); } catch (e) { fail(e); }
}
function field(label, key, value, textarea = false, handler) {
  const h = handler || `saveCampaign({config:{${key}:this.value}})`;
  return `<div class="field"><label for="f-${key}">${label}</label>${textarea ? `<textarea id="f-${key}" oninput="${h}">${esc(value)}</textarea>` : `<input id="f-${key}" value="${esc(value)}" oninput="${h}">`}</div>`;
}
function briefView(c) {
  const f = c.config.filters, cat = S.session.catalog;
  return `<div class="stack"><section class="panel"><div class="panel-header"><div><h2>Give your campaign a direction</h2><p>Choose your audience using filters. Add context only where it helps.</p></div>${icon('campaign')}</div>${field('Campaign name', 'name', c.name, false, 'saveCampaign({name:this.value})')}${field('Your offering', 'offer', c.config.offer, true)}${c.prompt ? `<div class="context-banner">${icon('spark')}<div><strong>Your original assistant brief</strong><p>${esc(c.prompt)}</p></div></div>` : ''}</section>
  <section class="panel"><div class="panel-header"><div><h2>Who’s the right fit?</h2><p>Match any selection within a group, and all selected groups. Missing data never counts as a match.</p></div>${badge('Structured targeting', 'green')}</div>
  ${FILTER_GROUPS.map(([label, key]) => `<div class="field"><label>${label}</label><div class="signals">${[...new Set([...(cat[key] || []), ...f[key]])].map(x => `<button class="${f[key].includes(x) ? 'selected' : ''}" data-filter-group="${key}" data-filter-value="${esc(x)}" onclick="toggleAudienceFilter(this.dataset.filterGroup,this.dataset.filterValue)" aria-pressed="${f[key].includes(x)}">${f[key].includes(x) ? '✓' : '+'} ${esc(x)}</button>`).join('')}</div>${key === 'sizes' || key === 'seniority' ? '' : `<div class="inline" style="margin-top:10px"><input id="custom-${key}" aria-label="Custom ${label}" placeholder="Add another ${label.toLowerCase()}…"><button class="small" onclick="addAudienceFilter('${key}')">Add</button></div>`}</div>`).join('')}
  <div class="field"><label for="audience-notes">Additional context (optional)</label><textarea id="audience-notes" placeholder="For example, prioritize companies building their first outbound team." oninput="saveCampaign({config:{notes:this.value}});$('audience-summary').textContent=filterSummary(current())">${esc(c.config.notes)}</textarea><p class="helper">Notes guide email personalisation; they never override filters or exclusions.</p></div>
  <div class="notice"><span><strong>Your audience summary</strong><br><span id="audience-summary">${esc(filterSummary(c))}</span></span></div></section></div>`;
}
function filterSummary(c) {
  const f = c.config.filters;
  return `${f.roles.join(' or ') || 'Any role'} in ${f.industries.join(' or ') || 'any industry'}, located in ${f.locations.join(' or ') || 'any location'}, at companies with ${f.sizes.join(' or ') || 'any number of'} employees. Seniority: ${f.seniority.join(' or ') || 'any'}.${f.exclude.length ? ' Excluding ' + f.exclude.join(', ').toLowerCase() + '.' : ''}${c.config.notes ? ' ' + c.config.notes : ''}`;
}
function toggleAudienceFilter(k, v) { const f = clone(current().config.filters); f[k] = f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v]; saveCampaign({ config: { filters: f } }); render(); }
function addAudienceFilter(k) { const v = $('custom-' + k).value.trim(); if (!v) return; const f = clone(current().config.filters); if (!f[k].includes(v)) f[k].push(v); saveCampaign({ config: { filters: f } }); render(); }

function discoveryView(c) {
  const cfg = c.config;
  return `<div class="stack">${sourcePicker(c)}
  <section class="panel"><div class="panel-header"><div><h2>Reach out for a reason</h2><p>Optional: select events to require a recent signal, or leave all unselected to assess audience fit.</p></div></div><div class="signals">${S.session.catalog.signals.map(s => `<button class="${cfg.signals.includes(s) ? 'selected' : ''}" onclick="toggleSignal('${s}')">${cfg.signals.includes(s) ? '✓' : '+'} ${s}</button>`).join('')}</div>
  <div class="two-col" style="margin-top:24px"><div class="field"><label for="freshness">Signal recency</label><select id="freshness" onchange="saveCampaign({config:{freshness:+this.value}})">${[7, 30, 90].map(n => `<option value="${n}" ${cfg.freshness === n ? 'selected' : ''}>Last ${n} days</option>`).join('')}</select></div><div class="field"><label for="target">Daily lead target</label><input id="target" type="number" min="1" max="30" value="${cfg.target}" onchange="this.value=Math.min(30,Math.max(1,+this.value||1));saveCampaign({config:{target:+this.value}})"><p class="helper">Choose 1–30 leads. Research is available for one campaign per day (UTC).</p></div></div>
  <label for="quality-number">Minimum fit score</label><div class="inline"><input id="quality-number" type="number" min="70" max="95" step="5" value="${cfg.quality}" aria-label="Minimum fit score" onchange="updateQuality(this.value)" style="max-width:100px"><span>/ 100 (70–95)</span></div><input id="quality" aria-label="Minimum fit score slider" type="range" min="70" max="95" step="5" value="${cfg.quality}" oninput="updateQuality(this.value)">
  <label class="inline" style="margin-top:16px"><input type="checkbox" ${cfg.requireVerifiedEmail ? 'checked' : ''} onchange="saveCampaign({config:{requireVerifiedEmail:this.checked}})"> Require a verified email (unverified addresses go to review)</label>
  <div class="rule-row">${icon('check')}<div><strong>Company and role match</strong><p>Missing role, industry, size, or location data sends a prospect to review instead of counting as a match.</p></div></div><div class="rule-row">${icon('check')}<div><strong>Usable, verified email</strong><p>Invalid, bounced, or suppressed addresses are excluded; unknown or catch-all ones need your review.</p></div></div><div class="rule-row">${icon('check')}<div><strong>Deduplicated and relevant</strong><p>Exclude customers, competitors, opt-outs, and people already contacted.</p></div></div></section></div>`;
}
async function loadSourceStatus(){if(S.cid)S.sources=await Api.get(`/api/campaigns/${S.cid}/sources`);}
async function chooseLeadSource(source){
 if(S.busy||S.uploadBusy)return;
 saveCampaign({config:{source}});render();
 try{await flushSave();await loadSourceStatus();render();}catch(e){fail(e);}
}
function sourcePicker(c){
 const st=S.sources, running=S.runs.some(r=>['queued','running'].includes(r.status));
 const unavailable=!st?.research_ready||st.other_campaign_today||!st.daily_remaining;
 return `<section class="panel"><div class="panel-header"><div><h2>Find your next customers</h2><p>Your admin prepares leads for this campaign. We check them against your audience, exclusions and verified email requirements.</p></div></div>
 <div class="notice">${icon('shield')}<span>${st?.other_campaign_today?'Another campaign uses today’s research allocation. You can still prepare leads for the next available scheduled days.':`${st?.research_ready ?? 0} matching leads available · up to ${c.config.target} leads today · ${st?.daily_remaining ?? 0} remaining (UTC).`}</span></div>
 ${st&&st.research_ready===0?'<p class="helper">No new matching leads are ready yet. Your admin can prepare more for this campaign.</p>':''}
 <div class="toolbar" style="margin-top:16px"><button class="primary" onclick="requestWeeklyLeads()" ${S.busy||running||!st?.research_ready?'disabled':''}>${running?'Checking contacts…':'Prepare upcoming leads'}</button><button onclick="goStep(4)">Review schedule</button><button onclick="requestSourceLeads()" ${S.busy||running||unavailable?'disabled':''}>Get today’s leads</button></div><p class="helper">Set your schedule and daily target before preparing the week. Your reserved dates stay fixed; remaining contacts stay available if the week has insufficient capacity.</p></section>`;
}
async function requestWeeklyLeads(){try{await flushSave();await goStep(2);S.busy=true;render();const r=await Api.post(`/api/campaigns/${S.cid}/weekly-discovery`,{},{idem:Api.key()});S.runs=[r.run,...S.runs.filter(x=>x.id!==r.run.id)];S.runId='all';S.lq={decision:'all',q:'',page:0};S.busy=false;watchRun();render();toast(`${r.assigned} leads reserved starting ${r.first_date}${r.unassigned ? `; ${r.unassigned} remain for another week` : ''}.`);}catch(e){S.busy=false;fail(e);render();}}
async function requestSourceLeads(){try{await flushSave();await goStep(2);await discoverBatch();}catch(e){fail(e);}}
function campaignUploadView(){
 const p=S.uploadPreview,r=S.importResult;
 return `<div style="margin-top:20px"><div class="toolbar"><strong>Your contact list</strong><a class="button small" href="/contact-import-template.csv" download>Download CSV template</a></div>
 <p class="helper">Start with first_name, last_name, email and company. Columns can be in any order. Add role, location and employees so we can check your audience filters. Last-name values may be blank. Up to 5,000 rows / 5 MB.</p>
 <div class="campaign-upload-box"><div>${icon('download')}<strong>Upload your contacts</strong><p class="helper">Choose a CSV to preview before importing.</p></div><button type="button" onclick="$('campaign-csv').click()" ${S.uploadBusy?'disabled':''}>${S.uploadFile?'Choose a different file':'Choose CSV file'}</button><input id="campaign-csv" type="file" hidden accept=".csv,text/csv" aria-label="Upload campaign contacts" onchange="previewCampaignFile(this)" ${S.uploadBusy?'disabled':''}><span class="helper campaign-upload-filename" role="status">${S.uploadFile?esc(S.uploadFile.filename):'CSV files · up to 5 MB'}</span></div>
 ${S.uploadBusy?'<p role="status">Checking your file…</p>':''}
 ${p?`<div class="notice" style="margin-top:16px"><span>${p.valid} contacts ready · ${p.duplicates} duplicate rows skipped · ${p.errors.length} invalid rows</span></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Company</th></tr></thead><tbody>${p.preview.map(x=>`<tr><td>${esc(x.first_name+' '+x.last_name)}</td><td>${esc(x.email)}</td><td>${esc(x.company)}</td></tr>`).join('')}</tbody></table></div>${p.errors.slice(0,8).map(e=>`<p class="helper">Row ${e.line}: ${esc(e.reason)}</p>`).join('')}<p class="helper">Uploaded email addresses need verification or manual review. Importing does not send emails.</p><button class="primary" onclick="confirmCampaignImport()" ${S.uploadBusy||p.errors.length||!p.valid?'disabled':''}>Import ${p.valid} contacts</button>`:''}
 ${r?`<div class="notice" role="status">${r.linked} contacts added to this campaign. ${r.created_count} new · ${r.updated_count} updated · ${r.duplicates} duplicate rows skipped.</div>`:''}</div>`;
}
async function previewCampaignFile(input){
 const file=input.files?.[0];if(!file)return;
 if(file.size>5_000_000){toast('Choose a CSV up to 5 MB.');return;}
 const cid=S.cid;S.uploadBusy=true;S.uploadPreview=null;S.uploadFile=null;S.importResult=null;render();
 try{const csv=await file.text();const preview=await Api.post(`/api/campaigns/${cid}/import-preview`,{csv});if(cid===S.cid){S.uploadPreview=preview;S.uploadFile={filename:file.name,csv};}}catch(e){fail(e);}finally{if(cid===S.cid){S.uploadBusy=false;render();}}
}
async function confirmCampaignImport(){
 if(!S.uploadFile||S.uploadBusy)return;const cid=S.cid;S.uploadBusy=true;render();
 try{await flushSave();const result=await Api.post(`/api/campaigns/${cid}/imports`,S.uploadFile,{idem:Api.key()});if(cid===S.cid){S.importResult=result;S.uploadFile=null;S.uploadPreview=null;await Promise.all([loadSourceStatus(),refreshSummary()]);toast('Contacts imported. Continue to check their campaign fit.');}}catch(e){fail(e);}finally{if(cid===S.cid){S.uploadBusy=false;render();}}
}
function updateQuality(value) { const n = Math.min(95, Math.max(70, Math.round((Number(value) || 70) / 5) * 5)); if ($('quality-number')) $('quality-number').value = n; if ($('quality')) $('quality').value = n; saveCampaign({config:{quality:n}}); }
function toggleSignal(s) { const c = current(); const list = c.config.signals.includes(s) ? c.config.signals.filter(x => x !== s) : [...c.config.signals, s]; saveCampaign({ config: { signals: list } }); render(); }

// ---------- Discovery and lead review ----------
async function loadRuns() { S.runs = (await Api.get(`/api/campaigns/${S.cid}/batches`)).items; watchRun(); }
async function loadLeads() {
  const q = S.lq;
  S.leads = await Api.get(`/api/campaigns/${S.cid}/leads?decision=${q.decision}&q=${encodeURIComponent(q.q)}&page=${q.page}&page_size=7&run_id=${S.runId}`);
}
function watchRun() {
  const r = S.runs[0];
  if (!r || !['queued', 'running'].includes(r.status)) return;
  const cid = S.cid;
  poll(async () => {
    if (S.cid !== cid) return false;
    const run = await Api.get(`/api/runs/${r.id}`);
    S.runs[0] = run;
    if (['queued', 'running'].includes(run.status)) { const el = $('run-progress'); if (el) el.textContent = run.progress?.total ? `${run.progress.checked} of ${run.progress.total} candidates checked` : 'Queued…'; return true; }
    await Promise.all([loadLeads(), refreshCampaign(), refreshSummary(), loadSourceStatus()]);
    if (run.status === 'failed') toast(run.error || 'Discovery failed.');
    render(); return false;
  });
}
async function discoverBatch() {
  if (S.busy) return;
  S.busy = true; render();
  try { await flushSave(); const run = await Api.post(`/api/campaigns/${S.cid}/discovery-runs`, {}, { idem: Api.key() }); S.runs = [run, ...S.runs.filter(r => r.id !== run.id)]; S.runId = 'all'; S.lq = { decision: 'all', q: '', page: 0 }; await loadSourceStatus(); watchRun(); }
  catch (e) { fail(e); }
  S.busy = false; render();
}
function reviewView(c) {
  const run = S.runs[0], running = run && ['queued', 'running'].includes(run.status);
  if (running || !S.runs.length) return `<div class="stack">${sourcePicker(c)}${running?`<div class="notice" role="status">${icon('spark')}<div><strong>Checking your campaign matches…</strong><p id="run-progress" class="helper">Checking contact details, fit and exclusions.</p></div></div>`:''}</div>`;

  const L = S.leads;
  if (!L) return loadingPanel('Loading leads…');
  const viewRun = S.runId === 'all' ? null : S.runs.find(r => r.id === S.runId);
  const qualified = viewRun ? viewRun.qualified : (L.counts.qualified || 0), target = c.config.target;
  const stale = c.latest_run && c.latest_run.config_version < c.config_version;
  return `${sourcePicker(c)}<div class="discovery-hero" style="margin-top:20px"><div class="discovery-count">${qualified}<small> / ${target}</small></div><div class="grow"><h3>${qualified >= target ? 'Quality-checked prospects, ready for you.' : 'Quality first. This batch is below target.'}</h3><p>${S.runs.length > 1 ? `${S.runs.length} batches · ` : ''}latest batch ${run.batch}: ${run.candidates} candidates checked, ${run.status}${run.finished_at ? ' ' + fmtDate(run.finished_at) : ''}</p></div><select aria-label="Batch" style="max-width:190px" onchange="S.runId=this.value;S.lq.page=0;reloadLeads()"><option value="all">All batches</option>${S.runs.map(r => `<option value="${esc(r.id)}" ${S.runId === r.id ? 'selected' : ''}>Batch ${r.batch} · ${fmtDay(r.created_at)} · ${r.qualified} qualified</option>`).join('')}</select>${c.status !== 'stopped' ? `<button class="small ghost" onclick="discoverBatch()" ${S.busy ? 'disabled' : ''}>Run discovery again</button>` : ''}</div>
  ${run.status === 'failed' ? `<div class="notice amber" style="margin-bottom:20px">${icon('shield')}Batch ${run.batch} failed: ${esc(run.error)}. Run discovery again to retry.</div>` : ''}
  ${run.shortfall_reason ? `<div class="notice ${qualified < target ? 'amber' : ''}" style="margin-bottom:20px">${icon('shield')}${esc(run.shortfall_reason)}</div>` : ''}
  ${stale ? `<div class="notice" style="margin-bottom:20px">${icon('spark')}Campaign settings changed after the latest batch. Existing leads keep their original assessment; run discovery again to apply the new settings to new contacts.</div>` : ''}
  <div class="panel"><div class="tabs">${[['all', 'All leads'], ['qualified', 'Qualified'], ['review', 'Needs review'], ['excluded', 'Excluded']].map(([k, n]) => `<button class="${S.lq.decision === k ? 'active' : ''}" onclick="S.lq.decision='${k}';S.lq.page=0;reloadLeads()">${n} ${badge(k==='all'?Object.values(L.counts).reduce((a,b)=>a+Number(b),0):(L.counts[k] || 0))}</button>`).join('')}</div>
  <div class="toolbar"><div class="search">${icon('search')}<input id="lead-search" aria-label="Search prospects" placeholder="Search people or companies" value="${esc(S.lq.q)}" oninput="S.lq.q=this.value;S.lq.page=0;clearTimeout(window._st);window._st=setTimeout(reloadLeads,300)"></div><span class="subtle">${L.selected} selected for email drafts</span><button class="small" onclick="selectTopLeads()">Select top ${target} qualified</button><button class="small ghost" onclick="clearSelection()">Clear selection</button></div>
  <div id="lead-results">${leadTable(c)}</div><p class="helper">Click a prospect to see the checks and evidence behind their fit.</p></div>`;
}
async function reloadLeads() { try { await loadLeads(); const el = $('lead-results'); if (el && S.lq.q) { el.innerHTML = leadTable(current()); return; } render(); if (S.lq.q) { const i = $('lead-search'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); } } catch (e) { fail(e); } }
function leadTable() {
  const L = S.leads, start = L.page * L.page_size;
  return `<div class="table-wrap"><table><thead><tr><th></th><th>Prospect</th><th>Company</th><th>Top signal</th><th>Fit</th><th>Email</th><th></th></tr></thead><tbody>${L.items.map(l => `<tr><td><input type="checkbox" aria-label="Select ${esc(l.name)}" onchange="toggleLead('${esc(l.id)}',this.checked)" ${l.selected ? 'checked' : ''} ${l.decision !== 'qualified' || l.send_status === 'sent' ? 'disabled' : ''}></td><td><div class="person"><span class="avatar">${initials(l.name)}</span><div><strong>${esc(l.name)}</strong><small>${esc(l.role)}</small></div></div></td><td>${esc(l.company)}<small>${esc([l.industry, l.employees && l.employees + ' employees'].filter(Boolean).join(' · '))}</small></td><td>${l.evidence[0]?.signal ? badge(l.evidence[0].signal) : '<span class="subtle">—</span>'}</td><td><span class="score-ring">${l.score}</span></td><td>${emailBadge(l.suppressed ? 'invalid' : l.email_status)}</td><td><button class="icon-btn ghost" aria-label="Inspect ${esc(l.name)}" onclick="S.leadId='${esc(l.id)}';S.modal='lead';render()">${icon('chevron')}</button></td></tr>`).join('') || '<tr><td colspan="7">No prospects match this view.</td></tr>'}</tbody></table></div>
  <div class="table-bottom"><span>${L.total ? `${start + 1}–${Math.min(start + L.page_size, L.total)} of ${L.total} prospects` : 'No prospects'}</span><div class="inline"><button class="small ghost" ${L.page === 0 ? 'disabled' : ''} onclick="S.lq.page--;reloadLeads()">← Previous</button><button class="small ghost" ${start + L.page_size >= L.total ? 'disabled' : ''} onclick="S.lq.page++;reloadLeads()">Next →</button></div></div>`;
}
async function toggleLead(id, selected) { try { await Api.patch(`/api/campaign-leads/${id}`, { selected }); await loadLeads(); render(); } catch (e) { fail(e); await loadLeads(); render(); } }
async function selectTopLeads() {
  try {
    const all = await Api.get(`/api/campaigns/${S.cid}/leads?decision=qualified&page_size=100&run_id=${S.runId}`);
    const top = all.items.slice().sort((a, b) => b.score - a.score).slice(0, current().config.target).map(l => l.id);
    await Api.post(`/api/campaigns/${S.cid}/lead-selection`, { lead_ids: all.items.filter(l => l.selected && !top.includes(l.id) && l.send_status !== 'sent').map(l => l.id), selected: false });
    await Api.post(`/api/campaigns/${S.cid}/lead-selection`, { lead_ids: top, selected: true });
    await loadLeads(); render();
  } catch (e) { fail(e); }
}
async function clearSelection() {
  try { const all = await Api.get(`/api/campaigns/${S.cid}/leads?decision=all&selected=1&page_size=100`); await Api.post(`/api/campaigns/${S.cid}/lead-selection`, { lead_ids: all.items.filter(l => l.send_status !== 'sent').map(l => l.id), selected: false }); await loadLeads(); render(); } catch (e) { fail(e); }
}
async function excludeLead(id) {
  try { await Api.patch(`/api/campaign-leads/${id}`, { decision: 'excluded', reason: 'Manually excluded from this campaign.' }); S.modal = null; await loadLeads(); render(); toast('Prospect excluded.'); } catch (e) { fail(e); }
}
async function qualifyLead(id) {
  const reason = $('qualify-reason')?.value.trim();
  if (!reason) return toast('Explain why this lead qualifies.');
  try { await Api.patch(`/api/campaign-leads/${id}`, { decision: 'qualified', reason }); S.modal = null; await loadLeads(); render(); toast('Lead qualified. Select it to include it in this batch.'); } catch (e) { fail(e); }
}

// ---------- Email studio ----------
async function loadDrafts(autostart = false) {
  const d = await Api.get(`/api/campaigns/${S.cid}/drafts`);
  S.drafts = d;
  const missing = d.items.some(x => !x.draft), running = d.job && ['queued', 'running'].includes(d.job.status);
  if (autostart && missing && !running && d.job?.status !== 'dead') { await Api.post(`/api/campaigns/${S.cid}/draft-runs`, {}, { idem: Api.key() }); S.drafts.job = { status: 'queued' }; }
  if (missing || running || S.drafts.job?.status === 'queued') {
    const cid = S.cid;
    poll(async () => { if (S.cid !== cid || !['builder', 'emails'].includes(S.view)) return false; const n = await Api.get(`/api/campaigns/${cid}/drafts`); S.drafts = n; const busy = n.job && ['queued', 'running'].includes(n.job.status); if (!busy) render(); else { const el = $('draft-progress'); if (el) el.textContent = `${n.items.filter(x => x.draft).length} of ${n.total} drafts ready`; } return busy; }, 1200);
  }
}
function activeItem() { const items = S.drafts?.items || []; return items.find(x => x.lead.id === S.messageLead) || items[0]; }
function studioView(c) {
  const D = S.drafts;
  if (!D) return loadingPanel('Loading drafts…');
  if (!D.total) return D.scheduled_future ? `<div class="panel empty"><h3>No drafts due today</h3><p>${D.scheduled_future} prospects are planned for upcoming days. Their drafts will be prepared on the assigned day.</p></div>` : `<div class="panel empty"><h3>No qualified leads selected</h3><p>Go back to lead review to select prospects.</p></div>`;
  const busy = D.job && ['queued', 'running'].includes(D.job.status);
  const grouped = [...new Set(D.items.map(x=>x.lead.slot_date).filter(Boolean))].sort();
  const shown = S.weekDay && S.weekDay !== 'all' ? D.items.filter(x=>x.lead.slot_date===S.weekDay) : D.items;
  const item = shown.find(x=>x.lead.id===S.messageLead) || shown[0] || D.items[0]; S.messageLead = item.lead.id;
  const l = item.lead, d = item.draft, w = c.config.writing, ctx = c.context.data;
  const evidence = d ? l.evidence.filter(e => d.evidence_ids.includes(e.id)) : [];
  return `<div class="panel" style="margin-bottom:20px"><div class="panel-header"><div><h2>Emails that sound like you</h2><p>Today’s drafts are prepared from your campaign context and lead evidence. Future days are drafted on their assigned day.</p></div><button class="primary small" onclick="openBulk()" ${busy || !d ? 'disabled' : ''}>Review & approve all</button></div>
  <div class="three-col">${[['Tone', 'tone', ['Conversational', 'Professional', 'Warm']], ['Length', 'length', ['Balanced', 'Concise']], ['Personalization angle', 'angle', ['Signal-led', 'Company-led']], ['Call to action', 'cta', ['Start a conversation', 'Book a meeting', 'Ask permission']]].map(([label, key, opts]) => `<div><label for="opt-${key}">${label}</label><select id="opt-${key}" onchange="changeWriting('${key}',this.value)" ${busy ? 'disabled' : ''}>${opts.map(o => `<option ${w[key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`).join('')}</div>
  ${grouped.length ? `<div class="field" style="margin-top:16px"><label for="week-day">Review by scheduled day</label><select id="week-day" onchange="S.weekDay=this.value;S.messageLead=null;render()"><option value="all">All days · ${D.total} recipients</option>${grouped.map(day=>`<option value="${esc(day)}" ${S.weekDay===day?'selected':''}>${esc(day)} · ${D.items.filter(x=>x.lead.slot_date===day).length} recipients · ${D.items.filter(x=>x.lead.slot_date===day&&x.draft?.approved).length} approved</option>`).join('')}</select><p class="helper">Choose a day to review and approve its drafts, or choose all days to review the full week.</p></div>` : ''}<div class="approval-progress"><span style="width:${D.approved / D.total * 100}%"></span></div><span class="helper" id="approved-count">${D.approved} of ${D.total} drafts approved · approval applies to the exact wording; edits need fresh approval</span>
  ${busy ? `<div class="notice" style="margin-top:12px">${icon('spark')}<span>Writing drafts with ${esc(aiLabel())}… <span id="draft-progress">${D.items.filter(x => x.draft).length} of ${D.total} drafts ready</span></span></div>` : ''}
  ${D.job?.status === 'dead' ? `<div class="notice amber" style="margin-top:12px">${icon('shield')}<span>Drafting failed: ${esc(D.job.last_error)}. <button class="small" onclick="regenerate(false)">Retry</button></span></div>` : ''}</div>
  <div class="editor-layout"><aside class="recipient-list"><div class="list-label">${D.total} RECIPIENTS</div>${shown.slice(0, 8).map(x => recipientButton(x, l)).join('')}${shown.length > 8 ? `<div style="padding:15px"><label for="other-lead">All ${D.total} recipients</label><select id="other-lead" onchange="selectRecipient(this.value)">${shown.map(x => `<option value="${esc(x.lead.id)}" ${x.lead.id === l.id ? 'selected' : ''}>${esc(x.lead.name)}${x.draft?.approved ? ' ✓' : ''}</option>`).join('')}</select></div>` : ''}</aside>
  <section class="editor-main">${!d ? `<div class="empty">${busy ? '<div class="progress-track"></div>' : ''}<p>${busy ? 'Drafting this email…' : 'No draft yet.'}</p></div>` : `
    <div class="email-meta"><span>To</span>${esc(l.name)} &lt;${esc(l.email)}&gt; ${emailBadge(l.email_status)}</div><div class="email-meta"><span>From</span>${esc(ctx.sender)} &lt;${esc(ctx.email)}&gt; <small class="subtle">· ${c.config.delivery === 'smtp' ? 'sent through your connected mailbox after approval and launch' : 'you send this from your mailbox'}</small></div>
    <div class="email-meta"><label for="email-subject" style="margin:0;color:var(--muted);min-width:38px">Subject</label><input id="email-subject" value="${esc(d.subject)}" onchange="saveDraftEdit()" ${l.send_status === 'sent' ? 'disabled' : ''}></div>
    <textarea class="email-body" id="email-body" aria-label="Personalized email body" onchange="saveDraftEdit()" ${l.send_status === 'sent' ? 'disabled' : ''}>${esc(d.body)}</textarea>
    ${d.review_note ? `<div class="notice amber">${icon('shield')}${esc(d.review_note)}</div>` : ''}${d.stale ? `<div class="notice">${icon('spark')}Written with earlier campaign settings. <button class="small ghost" onclick="regenerate(true)">Regenerate outdated drafts</button></div>` : ''}
    <div class="evidence-box"><strong>${icon('spark')} Why this email is relevant</strong>${evidence.length ? evidence.map(e => `${esc(e.fact)} <small class="subtle">${e.event_date ? '· ' + esc(e.event_date) : ''} ${e.source_url ? `· <a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</small>`).join('<br>') : 'No signal evidence cited in this draft.'}<br>Matches: ${esc(l.role)} · ${l.score}/100 fit · ${esc(l.rationale)}</div>
    <div class="rewrite-bar"><span class="helper" style="margin:0 3px 0 0">Refine</span><button onclick="rewrite('human')" ${l.send_status === 'sent' ? 'disabled' : ''}>${icon('spark')} More natural</button><button onclick="rewrite('short')" ${l.send_status === 'sent' ? 'disabled' : ''}>Shorter</button><button onclick="rewrite('direct')" ${l.send_status === 'sent' ? 'disabled' : ''}>More direct</button></div>
    <div class="email-footer"><span class="helper">Revision ${d.rev} · ${esc(generatorLabel(d.generator))}</span>${l.send_status === 'sent' ? badge('Sent', 'green') : `<button id="approve-one" class="${d.approved ? 'ghost' : 'primary'} small" onclick="approveOne()">${d.approved ? '✓ Approved' : 'Approve email'}</button>`}</div>`}</section></div>`;
}
function recipientButton(x, l) { return `<button class="${x.lead.id === l.id ? 'active' : ''}" onclick="selectRecipient('${esc(x.lead.id)}')"><span class="avatar">${initials(x.lead.name)}</span><span class="grow"><strong>${esc(x.lead.name)}</strong><small>${esc(x.lead.company)}</small></span>${x.draft?.approved ? icon('check') : ''}</button>`; }
async function selectRecipient(id) { await saveDraftEdit(); S.messageLead = id; render(); }
function changeWriting(key, value) {
  const c = current(), n = S.drafts?.items.filter(x => x.draft && x.lead.send_status !== 'sent').length || 0;
  S.modal = 'regen'; S.modalData = { key, value, n }; render();
}
async function confirmWriting() {
  const { key, value } = S.modalData; S.modal = null;
  const w = { ...current().config.writing, [key]: value };
  saveCampaign({ config: { writing: w } }, { now: true });
  await flushSave();
  await regenerate(true);
}
async function regenerate(stale) {
  try { await Api.post(`/api/campaigns/${S.cid}/draft-runs`, { regenerate: stale }, { idem: Api.key() }); S.drafts.job = { status: 'queued' }; render(); await loadDrafts(); render(); toast('Writing new drafts. Review and approve the new wording.'); } catch (e) { fail(e); }
}
function replaceDraft(leadId, draft) { const x = S.drafts.items.find(i => i.lead.id === leadId); const was = x.draft?.approved; x.draft = draft; S.drafts.approved += (draft.approved ? 1 : 0) - (was ? 1 : 0); }
async function saveDraftEdit() {
  const item = activeItem(), d = item?.draft, s = $('email-subject'), b = $('email-body');
  if (!d || !s || !b || (s.value === d.subject && b.value === d.body)) return d;
  try {
    const next = await Api.patch(`/api/drafts/${d.id}`, { revision_id: d.revision_id, subject: s.value, body: b.value });
    replaceDraft(item.lead.id, next);
    const btn = $('approve-one'); if (btn) { btn.textContent = 'Approve email'; btn.className = 'primary small'; }
    const cnt = $('approved-count'); if (cnt) cnt.textContent = `${S.drafts.approved} of ${S.drafts.total} drafts approved · edits need fresh approval`;
    return next;
  } catch (e) {
    fail(e);
    if (e.status === 409 && e.body.draft) { replaceDraft(item.lead.id, e.body.draft); render(); }
    return null;
  }
}
async function rewrite(style) {
  const item = activeItem();
  if (!item?.draft) return;
  const saved = await saveDraftEdit(); if (!saved) return;
  S.busy = true; toast('Rewriting…');
  try { replaceDraft(item.lead.id, await Api.post(`/api/drafts/${saved.id}/rewrites`, { revision_id: saved.revision_id, style })); render(); toast('Rewrite ready for review.'); } catch (e) { fail(e); }
  S.busy = false;
}
async function approveOne() {
  const item = activeItem(), saved = await saveDraftEdit();
  if (!saved) return;
  if (!saved.subject.trim() || !saved.body.trim()) return toast('Add a subject and message first.');
  try {
    const r = await Api.post('/api/approvals', { items: [{ draft_id: saved.id, revision_id: saved.revision_id }] }, { idem: Api.key() });
    const res = r.results[0];
    if (res.status !== 'approved') { toast(res.message); await loadDrafts(); render(); return; }
    replaceDraft(item.lead.id, { ...saved, approved: true });
    const next = S.drafts.items.find(x => x.draft && !x.draft.approved);
    if (next) S.messageLead = next.lead.id;
    render(); toast('Email approved.');
  } catch (e) { fail(e); }
}
async function openBulk() { await saveDraftEdit(); S.modal = 'bulk'; render(); }
async function approveAll() {
  if (!$('bulk-check').checked) return toast('Confirm you reviewed the drafts.');
  const items = S.drafts.items.filter(x => (S.weekDay==='all'||!S.weekDay||x.lead.slot_date===S.weekDay) && x.draft && !x.draft.approved).map(x => ({ draft_id: x.draft.id, revision_id: x.draft.revision_id }));
  if (!items.length) { S.modal = null; render(); return; }
  try {
    const r = await Api.post('/api/approvals', { confirm: true, items }, { idem: Api.key() });
    S.modal = null; await loadDrafts(); render();
    toast(r.failed ? `${r.approved} approved; ${r.failed} need attention: ${r.results.find(x => x.status !== 'approved').message}` : `${r.approved} emails approved.`);
  } catch (e) { fail(e); }
}
function emailsView() {
  const c = current();
  return `<button class="back-link" onclick="openCampaign('${esc(c.id)}','tracking')">← Campaign insights</button><div class="heading"><div><div class="eyebrow">EMAIL STUDIO</div><h1>${esc(c.name)}</h1><p>Approved emails for this live campaign go straight to your send queue.</p></div></div>${studioView(c)}`;
}

// ---------- Schedule and launch ----------
function scheduleSummary(s) { return s.days.map(d => `${d} ${s.times?.[d] ?? s.time}`).join(', ') + ' ' + s.timezone; }
function scheduleView(c) {
  const s = c.config.schedule, zones = TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
  return `<div class="stack"><section class="panel"><div class="panel-header"><div><h2>A daily rhythm that works for you</h2><p>Set your lead allocation days and the earliest sending time for approved emails.</p></div>${icon('calendar')}</div>
  <div class="field"><label>Run on</label><div class="day-picker">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<button class="${s.days.includes(d) ? 'selected' : ''}" onclick="toggleDay('${d}')">${d}</button>`).join('')}</div></div>
  <div class="two-col"><div class="field"><label for="run-time">Default time</label><input id="run-time" type="time" value="${esc(s.time)}" onchange="saveCampaign({config:{schedule:{...current().config.schedule,time:this.value}}})"></div><div class="field"><label for="timezone">Timezone</label><select id="timezone" onchange="saveCampaign({config:{schedule:{...current().config.schedule,timezone:this.value}}})">${zones.map(z => `<option ${s.timezone === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div></div>
  <div class="field"><label>Time for each selected day</label><p class="helper">Choose a different time per day if needed. On an active SMTP campaign, approval after that day’s time makes an eligible email due immediately.</p><div class="two-col">${s.days.map(d => `<div class="field"><label for="day-time-${esc(d)}">${esc(d)}</label><input id="day-time-${esc(d)}" type="time" value="${esc(s.times?.[d] ?? s.time)}" onchange="setDayTime('${d}',this.value)"></div>`).join('')}</div></div>
  <label>Approval for future daily batches</label>
  <div class="schedule-card ${c.config.approval==='daily'?'active':''}"><label><input type="radio" name="approval" ${c.config.approval==='daily'?'checked':''} onchange="saveCampaign({config:{approval:'daily'}});render()">Review every daily batch</label><p>New drafts wait for your approval.</p></div>
  <div class="schedule-card ${c.config.approval==='rules'?'active':''}"><label><input type="radio" name="approval" ${c.config.approval==='rules'?'checked':''} onchange="saveCampaign({config:{approval:'rules'}});render()">Automatically approve future generated drafts</label><p>After you approve the first batch and authorise launch, eligible future drafts use this campaign’s settings and company context. Flagged drafts still need review.</p></div>
  <label style="margin-top:18px">Delivery</label>
  <div class="schedule-card ${c.config.delivery==='smtp'?'active':''}"><label><input type="radio" name="delivery" ${c.config.delivery==='smtp'?'checked':''} onchange="saveCampaign({config:{delivery:'smtp'}});render()">Automatic SMTP delivery</label><p>After launch, approved initial emails send automatically on your selected days, from the selected time, up to ${c.config.target} per day. Connect your mailbox first. Future drafts follow your chosen approval mode. Follow-ups require an inbox check.</p></div>
  <div class="schedule-card ${c.config.delivery!=='smtp'?'active':''}"><label><input type="radio" name="delivery" ${c.config.delivery!=='smtp'?'checked':''} onchange="saveCampaign({config:{delivery:'manual'}});render()">Manual send tasks</label><p>Send approved emails yourself and confirm each send.</p></div>
  <div class="notice">${icon('shield')}<span>Weekly leads keep their reserved dates. If approval arrives after the assigned day, the email is held for review. Sending depends on the background scheduler and mailbox availability.</span></div></section>
  <section class="panel"><h2>Follow-ups have their own workspace</h2><p class="subtle">Launch your initial campaign first. Then open Sequences to draft, approve, and schedule follow-ups measured from each recipient’s own first email.</p><div class="timeline"><div class="timeline-item"><span class="time-dot">1</span><div><strong>Scheduled time · Find and qualify</strong><p>Check up to ${c.config.target} new high-fit prospects.</p></div></div><div class="timeline-item"><span class="time-dot">2</span><div><strong>Write personalized emails</strong><p>Use your company context and each prospect’s evidence.</p></div></div><div class="timeline-item"><span class="time-dot">3</span><div><strong>Wait for your approval</strong><p>Approved messages enter your send queue.</p></div></div></div></section></div>`;
}
function setDayTime(d,value) { const s=current().config.schedule; saveCampaign({config:{schedule:{...s,times:{...(s.times||{}),[d]:value}}}}); }
function toggleDay(d) { const s = current().config.schedule; saveCampaign({ config: { schedule: { ...s, days: s.days.includes(d) ? s.days.filter(x => x !== d) : [...s.days, d] } } }); render(); }
function launchView(c) {
  const cfg = c.config, b = c.blockers || [];
  return `<div class="launch-hero"><span class="ai-mark">${icon('campaign')}</span><div><h2>Ready for your first conversation.</h2><p>Here’s exactly what you’re launching.</p></div></div><section class="panel"><div class="review-grid">${[['Audience', filterSummary(c)], ['Source', cfg.source === 'research' ? 'Research Leads' : 'Your contacts'], ['First batch', `${S.drafts?.total ?? '—'} selected prospects`], ['Approved drafts', `${S.drafts?.approved ?? '—'} emails`], ['Daily goal', cfg.target + ' prospects · quality first'], ['Schedule', scheduleSummary(cfg.schedule)], ['Approval', cfg.approval==='rules'?'Automatic for eligible future drafts':'Review every day'], ['Delivery', cfg.delivery==='smtp'?'Automatic SMTP after approval':`Manual — you send from ${c.context.data.email}`]].map(([k, v]) => `<div class="review-item"><small>${k}</small><strong>${esc(v)}</strong></div>`).join('')}</div>
  ${b.length ? `<div class="notice amber">${icon('shield')}<span><strong>Before you launch</strong><br>${b.map(x => esc(x.message)).join('<br>')}</span></div>` : `<div class="checklist"><div>${icon('check')} Only emails with approval for their exact wording can be sent</div><div>${icon('check')} Poor-fit, excluded, and suppressed prospects held back</div><div>${icon('check')} Follow-ups stop on replies, bounces, and opt-outs you record</div></div>`}
  <label class="context-banner"><input id="launch-check" type="checkbox"><span>${cfg.delivery==='smtp'?(cfg.approval==='rules'?'I authorise automatic approval of eligible future generated drafts and scheduled sending from my connected mailbox. Flagged drafts require review.':'I authorise scheduled sending of approved initial emails from my connected mailbox. Future batches require approval.'):'I understand that launching adds approved emails to my manual send queue.'}</span></label></section>`;
}
async function launchCampaign() {
  const c = current();
  if (!$('launch-check')?.checked) { S.error = 'Confirm how sending works to launch.'; return render(); }
  S.busy = true; render();
  try {
    await flushSave(); await refreshCampaign();
    const r = await Api.post(`/api/campaigns/${c.id}/launch`, { revision: S.c.revision, authorize_automatic: S.c.config.approval === 'rules' }, { idem: 'launch-' + c.id + '-' + S.c.revision });
    S.c = r; S.busy = false; S.view = 'tracking'; S.insightTab = 'overview'; setHash(`#/campaign/${c.id}/tracking`);
    await Promise.all([loadViewData(), refreshSummary()]);
    render(); window.scrollTo(0, 0); toast(`Campaign launched. ${plural(r.created_tasks, 'email')} ready in your send queue.`);
  } catch (e) { S.busy = false; S.error = e.message; await refreshCampaign().catch(() => {}); render(); }
}

// ---------- Campaign insights ----------
function trackingView() {
  const c = current(), m = S.metrics;
  const st = { active: ['Active', 'green'], paused: ['Paused', 'amber'], stopped: ['Stopped', ''] }[c.status] || ['Draft', ''];
  return `<button class="back-link" onclick="navigate('campaigns')">← All campaigns</button><div class="heading"><div><div class="inline"><span class="eyebrow">CAMPAIGN INSIGHTS</span>${badge(st[0], st[1])}</div><h1>${esc(c.name)}</h1><p>${c.config.target} leads/day · ${esc(scheduleSummary(c.config.schedule))} · ${c.config.approval==='rules'?'Automatic eligible drafts':'Daily approval'} · ${c.config.delivery==='smtp'?'Scheduled SMTP':'Manual sending'}</p></div>
  <div class="inline">${c.status === 'stopped' ? '' : `<button onclick="campaignAction('${c.status === 'paused' ? 'resume' : 'pause'}')">${icon('pause')}${c.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="ghost" onclick="S.modal='stop';render()">Stop</button>`}<button class="primary" onclick="openCampaign('${esc(c.id)}','emails')">Review emails ${icon('arrow')}</button></div></div>
  <div class="tabs">${[['overview', 'Overview'], ['leads', 'Leads'], ['queue', 'Send queue'], ['activity', 'Activity']].map(([v, t]) => `<button class="${S.insightTab === v ? 'active' : ''}" onclick="insightTab('${v}')">${t}</button>`).join('')}</div>
  ${S.insightTab === 'leads' ? reviewView(c) : S.insightTab === 'queue' ? tasksPanel() : S.insightTab === 'activity' ? activityPanel() : !m ? loadingPanel() : overviewPanel(c, m)}`;
}
async function insightTab(t) { S.insightTab = t; S.lq = { decision: 'qualified', q: '', page: 0 }; render(); try { await loadViewData(); } catch (e) { fail(e); } render(); }
function overviewPanel(c, m) {
  const max = Math.max(5, ...m.series.qualified, ...m.series.sent);
  const awaiting = m.daily?.planned ? m.daily.awaiting : Math.max(0,m.selected - m.drafts_approved);
  const daily=m.daily;
  return `${daily ? `<section class="panel" style="margin-bottom:18px"><div class="panel-header"><div><h2>Today’s outreach</h2><p>${esc(daily.date)} · ${esc(daily.timezone)}</p></div><button class="primary small" onclick="openCampaign('${esc(c.id)}','emails')">Review today’s emails</button></div><div class="stats-four">${stat('Planned today',daily.planned,'Weekly leads','people')}${stat('Drafts ready',daily.drafted,`${daily.awaiting} awaiting approval`,'spark')}${stat('Sent today',daily.sent_today,'Accepted or manually confirmed','mail')}${stat('Sent yesterday',daily.sent_yesterday,'Accepted or manually confirmed','chart')}</div></section>` : ''}<div class="banner-review">${icon('spark')}<div class="grow"><strong>${m.queued ? `${plural(m.queued, 'email')} waiting in your send queue` : awaiting > 0 ? `${plural(awaiting, 'prospect')} waiting for email approval` : 'You’re all caught up'}</strong><p>${S.runs[0] ? `Latest batch ${S.runs[0].batch}: ${S.runs[0].qualified} qualified (${esc(S.runs[0].status)}).` : 'No batches yet.'} The next batch runs on the schedule above.</p></div>${m.queued ? `<button class="small" onclick="insightTab('queue')">Open send queue</button>` : ''}<button class="small ghost" onclick="discoverBatch().then(()=>insightTab('leads'))" ${c.status !== 'active' ? 'disabled' : ''}>Run discovery now</button></div>
  <div class="stats-four">${stat('Qualified leads', m.qualified, `${m.candidates} candidates checked · ${plural(m.batches, 'batch').replace('batchs', 'batches')}`, 'people')}${stat('Emails sent', m.sent, 'SMTP accepted or manually confirmed', 'mail')}${stat('Replies', m.replies, m.reply_rate == null ? 'Recorded manually' : `${m.reply_rate}% of contacted · recorded manually`, 'chart')}${stat('Meetings', m.meetings, 'Recorded manually', 'calendar')}</div>
  <div class="insight-grid"><section class="panel"><div class="panel-header"><div><h2>Last 7 days</h2><p>Qualified leads and confirmed sends per day (${esc(c.config.schedule.timezone)})</p></div><div class="legend"><span><i></i>Qualified</span><span><i class="dark"></i>Sent</span></div></div><div class="chart">${m.series.days.map((d, i) => `<div class="bar-group" title="${d}: ${m.series.qualified[i]} qualified; ${m.series.sent[i]} sent"><span class="bar" style="height:${m.series.qualified[i] / max * 100}%"></span><span class="bar dark" style="height:${m.series.sent[i] / max * 100}%"></span></div>`).join('')}</div><div class="chart-labels">${m.series.days.map((d, i) => `<span>${i === 6 ? 'Today' : new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short' })}</span>`).join('')}</div></section>
  <section class="panel"><div class="panel-header"><div><h2>From fit to conversation</h2><p>All time · denominators are qualified leads</p></div></div>${[['Qualified', m.qualified], ['Selected', m.selected], ['Approved', m.drafts_approved], ['Sent', m.sent], ['Replied', m.replies], ['Meetings', m.meetings]].map(([t, n]) => `<div class="funnel-row"><span>${t}</span><div class="funnel-track"><i style="width:${n / (m.qualified || 1) * 100}%"></i></div><b>${n}</b></div>`).join('')}<p class="helper">${m.bounces} bounced · ${m.opt_outs} opted out · follow-up enrollments: ${esc(Object.entries(m.enrollments).map(([k, v]) => `${v} ${k}`).join(', ') || 'none')}</p></section></div>
  <div class="spacer"></div>${activityPanel()}<div class="notice" style="margin-top:20px">${icon('shield')}${esc(m.definitions.sent)} Replies, bounces, opt-outs, and meetings are recorded by you; opens and deliveries are not tracked.</div>`;
}
function confirmDeleteCampaign(id,name){S.modal='delete-campaign';S.modalData={id,name};render();}
async function deleteCampaign(){try{await Api.del(`/api/campaigns/${S.modalData.id}`);S.modal=null;S.cid=null;S.c=null;await navigate('campaigns');toast('Campaign deleted; pending emails canceled.');}catch(e){fail(e);}}
async function campaignAction(a) {
  try { S.c = await Api.post(`/api/campaigns/${S.cid}/${a}`); S.modal = null; await loadViewData(); await refreshSummary(); render(); toast({ pause: 'Campaign paused. Queued emails are blocked until you resume.', resume: 'Campaign resumed. Overdue follow-ups are held for your review.', stop: 'Campaign stopped.' }[a]); } catch (e) { fail(e); }
}
function activityPanel() {
  return `<section class="panel"><div class="panel-header"><h2>Campaign activity</h2>${badge('Audit log')}</div>${S.events.map(e => `<div class="activity-row">${icon('check')}<div><strong style="font-weight:500">${esc(e.summary)}</strong><p>${esc(e.type)}</p></div><time>${fmtDate(e.created_at)}</time></div>`).join('') || '<p class="subtle">No activity yet.</p>'}</section>`;
}

// ---------- Send queue ----------
async function loadTasks() {
  const q = S.taskCampaign ? `&campaign_id=${S.taskCampaign}` : '';
  [S.tasks] = await Promise.all([Api.get(`/api/send-tasks?status=${S.taskFilter}${q}`), refreshSummary()]);
}
function outboxView() {
  const stopped = S.summary?.sending_stopped;
  return `<div class="heading"><div><div class="eyebrow">SEND QUEUE</div><h1>Your campaign send queue.</h1><p>Scheduled SMTP campaigns send approved initial emails automatically. Manual campaigns and follow-ups retain their review actions.</p></div><button class="${stopped ? 'primary' : 'ghost'}" onclick="toggleSending(${!stopped})">${icon('pause')} ${stopped ? 'Resume all sending' : 'Stop all sending'}</button></div>
  ${stopped ? `<div class="notice amber" style="margin-bottom:18px">${icon('shield')}Sending is stopped for the whole workspace. Tasks stay queued and cannot be confirmed until you resume.</div>` : ''}${tasksPanel()}`;
}
function tasksPanel() {
  const T = S.tasks;
  if (!T) return loadingPanel('Loading send queue…');
  return `<div class="panel"><div class="tabs">${[['open', 'To send'], ['sending', 'Sending'], ['unknown', 'Check mailbox'], ['sent', 'Sent'], ['skipped', 'Skipped'], ['canceled', 'Canceled']].map(([k, n]) => `<button class="${S.taskFilter === k ? 'active' : ''}" onclick="S.taskFilter='${k}';loadTasks().then(render)">${n} ${badge(k === 'open' ? (T.counts.pending || 0) + (T.counts.held || 0) : T.counts[k] || 0)}</button>`).join('')}</div>
  ${T.items.map(taskCard).join('') || `<div class="empty"><h3>${S.taskFilter === 'open' ? 'Nothing to send right now' : 'No tasks here'}</h3><p>${S.taskFilter === 'open' ? 'Approved emails for active campaigns appear here.' : ''}</p></div>`}</div>`;
}
function taskCard(t) {
  const label = t.kind === 'initial' ? 'Initial email' : `Follow-up ${t.step_index + 1} · day ${t.day}`;
  const state = t.status === 'held' ? badge('Held for review', 'amber') : t.blocked_reason ? badge('Blocked', 'amber') : t.status === 'pending' ? (t.due ? badge('Due now', 'green') : badge('Due ' + fmtDate(t.due_at))) : badge(t.status === 'sent' ? (t.proof === 'smtp_accepted' ? 'SMTP accepted' : 'Sent · confirmed by you') : t.status, t.status === 'sent' ? 'green' : '');
  const mail = `mailto:${encodeURIComponent(t.to_email)}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(t.body)}`;
  return `<article class="task-card"><div class="task-head"><span class="avatar">${initials(t.recipient)}</span><div class="grow"><strong>${esc(t.recipient)}</strong> <small class="subtle">${esc(t.company)} · ${esc(t.to_email)}</small><p class="subtle" style="margin:2px 0 0">${esc(label)} · ${esc(t.campaign_name)}</p></div>${state}</div>
  <div class="task-body"><strong>${esc(t.subject)}</strong><pre>${esc(t.body)}</pre></div>
  ${t.blocked_reason ? `<p class="helper">${icon('shield')} ${esc(t.blocked_reason)}</p>` : t.status_reason && t.status !== 'pending' ? `<p class="helper">${esc(t.status_reason)}</p>` : ''}
  <div class="task-actions">${t.status === 'pending' && t.blocked_reason ? `<span class="helper">This email is blocked until the issue above is resolved.</span><button class="small ghost" onclick="skipTask('${esc(t.id)}')">Skip</button>` : t.status === 'pending' && t.kind === 'initial' && t.delivery === 'smtp' ? `<span class="helper">Approved email will send through the connected mailbox when its schedule is due.</span><button class="small ghost" onclick="skipTask('${esc(t.id)}')">Skip</button>` : t.status === 'pending' ? `<a class="button small" href="${esc(mail)}">${icon('mail')} Open in email app</a><button class="small" onclick="sendSmtp('${esc(t.id)}')" ${!t.due ? 'disabled' : ''}>Send via SMTP</button><button class="small" onclick="copyTask('${esc(t.id)}')">${icon('copy')} Copy</button><button class="small primary" onclick="S.modal='confirm-sent';S.modalData='${esc(t.id)}';render()" ${t.blocked_reason ? 'disabled' : ''}>I sent this</button><button class="small ghost" onclick="skipTask('${esc(t.id)}')">Skip</button>`
    : t.status === 'held' ? `<button class="small primary" onclick="releaseTask('${esc(t.id)}')" ${t.blocked_reason ? 'disabled' : ''}>Release for sending</button><button class="small ghost" onclick="skipTask('${esc(t.id)}')">Skip this step</button>`
    : t.status === 'sent' ? `<span class="helper" style="margin:0">Sent ${fmtDate(t.sent_at)}</span><button class="small" onclick="S.modal='outcome';S.modalData={contact:'${esc(t.contact_id)}',campaign:'${esc(t.campaign_id)}',name:'${esc(t.recipient)}'};render()">Record reply or outcome</button>` : ''}</div></article>`;
}
async function copyTask(id) {
  const t = S.tasks.items.find(x => x.id === id);
  try { await navigator.clipboard.writeText(`To: ${t.to_email}\nSubject: ${t.subject}\n\n${t.body}`); toast('Copied. Copying does not mark it as sent.'); } catch { toast('Copy failed. Select the text manually.'); }
}
async function confirmSent(id) {
  const v = $('sent-at')?.value;
  try { await Api.post(`/api/send-tasks/${id}/confirm-sent`, { sent_at: v ? new Date(v).toISOString() : undefined }, { idem: 'sent-' + id }); S.modal = null; await loadTasks(); render(); toast('Marked as sent by you.'); } catch (e) { fail(e); }
}
async function skipTask(id) { try { await Api.post(`/api/send-tasks/${id}/skip`, { reason: 'Skipped by user' }); await loadTasks(); render(); } catch (e) { fail(e); } }
async function releaseTask(id) { try { await Api.post(`/api/send-tasks/${id}/release`); await loadTasks(); render(); toast('Released. It is now due.'); } catch (e) { fail(e); } }
async function toggleSending(stopped) { try { await Api.post('/api/workspace/sending', { stopped }); if (S.tasks) await loadTasks(); else await refreshSummary(); render(); toast(stopped ? 'All sending stopped.' : 'Sending resumed.'); } catch (e) { fail(e); } }
async function recordOutcome() {
  const d = S.modalData, type = $('outcome-type').value, note = $('outcome-note').value, at = $('outcome-at').value;
  try { const r = await Api.post(`/api/contacts/${d.contact}/outcomes`, { type, campaign_id: d.campaign || null, note, occurred_at: at ? new Date(at).toISOString() : undefined }); S.modal = null; if (S.tasks) await loadTasks(); if (S.contacts) await loadContacts(); render(); toast(`Recorded.${r.stopped_enrollments ? ' Remaining follow-ups stopped.' : ''}${type === 'opt_out' || type === 'bounce' ? ' Address suppressed.' : ''}`); } catch (e) { fail(e); }
}

// ---------- Sequences ----------
const launchedCampaigns = () => S.campaigns.filter(c => c.status !== 'draft');
async function loadSequenceView() {
  await refreshSummary();
  const list = launchedCampaigns();
  if (!list.length) { S.seq = null; return; }
  if (!list.some(c => c.id === S.seqCampaign)) S.seqCampaign = (list.find(c => c.id === S.cid) || list[0]).id;
  const [seq, leads] = await Promise.all([Api.get(`/api/campaigns/${S.seqCampaign}/sequence`), Api.get(`/api/campaigns/${S.seqCampaign}/leads?decision=all&selected=1&page_size=100`)]);
  S.seq = seq; S.seqLeads = leads.items; S.seqActive = Math.min(S.seqActive, seq.steps.length - 1);
}
const personalize = (text, l) => text.replace(/\{\{\s*first_name\s*\}\}/g, l?.first_name || 'First name').replace(/\{\{\s*company\s*\}\}/g, l?.company || 'Company');
function sequencePreview(step, l) { return `<strong>${esc(personalize(step.subject, l))}</strong><span style="white-space:pre-wrap">${esc(personalize(step.body, l))}</span>`; }
function sequencesView() {
  const list = launchedCampaigns();
  if (!list.length) return `<div class="heading"><div><h1>Keep the conversation moving.</h1><p>Follow-ups for every campaign.</p></div></div><div class="panel empty"><div class="ai-mark">${icon('clock')}</div><h3>Launch your first campaign to get started</h3><p>Your initial email is day 0. Then build a follow-up sequence around it.</p><button class="primary" onclick="navigate('campaigns')">Go to campaigns</button></div>`;
  const s = S.seq;
  if (!s) return loadingPanel('Loading sequence…');
  const c = list.find(x => x.id === S.seqCampaign), step = s.steps[S.seqActive], locked = s.status !== 'draft', person = S.seqLeads[Math.min(S.seqRecipient, S.seqLeads.length - 1)];
  const enrolled = Object.entries(s.enrollments).map(([k, v]) => `${v} ${k}`).join(', ') || 'none yet';
  return `<div class="heading"><div><div class="eyebrow">FOLLOW-UP STUDIO</div><h1>Keep the conversation moving.</h1><p>One campaign. A thoughtful sequence. Every follow-up in your voice.</p></div>${badge(s.status === 'draft' ? (s.current_version ? `Editing · v${s.current_version.version} paused` : 'Draft sequence') : s.status === 'paused' ? 'Paused' : `Active · v${s.current_version?.version}`, s.status === 'active' ? 'green' : s.status === 'paused' ? 'amber' : '')}</div>
  <div class="panel" style="margin-bottom:22px"><div class="two-col"><div><label for="sequence-campaign">Campaign</label><select id="sequence-campaign" onchange="S.seqCampaign=this.value;S.seqActive=0;S.seqRecipient=0;loadSequenceView().then(render)">${list.map(x => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}${x.status !== 'active' ? ` (${x.status})` : ''}</option>`).join('')}</select></div><div><label>Enrollment</label><div class="context-banner" style="margin:0">${icon('shield')}<span>Recipients enroll when you confirm their initial email was sent, unless they replied, bounced, or opted out. Enrolled: ${esc(enrolled)}.</span></div></div></div><p class="helper">Days are calendar-day offsets from each recipient’s confirmed initial send, in ${esc(c.config.schedule.timezone)}, moved to the next sending day and due at the time set for that weekday. Steps already overdue are held for your review rather than sent together. Recipients already enrolled keep the version they started with.</p></div>
  <div class="sequence-layout"><aside class="panel sequence-timeline"><div class="panel-header"><h2>Your sequence</h2>${badge(plural(s.steps.length, 'email'))}</div><div class="sequence-origin">${icon('mail')}<div><strong>Day 0 · Initial email</strong><small>From your launched campaign</small></div></div>${s.steps.map((x, i) => `<button class="sequence-node ${i === S.seqActive ? 'active' : ''}" onclick="selectSeqStep(${i})"><span class="sequence-day">${esc(x.day)}<small>DAY</small></span><span class="grow"><strong>${esc(x.title)}</strong><small>${x.approved ? '✓ Approved' : 'Needs approval'}</small></span>${icon('chevron')}</button>`).join('')}<button class="stretch small" style="margin-top:18px" onclick="addSequenceStep()" ${locked || s.steps.length >= 8 ? 'disabled' : ''}>${icon('plus')} Add follow-up</button><div class="notice" style="margin-top:19px">${icon('shield')}A reply, bounce, opt-out, or meeting you record stops remaining follow-ups.</div></aside>
  <section class="panel"><div class="panel-header"><div><h2>Follow-up ${S.seqActive + 1}</h2><p>Customize before approving. Approval covers this exact text and day.</p></div>${badge(step.approved ? 'Approved' : 'Draft', step.approved ? 'green' : '')}</div>
  <div class="two-col"><div class="field"><label for="sequence-day">Days after initial email</label><input id="sequence-day" type="number" min="1" max="90" value="${esc(step.day)}" ${locked ? 'disabled' : ''} onchange="editSequence('day',Number(this.value))"></div><div class="field"><label for="sequence-tone">Start from a template</label><select id="sequence-tone" ${locked ? 'disabled' : ''} onchange="sequenceTemplate(this.value)"><option value="">Choose a template…</option><option>Conversational</option><option>Professional</option><option>Warm</option><option>Concise</option></select></div></div>
  <div class="field"><label for="sequence-subject">Subject</label><input id="sequence-subject" value="${esc(step.subject)}" ${locked ? 'disabled' : ''} oninput="previewSequence('subject',this.value)" onchange="editSequence('subject',this.value)"></div>
  <div class="field"><label for="sequence-body">Email</label><textarea id="sequence-body" style="min-height:245px" ${locked ? 'disabled' : ''} oninput="previewSequence('body',this.value)" onchange="editSequence('body',this.value)">${esc(step.body)}</textarea><p class="helper">Personalization fields: {{first_name}} and {{company}}.</p></div>
  ${s.errors.length ? `<div class="notice amber">${icon('shield')}${esc(s.errors.join(' '))}</div>` : ''}
  <div class="toolbar"><button class="small ghost" ${locked || s.steps.length === 1 ? 'disabled' : ''} onclick="removeSequenceStep()">Remove this step</button><button class="primary small" id="sequence-approve" ${locked ? 'disabled' : ''} onclick="approveSequenceStep()">${step.approved ? '✓ Approved' : 'Approve this email'}</button></div>
  <div class="drawer-section"><div class="panel-header"><h2 style="font-size:14px">Recipient preview</h2><select aria-label="Sequence recipient preview" style="max-width:200px" onchange="S.seqRecipient=Number(this.value);$('sequence-preview').innerHTML=sequencePreview(S.seq.steps[S.seqActive],S.seqLeads[S.seqRecipient])">${S.seqLeads.map((l, i) => `<option value="${i}" ${l === person ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div><div class="evidence-box" id="sequence-preview">${sequencePreview(step, person)}</div></div></section></div>
  <div class="footer-actions"><span class="helper" id="sequence-count">${s.steps.filter(x => x.approved).length} of ${s.steps.length} follow-ups approved</span><div class="inline">${locked ? `<button onclick="sequenceAction('edit')">Edit sequence</button><button class="primary" onclick="sequenceAction('${s.status === 'active' ? 'pause' : 'resume'}')">${s.status === 'active' ? 'Pause' : 'Resume'}</button>` : `<button onclick="reviewSequenceBatch()">Review & approve all</button><button class="primary" onclick="launchSequence()">${s.current_version ? 'Relaunch sequence' : 'Launch sequence'} ${icon('arrow')}</button>`}</div></div>`;
}
async function selectSeqStep(i) { await seqSaveChain; S.seqActive = i; render(); }
let seqSaveChain = Promise.resolve();
function saveSteps(steps) {
  seqSaveChain = seqSaveChain.then(async () => {
    try { S.seq = await Api.patch(`/api/sequences/${S.seq.id}`, { revision: S.seq.revision, steps }); S.seqActive = Math.min(S.seqActive, S.seq.steps.length - 1); }
    catch (e) { fail(e); await loadSequenceView(); }
  });
  return seqSaveChain;
}
function previewSequence(k, v) { const step = { ...S.seq.steps[S.seqActive], [k]: v }; $('sequence-preview').innerHTML = sequencePreview(step, S.seqLeads[S.seqRecipient]); }
async function editSequence(k, v) {
  const steps = S.seq.steps.map(({ approved, ...x }) => x);
  steps[S.seqActive][k] = v;
  await saveSteps(steps);
  const b = $('sequence-approve'); if (b) b.textContent = S.seq.steps[S.seqActive].approved ? '✓ Approved' : 'Approve this email';
  const n = $('sequence-count'); if (n) n.textContent = `${S.seq.steps.filter(x => x.approved).length} of ${S.seq.steps.length} follow-ups approved`;
  if (k === 'day' || S.seq.errors.length) render();
}
async function addSequenceStep() {
  const steps = S.seq.steps.map(({ approved, ...x }) => x), last = steps.at(-1);
  if (last.day + 2 > 90) return toast('Sequence cannot extend past day 90.');
  const sig = launchedCampaigns().find(c => c.id === S.seqCampaign) ? S.context.data.signature : '';
  steps.push({ day: last.day + 2, title: 'Follow-up email', subject: 'A quick follow-up for {{company}}', body: `Hi {{first_name}},\n\nJust checking back in on my earlier note.\n\n${sig}` });
  S.seqActive = steps.length - 1; await saveSteps(steps); render();
}
async function removeSequenceStep() { const steps = S.seq.steps.map(({ approved, ...x }) => x); steps.splice(S.seqActive, 1); S.seqActive = Math.max(0, S.seqActive - 1); await saveSteps(steps); render(); }
function sequenceTemplate(tone) {
  if (!tone) return;
  const offer = S.c?.id === S.seqCampaign ? S.c.config.offer : S.campaigns.find(c => c.id === S.seqCampaign)?.config.offer || '', sig = S.context.data.signature;
  const body = tone === 'Concise' ? `Hi {{first_name}},\n\nIs this relevant for {{company}} right now? Happy to share more if useful.\n\n${sig}` : tone === 'Professional' ? `Hello {{first_name}},\n\nI am following up on my earlier introduction. ${offer}\n\nWould you be available to discuss whether this would be relevant for {{company}}?\n\n${sig}` : `Hi {{first_name}},\n\nJust checking back in. ${offer}\n\nIs this on the radar at {{company}}? ${tone === 'Warm' ? 'No worries at all if now isn’t the right time.' : 'Happy to send a quick overview if useful.'}\n\n${sig}`;
  editSequence('body', body).then(render);
}
async function approveSequenceStep() {
  await seqSaveChain;
  if (S.seq.errors.length) return toast(S.seq.errors[0]);
  try { S.seq = await Api.post(`/api/sequences/${S.seq.id}/approvals`, { revision: S.seq.revision, steps: [S.seqActive] }); render(); toast('Follow-up approved.'); } catch (e) { fail(e); }
}
async function reviewSequenceBatch() { await seqSaveChain; if (S.seq.errors.length) return toast(S.seq.errors[0]); S.modal = 'sequence-bulk'; render(); }
async function approveSequenceBatch() {
  if (!$('sequence-bulk-check').checked) return toast('Confirm you reviewed the sequence.');
  try { S.seq = await Api.post(`/api/sequences/${S.seq.id}/approvals`, { revision: S.seq.revision, steps: 'all', confirm: true }); S.modal = null; render(); toast('All follow-ups approved. You can now launch.'); } catch (e) { fail(e); }
}
async function launchSequence() {
  await seqSaveChain;
  try { S.seq = await Api.post(`/api/sequences/${S.seq.id}/launch`, { revision: S.seq.revision }, { idem: Api.key() }); await refreshSummary(); render(); toast(`Sequence launched. ${S.seq.enrollments.active || 0} recipients enrolled; follow-ups appear in your send queue when due.`); } catch (e) { fail(e); }
}
async function sequenceAction(a) {
  try { S.seq = await Api.post(`/api/sequences/${S.seq.id}/${a}`); render(); toast({ edit: 'Editing. Follow-ups pause until you re-approve and relaunch.', pause: 'Sequence paused.', resume: 'Sequence resumed. Overdue steps are held for review.' }[a]); } catch (e) { fail(e); }
}

// ---------- Contacts, imports, suppression ----------
async function loadContacts() {
  const [contacts, imports, sup] = await Promise.all([Api.get(`/api/contacts?q=${encodeURIComponent(S.cq)}&page=${S.cpage}&page_size=15`), Api.get('/api/imports'), Api.get('/api/suppressions')]);
  Object.assign(S, { contacts, imports: imports.items, suppressions: sup.items });
}
function contactsView() {
  const C = S.contacts, last = S.lastImport;
  return `<div class="heading"><div><div class="eyebrow">CONTACTS</div><h1>Your people, in one place.</h1><p>See campaign contacts and manage who must never be contacted.</p></div></div>
  <div class="wizard-grid"><div class="stack">${S.session.user.operator?`<section class="panel"><div class="panel-header"><div><h2>Import contacts</h2><p>CSV with a header row. Required: first name (or name), company, and an email or LinkedIn URL.</p></div>${icon('download')}</div>
    <div class="inline"><label class="button primary small" for="csv-file" style="margin:0">${icon('download')} Choose CSV file</label><input id="csv-file" type="file" accept=".csv,text/csv" style="display:none" onchange="importFile(this)"><select id="csv-source" aria-label="Import source" style="max-width:240px"><option value="csv">CRM or provider export</option><option value="salesnav_export">Sales Navigator export</option></select><button class="small ghost" onclick="importSample()">Load fictional sample contacts</button></div>
    <p class="helper">Optional columns: last_name, title, email_status (valid, invalid, catch-all, unknown — from your verification provider), domain, industry, employees, location, linkedin_url, relationship (customer, competitor, agency, opportunity), signal (Hiring, Funding, New leadership, Expansion), signal_fact, signal_date (YYYY-MM-DD), signal_url. Re-importing updates existing people instead of duplicating them.</p>
    ${last ? `<div class="notice ${last.rejected.some(r => !r.partial) ? 'amber' : ''}">${icon('check')}<span><strong>${esc(last.filename)}</strong>: ${last.created_count} new, ${last.updated_count} updated, ${last.rejected.filter(r => !r.partial).length} rejected.${last.rejected.length ? '<br>' + last.rejected.slice(0, 8).map(r => `Line ${r.line}: ${esc(r.reason)}`).join('<br>') + (last.rejected.length > 8 ? `<br>…and ${last.rejected.length - 8} more` : '') : ''}</span></div>` : ''}</section>`:`<section class="panel"><h2>Campaign contacts</h2><p>Your admin prepares lead lists for each campaign.</p></section>`}
  <section class="panel"><div class="panel-header"><div><h2>All contacts</h2><p>${C ? plural(C.total, 'contact') : ''}</p></div></div><div class="toolbar"><div class="search">${icon('search')}<input id="contact-search" aria-label="Search contacts" placeholder="Search people, companies, or emails" value="${esc(S.cq)}" oninput="S.cq=this.value;S.cpage=0;clearTimeout(window._cs);window._cs=setTimeout(()=>loadContacts().then(()=>{render();const i=$('contact-search');i.focus();i.setSelectionRange(i.value.length,i.value.length)}),300)"></div></div>
  ${!C ? loadingPanel() : `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Company</th><th>Email</th><th>Campaigns</th><th></th></tr></thead><tbody>${C.items.map(x => `<tr><td><div class="person"><span class="avatar">${initials(x.first_name + ' ' + x.last_name)}</span><div><strong>${esc(x.first_name)} ${esc(x.last_name)}</strong><small>${esc(x.role)}</small></div></div></td><td>${esc(x.company)}<small>${esc([x.industry, x.location].filter(Boolean).join(' · '))}</small></td><td>${esc(x.email || '—')}<small>${x.suppressed ? badge('Suppressed: ' + x.suppressed, 'red') : emailBadge(x.email_status)}</small></td><td><small>${esc(x.campaigns || '—')}${x.last_outcome ? ' · last: ' + esc(x.last_outcome) : ''}</small></td><td><button class="small ghost" onclick="S.modal='outcome';S.modalData={contact:'${esc(x.id)}',name:'${esc(x.first_name)} ${esc(x.last_name)}'};render()">Record outcome</button></td></tr>`).join('') || '<tr><td colspan="5">No contacts yet. Your admin can prepare campaign leads.</td></tr>'}</tbody></table></div>
  <div class="table-bottom"><span>${C.total ? `${S.cpage * 15 + 1}–${Math.min(S.cpage * 15 + 15, C.total)} of ${C.total}` : ''}</span><div class="inline"><button class="small ghost" ${S.cpage === 0 ? 'disabled' : ''} onclick="S.cpage--;loadContacts().then(render)">← Previous</button><button class="small ghost" ${(S.cpage + 1) * 15 >= C.total ? 'disabled' : ''} onclick="S.cpage++;loadContacts().then(render)">Next →</button></div></div>`}</section></div>
  <aside class="wizard-aside stack"><section class="panel"><h2 style="font-size:14px">Do not contact</h2><p class="subtle">Unsubscribe requests are added automatically. SMTP does not sync bounces, so record them in the app or add addresses manually.</p><div class="inline"><input id="sup-email" aria-label="Email to suppress" placeholder="name@company.com"><button class="small" onclick="addSuppression()">Add</button></div>${S.suppressions.map(s => `<div class="summary-row"><small>${esc(s.reason.replace('_', '-'))} · ${fmtDay(s.created_at)}</small><p>${esc(s.email)} ${s.reason === 'manual' ? `<button class="small ghost" onclick="removeSuppression('${esc(s.id)}')">Remove</button>` : ''}</p></div>`).join('') || '<p class="helper">No suppressed addresses.</p>'}</section>
  <section class="panel"><h2 style="font-size:14px">Recent imports</h2>${S.imports.map(i => `<div class="summary-row"><small>${fmtDate(i.created_at)} · ${i.source === 'salesnav_export' ? 'Sales Navigator export' : 'CSV'}</small><p>${esc(i.filename)}: ${i.created_count} new, ${i.updated_count} updated, ${i.rejected.filter(r => !r.partial).length} rejected</p></div>`).join('') || '<p class="helper">No imports yet.</p>'}</section></aside></div>`;
}
async function importCsvText(filename, csv, source) {
  if(!S.session.user.operator){toast('Choose a campaign, then select Import your own contacts.');return;}
  try { S.lastImport = await Api.post('/api/imports', { filename, csv, source }, { idem: Api.key() }); S.cpage = 0; await loadContacts(); render(); toast(`Imported ${filename}.`); } catch (e) { fail(e); }
}
function importFile(input) {
  const f = input.files[0]; if (!f) return;
  if (f.size > 5_000_000) return toast('CSV files are limited to 5 MB.');
  const r = new FileReader();
  r.onload = () => importCsvText(f.name, String(r.result), $('csv-source').value);
  r.onerror = () => toast('Could not read that file.');
  r.readAsText(f);
}
async function importSample() {
  try { const res = await fetch('/sample-contacts.csv'); importCsvText('sample-contacts.csv (fictional)', await res.text(), 'csv'); } catch { toast('Could not load the sample.'); }
}
async function addSuppression() { const email = $('sup-email').value.trim(); if (!email) return; try { await Api.post('/api/suppressions', { email }); await loadContacts(); render(); toast('Address suppressed.'); } catch (e) { fail(e); } }
async function removeSuppression(id) { try { await Api.del(`/api/suppressions/${id}`); await loadContacts(); render(); } catch (e) { fail(e); } }

// ---------- Company context ----------
function accountView() {
  const a = S.context.data, f = S.contextErrors || {};
  const fieldA = (label, k, multi = false) => `<div class="field"><label for="a-${k}">${label}</label>${multi ? `<textarea id="a-${k}">${esc(a[k])}</textarea>` : `<input id="a-${k}" value="${esc(a[k])}">`}${f[k] ? `<p class="helper" style="color:var(--red)">${esc(f[k])}</p>` : ''}</div>`;
  return `<div class="heading"><div><div class="eyebrow">WORKSPACE SETTINGS</div><h1>1. Company context</h1><p>Next: connect your sending email.</p><p>Tell your assistant who you are, who you help, and how you sound.</p></div><button class="primary" onclick="saveAccount()">Save & continue to email setup</button></div><div class="wizard-grid"><div class="stack"><section class="panel"><div class="panel-header"><h2>Company & offering</h2>${badge('Version ' + S.context.version)}</div>${fieldA('Company name', 'company')}${fieldA('Website', 'website')}${fieldA('What do you offer?', 'offering', true)}${fieldA('Ideal customer profile', 'icp', true)}${fieldA('Approved proof points', 'proof', true)}${fieldA('Exclude from outreach (descriptions, company names, or domains)', 'exclusions', true)}</section>
  <section class="panel"><div class="panel-header"><h2>Sender identity</h2>${badge('Manual sending')}</div><div class="two-col">${fieldA('Sender name', 'sender')}${fieldA('Email address', 'email')}</div>${fieldA('Signature', 'signature', true)}<div class="field"><label for="a-tone">Default tone</label><select id="a-tone">${['Conversational', 'Professional', 'Warm'].map(x => `<option ${a.tone === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div><div class="notice">${icon('shield')}This is the identity used in drafts. Connect SMTP in Email setup to send from this platform, or use your email app. SMTP acceptance does not confirm delivery.</div></section></div>
  <aside class="wizard-aside panel"><h2>One source of context</h2><div class="timeline"><div class="timeline-item"><span class="time-dot">1</span><div><strong>Qualify the right people</strong><p>Audience, offering, and exclusions guide fit.</p></div></div><div class="timeline-item"><span class="time-dot">2</span><div><strong>Write in your voice</strong><p>Your tone and proof points shape the draft.</p></div></div><div class="timeline-item"><span class="time-dot">3</span><div><strong>Add campaign intent</strong><p>A chat brief adds context to each new campaign.</p></div></div></div><p class="helper">Each save creates a new version. Campaigns keep the version they were created with until you choose to update them, so approved emails never change silently.</p></aside></div>`;
}
async function saveAccount() {
  const data = {};
  for (const k of Object.keys(S.context.data)) { const el = $('a-' + k); data[k] = el ? el.value.trim() : S.context.data[k]; }
  try { S.context = await Api.patch('/api/account-context', { version: S.context.version, data }); S.contextErrors = null; await navigate('email'); toast(`Company context saved (version ${S.context.version}).`); }
  catch (e) {
    if (e.status === 422) { S.contextErrors = e.fields; S.context = { ...S.context, data }; render(); toast(e.message); }
    else if (e.status === 409) { toast('Company context changed elsewhere. Reloaded the latest version; reapply your edits.'); S.context = e.body.current; render(); }
    else fail(e);
  }
}

// ---------- Overlays ----------
function overlay() {
  if (!S.modal) return '';
  const close = `<button class="icon-btn ghost" aria-label="Close" onclick="closeOverlay()">${icon('close')}</button>`;
  const modal = (label, inner) => `<div class="modal-wrap"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}">${inner}</section></div>`;
  if (S.modal === 'lead') {
    const l = S.leads?.items.find(x => x.id === S.leadId); if (!l) return '';
    return `<div class="overlay" onclick="if(event.target===this)closeOverlay()"><section class="drawer" role="dialog" aria-modal="true" aria-label="Lead qualification"><div class="drawer-header"><span class="eyebrow">LEAD INTELLIGENCE</span>${close}</div><div class="inline"><span class="avatar" style="height:52px;width:52px;font-size:15px">${initials(l.name)}</span><div><h2>${esc(l.name)}</h2><p class="subtle" style="margin:6px 0">${esc(l.role)} · ${esc(l.company)}</p></div></div><div class="spacer"></div>${badge(l.decision === 'qualified' ? 'Qualified' : l.decision === 'review' ? 'Needs review' : 'Excluded', l.decision === 'qualified' ? 'green' : 'amber')} <span class="score" style="margin-left:10px">${l.score}/100 fit · ${esc(l.confidence)} confidence</span>
    <div class="drawer-section" style="margin-top:25px"><h3>Why this person?</h3><p class="subtle">${esc(l.rationale)}</p>${l.override_reason ? `<p class="helper">Your note: ${esc(l.override_reason)}</p>` : ''}${l.evidence.map(e => `<div class="evidence-item"><strong>${esc(e.signal || 'Evidence')}</strong><p>${esc(e.fact)}</p><small>${e.event_date ? 'Event ' + esc(e.event_date) + ' · ' : 'Event date unknown · '}${e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer">source</a> · ` : ''}collected ${fmtDay(e.collected_at)}</small></div>`).join('') || '<p class="helper">No signal evidence on file.</p>'}</div>
    <div class="drawer-section"><h3>Qualification checks</h3>${l.checks.map(x => `<div class="summary-row"><small>${x.status === 'pass' ? '✓' : x.status === 'fail' ? '✕' : '?'} ${esc(x.label)}</small><p>${esc(x.detail)}</p></div>`).join('')}<div class="summary-row"><small>Email</small><p>${esc(l.email || 'Not found')} ${emailBadge(l.email_status)}</p></div><p class="helper">Assessed by ${esc(l.assessed_by.replace('rules+', 'rules + '))}.</p></div>
    ${l.decision === 'review' && !l.checks.some(x => x.status === 'fail') && l.email ? `<div class="drawer-section"><h3>Qualify after review</h3><textarea id="qualify-reason" placeholder="Why does this person qualify? e.g. email verified separately"></textarea><button class="stretch primary" style="margin-top:10px" onclick="qualifyLead('${esc(l.id)}')">Mark as qualified</button></div>` : ''}
    ${l.decision !== 'excluded' && l.send_status !== 'sent' ? `<button class="stretch" onclick="excludeLead('${esc(l.id)}')">Exclude from this campaign</button>` : ''}</section></div>`;
  }
  if (S.modal === 'bulk') {
    const items = S.drafts.items.filter(x => x.draft && (S.weekDay==='all'||!S.weekDay||x.lead.slot_date===S.weekDay));
    return modal('Approve campaign emails', `<div class="panel-header"><h2>Review your email batch</h2>${close}</div><p>${items.length} drafts for ${S.drafts.total} prospects. Approval applies to this exact wording; anything edited later needs fresh approval.</p><div class="approval-summary">${items.map(x => `<article class="approval-item"><h4>${esc(x.lead.name)} · ${esc(x.lead.company)} ${x.draft.approved ? '✓' : ''}</h4><strong style="font-size:12px">${esc(x.draft.subject)}</strong><pre>${esc(x.draft.body)}</pre>${x.draft.review_note ? `<p class="helper">${esc(x.draft.review_note)}</p>` : ''}</article>`).join('')}</div><label class="inline"><input id="bulk-check" type="checkbox">I have reviewed these emails.</label><div class="modal-actions"><button onclick="closeOverlay()">Keep editing</button><button class="primary" onclick="approveAll()">Approve all emails</button></div>`);
  }
  if (S.modal === 'regen') return modal('Change writing settings', `<div class="panel-header"><h2>Rewrite drafts?</h2>${close}</div><p>Changing ${esc(S.modalData.key)} to “${esc(S.modalData.value)}” writes new drafts for ${plural(S.modalData.n, 'recipient')} who haven’t been emailed. Their current approvals will no longer apply. Earlier versions are kept in history.</p><div class="modal-actions"><button onclick="closeOverlay();render()">Cancel</button><button class="primary" onclick="confirmWriting()">Rewrite drafts</button></div>`);
  if (S.modal === 'delete-campaign') return modal('Delete campaign', `<div class="panel-header"><h2>Delete ${esc(S.modalData.name)}?</h2>${close}</div><p>Pending emails and follow-ups will be canceled. Sent history and opt-outs remain recorded. An email already being sent must finish before deletion.</p><div class="modal-actions"><button onclick="closeOverlay()">Keep campaign</button><button class="primary" onclick="deleteCampaign()">Delete campaign</button></div>`);
  if (S.modal === 'stop') return modal('Stop campaign', `<div class="panel-header"><h2>Stop this campaign?</h2>${close}</div><p>Stopping cancels queued emails and follow-ups and ends daily discovery. History is kept. This cannot be undone; pause instead if you may continue later.</p><div class="modal-actions"><button onclick="closeOverlay()">Cancel</button><button class="primary" onclick="campaignAction('stop')">Stop campaign</button></div>`);
  if (S.modal === 'confirm-sent') {
    const t = S.tasks.items.find(x => x.id === S.modalData), local = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    return modal('Confirm sent', `<div class="panel-header"><h2>Confirm you sent this email</h2>${close}</div><p>${esc(t.subject)} → ${esc(t.recipient)} &lt;${esc(t.to_email)}&gt;</p><div class="field"><label for="sent-at">When did you send it?</label><input id="sent-at" type="datetime-local" value="${local}" max="${local}"></div><p class="helper">Follow-up timing is measured from this time. This is recorded as confirmed by you, not verified by a mail provider.</p><div class="modal-actions"><button onclick="closeOverlay()">Cancel</button><button class="primary" onclick="confirmSent('${esc(t.id)}')">Mark as sent</button></div>`);
  }
  if (S.modal === 'outcome') {
    const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    return modal('Record outcome', `<div class="panel-header"><h2>Record an outcome for ${esc(S.modalData.name)}</h2>${close}</div><div class="field"><label for="outcome-type">What happened?</label><select id="outcome-type"><option value="reply">They replied</option><option value="meeting">Meeting booked</option><option value="bounce">Email bounced</option><option value="opt_out">They asked not to be contacted</option></select></div><div class="field"><label for="outcome-at">When?</label><input id="outcome-at" type="datetime-local" value="${local}" max="${local}"></div><div class="field"><label for="outcome-note">Note (optional)</label><textarea id="outcome-note"></textarea></div><p class="helper">Any outcome stops this person’s remaining follow-ups. Bounces and opt-outs also suppress the address everywhere.</p><div class="modal-actions"><button onclick="closeOverlay()">Cancel</button><button class="primary" onclick="recordOutcome()">Record</button></div>`);
  }
  if (S.modal === 'sequence-bulk') {
    const s = S.seq, l = S.seqLeads[S.seqRecipient];
    return modal('Approve follow-up sequence', `<div class="panel-header"><h2>Review your follow-up sequence</h2>${close}</div><p>Day offsets are measured from each recipient’s confirmed first email. Preview for ${esc(l?.name || 'a recipient')}.</p><div class="approval-summary">${s.steps.map(x => `<article class="approval-item"><h4>Day ${esc(x.day)} · ${esc(x.title)}</h4>${sequencePreview(x, l)}</article>`).join('')}</div><label class="inline"><input id="sequence-bulk-check" type="checkbox">I reviewed all follow-up emails and their timing.</label><div class="modal-actions"><button onclick="closeOverlay()">Keep editing</button><button class="primary" onclick="approveSequenceBatch()">Approve all follow-ups</button></div>`);
  }
  return '';
}
function closeOverlay() { S.modal = null; S.modalData = null; render(); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.modal) closeOverlay();
  if (e.key === 'Tab' && S.modal) { const controls = [...document.querySelectorAll('[role=dialog] button,[role=dialog] input,[role=dialog] select,[role=dialog] textarea,[role=dialog] a')]; if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); } else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); } }
});
window.addEventListener('beforeunload', e => { if (pendingSave) { flushSave(); e.preventDefault(); } });



// ---------- Sign-in ----------
const GOOGLE_ERRORS = { google_cancelled: 'Google sign-in was cancelled.', google_state: 'That Google sign-in link expired. Try again.', google_exchange: 'Google sign-in failed. Try again.', google_token: 'Google sign-in could not be verified. Try again.', google_unverified: 'Your Google account email is not verified.', google_conflict: 'This email is linked to a different Google account.' };
function googleError(h) { const code = (h.match(/error=(\w+)/) || [])[1]; return code ? GOOGLE_ERRORS[code] || 'Sign-in failed. Try again.' : ''; }
async function authConfig() { try { return await Api.get('/api/auth/config'); } catch { return { google: false, password: true }; } }
async function showAuth(view, extra = {}) {
  clearTimeout(pollTimer);
  S.auth = { view, error: '', fields: {}, busy: false, email: S.auth?.email || '', ...S.auth && { config: S.auth.config, invite: S.auth.invite, token: S.auth.token }, ...extra };
  S.auth.config ??= await authConfig();
  S.modal = null; S.loading = false;
  if (['signin', 'signup', 'forgot'].includes(view) && !S.auth.invite) setHash('#/' + (view === 'forgot' ? 'signin' : view));
  render();
}
// Handles links from emails (#/verify, #/reset, #/invite). Returns true when it took over boot.
async function handleAuthLink() {
  const h = String(location.hash || ''), m = h.match(/^#\/(verify|reset|invite)\/([\w-]+)/);
  if (!m) return false;
  const [, kind, token] = m;
  if (kind === 'verify') {
    try { await Api.post('/api/auth/verify-email', { token }); setHash('#/'); toast('Email confirmed. Welcome!'); return false; }
    catch (e) { setHash('#/signin'); await showAuth('signin', { error: e.message }); return true; }
  }
  if (kind === 'reset') { await showAuth('reset', { token }); return true; }
  try {
    const invite = await Api.post('/api/auth/invite-preview', { token });
    let session = null; try { session = await Api.get('/api/session'); } catch { /* signed out */ }
    await showAuth(session ? 'invite' : invite.account_exists ? 'signin' : 'signup', { token, invite, session, email: invite.email });
  } catch (e) { setHash('#/'); await showAuth('signin', { error: e.message }); }
  return true;
}
function authField(label, id, type, auto, value = '') {
  const err = S.auth.fields?.[id];
  return `<div class="field"><label for="auth-${id}">${label}</label><input id="auth-${id}" type="${type}" autocomplete="${auto}" value="${esc(value)}" ${err ? 'aria-invalid="true"' : ''}>${err ? `<p class="helper" style="color:var(--red)">${esc(err)}</p>` : ''}</div>`;
}
function authView() {
  const a = S.auth, inv = a.invite, google = a.config?.google;
  const googleBtn = google ? `<a class="button stretch google-btn" href="/auth/google/start${inv ? `?invite=${encodeURIComponent(a.token)}` : ''}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"/></svg> Continue with Google</a><div class="auth-divider"><span>or</span></div>` : '';
  const banner = inv ? `<div class="context-banner">${icon('people')}<div><strong>${esc(inv.inviter || 'A teammate')} invited you to ${esc(inv.workspace)}</strong><p>Invitation for ${esc(inv.email)}.</p></div></div>` : '';
  const err = a.error ? `<div class="error" role="alert">${esc(a.error)}${a.unverified ? ` <button class="small" onclick="resendVerification()">Send a new link</button>` : ''}</div>` : '';
  const busy = a.busy ? 'disabled' : '';
  const card = inner => `<div class="auth-wrap"><div class="auth-brand"><span class="logo">↗</span>outbound<span style="color:#7fb24a">.</span></div><section class="panel auth-card">${inner}</section><p class="helper auth-foot">${icon('shield')} Your outreach is sent from your own mailbox. SMTP setup uses a provider app password.</p></div>`;
  if (a.view === 'check') return card(`<div class="empty" style="padding:8px 0"><div class="ai-mark">${icon('mail')}</div><h2>Check your email</h2><p>${esc(a.message || 'If an account matches, we’ve sent you a link.')}</p><p class="helper">Didn’t get it? Check spam, or wait a minute and try again.</p><button class="stretch" onclick="showAuth('signin')">Back to sign in</button></div>`);
  if (a.view === 'reset') return card(`<h2>Choose a new password</h2><p class="subtle">At least 10 characters. Signing in elsewhere will end.</p>${err}<form onsubmit="event.preventDefault();resetPassword()">${authField('New password', 'password', 'password', 'new-password')}${authField('Confirm password', 'confirm', 'password', 'new-password')}<button class="primary stretch" ${busy}>Save password and sign in</button></form>`);
  if (a.view === 'forgot') return card(`<h2>Reset your password</h2><p class="subtle">We’ll email you a link to choose a new one.</p>${err}<form onsubmit="event.preventDefault();forgotPassword()">${authField('Email', 'email', 'email', 'email', a.email)}<button class="primary stretch" ${busy}>Send reset link</button></form><p class="auth-switch"><button class="ghost small" onclick="showAuth('signin')">Back to sign in</button></p>`);
  if (a.view === 'invite') {
    const mine = a.session?.user.email.toLowerCase() === inv.email.toLowerCase();
    return card(`${banner}${err}${mine ? `<p>You’re signed in as ${esc(a.session.user.email)}.</p><button class="primary stretch" onclick="acceptInvite()" ${busy}>Join ${esc(inv.workspace)}</button>` : `<p>You’re signed in as ${esc(a.session.user.email)}, but this invitation is for ${esc(inv.email)}.</p><button class="primary stretch" onclick="signOut(true)">Sign out and switch account</button>`}<p class="auth-switch"><button class="ghost small" onclick="S.auth=null;setHash('#/');boot()">Not now</button></p>`);
  }
  if (a.view === 'signup') return card(`${banner}<h2>${inv ? 'Create your account' : 'Create your workspace'}</h2><p class="subtle">${inv ? 'Join your team on Outbound.' : 'Find the right people and give them a reason to reply.'}</p>${err}${googleBtn}<form onsubmit="event.preventDefault();signUp()">${authField('Your name', 'name', 'text', 'name', a.name)}${inv ? '' : authField('Company', 'company', 'text', 'organization', a.company)}${authField('Work email', 'email', 'email', 'email', a.email)}${authField('Password', 'password', 'password', 'new-password')}<p class="helper" style="margin-top:-8px">At least 10 characters.</p><button class="primary stretch" ${busy}>${inv ? 'Create account and join' : 'Create account'}</button></form><p class="auth-switch">Already have an account? <button class="ghost small" onclick="showAuth('signin')">Sign in</button></p>`);
  return card(`${banner}<h2>${inv ? 'Sign in to accept' : 'Welcome back'}</h2><p class="subtle">Sign in to your outbound workspace.</p>${err}${googleBtn}<form onsubmit="event.preventDefault();signIn()">${authField('Email', 'email', 'email', 'email', a.email)}${authField('Password', 'password', 'password', 'current-password')}<div class="auth-row"><button type="button" class="ghost small" onclick="showAuth('forgot',{email:$('auth-email').value})">Forgot password?</button></div><button class="primary stretch" ${busy}>Sign in</button></form><p class="auth-switch">New here? <button class="ghost small" onclick="showAuth('signup')">Create an account</button></p>${google ? '<p class="helper" style="text-align:center">Signed up with Google? Use “Continue with Google”.</p>' : ''}`);
}
async function authSubmit(fn) {
  const a = S.auth; a.busy = true; a.error = ''; a.fields = {}; a.unverified = false; render();
  try { await fn(); }
  catch (e) { a.error = e.message; a.fields = e.fields || {}; a.unverified = e.code === 'email_unverified'; }
  a.busy = false; if (S.auth) render();
}
async function afterSignIn() {
  const inv = S.auth?.invite, token = S.auth?.token;
  if (inv) { try { await Api.post('/api/auth/accept-invite', { token }); toast(`You joined ${inv.workspace}.`); } catch (e) { toast(e.message); } }
  S.auth = null; S.loading = true; setHash('#/'); render(); boot();
}
// Read every field before authSubmit re-renders the form (re-rendering replaces the inputs).
const val = id => $('auth-' + id)?.value ?? '';
function signIn() {
  const email = val('email'), password = val('password');
  S.auth.email = email;
  return authSubmit(async () => { await Api.post('/api/auth/login', { email, password }); await afterSignIn(); });
}
function signUp() {
  const f = { name: val('name'), company: val('company'), email: val('email'), password: val('password') };
  Object.assign(S.auth, { name: f.name, company: f.company, email: f.email });
  return authSubmit(async () => {
    const r = await Api.post('/api/auth/signup', { ...f, invite_token: S.auth.invite ? S.auth.token : undefined });
    if (r.status === 'signed_in') return afterSignIn();
    Object.assign(S.auth, { view: 'check', message: `We sent a confirmation link to ${f.email}. Open it to finish creating your account.` });
  });
}
function forgotPassword() {
  const email = val('email');
  S.auth.email = email;
  return authSubmit(async () => { await Api.post('/api/auth/forgot-password', { email }); Object.assign(S.auth, { view: 'check', message: `If an account exists for ${email}, we sent a link to reset its password. It expires in one hour.` }); });
}
function resetPassword() {
  const password = val('password');
  if (password !== val('confirm')) { S.auth.error = 'The passwords don’t match.'; return render(); }
  return authSubmit(async () => { await Api.post('/api/auth/reset-password', { token: S.auth.token, password }); toast('Password updated.'); await afterSignIn(); });
}
async function resendVerification() {
  try { await Api.post('/api/auth/resend-verification', { email: S.auth.email }); Object.assign(S.auth, { view: 'check', message: `If ${S.auth.email} still needs confirming, we sent a new link.` }); render(); } catch (e) { S.auth.error = e.message; render(); }
}
function acceptInvite() { return authSubmit(async () => { await afterSignIn(); }); }
async function signOut(keepInvite) {
  try { await Api.post('/api/auth/logout'); } catch { /* already signed out */ }
  const keep = keepInvite && S.auth?.invite ? { invite: S.auth.invite, token: S.auth.token, email: S.auth.invite.email } : {};
  Object.assign(S, { session: null, c: null, cid: null, campaigns: [], view: 'home' });
  S.auth = keep.invite ? { config: S.auth.config, ...keep } : null;
  await showAuth(keep.invite ? (keep.invite.account_exists ? 'signin' : 'signup') : 'signin', keep);
}
async function switchWorkspace(id) {
  try { await Api.post('/api/auth/switch-workspace', { workspace_id: id }); Object.assign(S, { c: null, cid: null, view: 'home', loading: true }); setHash('#/'); render(); boot(); } catch (e) { fail(e); }
}

// ---------- Team & account ----------
function teamView() {
  const u = S.session.user, T = S.team, owner = u.role === 'owner', f = S.pwErrors || {};
  return `<div class="heading"><div><div class="eyebrow">TEAM & ACCOUNT</div><h1>Who’s in ${esc(S.session.workspace.name)}.</h1><p>Invite teammates and manage how you sign in.</p></div></div>
  <div class="wizard-grid"><div class="stack"><section class="panel"><div class="panel-header"><div><h2>Team members</h2><p>${T ? plural(T.members.length, 'member') : ''}</p></div>${badge(owner ? 'You’re an owner' : 'You’re a member')}</div>
  ${!T ? loadingPanel() : `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Sign-in</th><th>Last active</th><th></th></tr></thead><tbody>${T.members.map(m => `<tr><td><div class="person"><span class="avatar">${initials(m.name)}</span><div><strong>${esc(m.name)}${m.id === u.id ? ' (you)' : ''}</strong><small>${esc(m.email)}</small></div></div></td><td>${badge(m.role === 'owner' ? 'Owner' : 'Member', m.role === 'owner' ? 'green' : '')}</td><td><small>${[m.has_password && 'Password', m.google_linked && 'Google'].filter(Boolean).join(' · ') || '—'}</small></td><td><small>${m.last_login_at ? fmtDate(m.last_login_at) : 'Never'}</small></td><td>${owner && m.id !== u.id ? `<button class="small ghost" onclick="removeMember('${esc(m.id)}','${esc(m.name)}')">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
  ${T.invites.length ? `<h3 style="margin-top:22px">Pending invitations</h3>${T.invites.map(i => `<div class="summary-row"><small>${esc(i.role)} · expires ${fmtDay(i.expires_at)}</small><p>${esc(i.email)} ${owner ? `<button class="small ghost" onclick="revokeInvite('${esc(i.id)}')">Revoke</button>` : ''}</p></div>`).join('')}` : ''}`}</section>
  ${owner ? `<section class="panel"><div class="panel-header"><div><h2>Invite a teammate</h2><p>They’ll get an email link to join this workspace. Invitations expire after 7 days.</p></div>${icon('mail')}</div><form class="inline" onsubmit="event.preventDefault();sendInvite()"><input id="invite-email" type="email" aria-label="Teammate email" placeholder="name@company.com" autocomplete="off"><select id="invite-role" aria-label="Role" style="max-width:150px"><option value="member">Member</option><option value="owner">Owner</option></select><button class="primary small">Send invite</button></form><p class="helper">Members can run campaigns and send emails. Owners can also manage the team.</p></section>` : ''}</div>
  <aside class="wizard-aside stack"><section class="panel"><h2 style="font-size:14px">Your account</h2><div class="summary-row"><small>Name</small><p>${esc(u.name)}</p></div><div class="summary-row"><small>Email</small><p>${esc(u.email)}</p></div><div class="summary-row"><small>Sign-in methods</small><p>${u.has_password ? 'Password' : 'No password'}${u.google_linked ? ' · Google' : ''}</p></div>
  ${S.authConfig?.google && !u.google_linked ? `<a class="button small stretch" href="/auth/google/start">Link Google account</a><p class="helper">Uses the Google account for ${esc(u.email)}.</p>` : ''}</section>
  <section class="panel"><h2 style="font-size:14px">${u.has_password ? 'Change password' : 'Set a password'}</h2><form onsubmit="event.preventDefault();changePassword()">${u.has_password ? `<div class="field"><label for="pw-current">Current password</label><input id="pw-current" type="password" autocomplete="current-password">${f.current_password ? `<p class="helper" style="color:var(--red)">${esc(f.current_password)}</p>` : ''}</div>` : ''}<div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password">${f.password ? `<p class="helper" style="color:var(--red)">${esc(f.password)}</p>` : ''}</div><button class="small primary">Save password</button></form><p class="helper">Saving signs out your other sessions.</p></section>
  <section class="panel"><h2 style="font-size:14px">Sessions</h2><p class="subtle">Signed in with ${esc({ password: 'a password', google: 'Google', email_link: 'an email link', token: 'an API token' }[S.session.method] || S.session.method)}.</p><button class="small" onclick="signOutEverywhere()">Sign out everywhere</button></section></aside></div>`;
}
async function sendInvite() {
  const email = $('invite-email').value.trim(), role = $('invite-role').value;
  if (!email) return toast('Enter an email address.');
  try { S.team = await Api.post('/api/team/invites', { email, role }); render(); toast(`Invitation sent to ${email}.`); } catch (e) { fail(e); }
}
async function revokeInvite(id) { try { S.team = await Api.del(`/api/team/invites/${id}`); render(); toast('Invitation revoked.'); } catch (e) { fail(e); } }
async function removeMember(id, name) { if (!confirm(`Remove ${name} from this workspace? They’ll lose access immediately.`)) return; try { S.team = await Api.del(`/api/team/members/${id}`); render(); toast(`${name} removed.`); } catch (e) { fail(e); } }
async function changePassword() {
  try { await Api.post('/api/auth/change-password', { current_password: $('pw-current')?.value, password: $('pw-new').value }); S.pwErrors = null; S.session = await Api.get('/api/session'); render(); toast('Password saved. Other sessions were signed out.'); }
  catch (e) { if (e.status === 422) { S.pwErrors = e.fields; render(); } else fail(e); }
}
// ---------- Super admin: pilot access ----------
function toggleAdmin() { navigate(S.view === 'admin' ? 'home' : 'admin'); }
function researchSelection(field,value){S[field]=value;if(field==='researchWorkspace')S.researchCampaign='';S.researchPreview=null;S.researchFile=null;S.researchResult=null;render();}
async function previewResearchFile(input){
 const file=input.files?.[0];if(!file)return;
 if(!S.researchCampaign){toast('Choose the customer and campaign first.');return;}
 if(file.size>5_000_000){toast('CSV files are limited to 5 MB.');return;}
 const campaign=S.researchCampaign;S.researchBusy=true;S.researchResult=null;S.researchPreview=null;S.researchFile=null;render();
 try{const csv=await file.text();const p=await Api.post(`/api/admin/campaigns/${campaign}/research-preview`,{csv});if(campaign===S.researchCampaign){S.researchPreview=p;S.researchFile={csv,filename:file.name};}}catch(e){fail(e);}finally{S.researchBusy=false;render();}
}
async function prepareResearchFile(){
 if(S.researchBusy||!S.researchFile||!S.researchPreview?.valid||S.researchPreview.errors.length)return;
 const campaign=S.researchCampaign,date=S.researchDate;if(!campaign||!date){toast('Choose a campaign and availability date.');return;}
 S.researchBusy=true;S.researchResult=null;render();
 try{S.researchResult=await Api.post(`/api/admin/campaigns/${campaign}/research`,{...S.researchFile,available_on:date},{idem:Api.key()});S.researchPreview=null;S.researchFile=null;}catch(e){fail(e);}finally{S.researchBusy=false;render();}
}
function adminResearchView(){
 const all=S.researchCampaigns||[],workspaces=[...new Map(all.map(c=>[c.workspace_id,c])).values()];
 const campaigns=all.filter(c=>c.workspace_id===S.researchWorkspace),selected=campaigns.find(c=>c.id===S.researchCampaign),p=S.researchPreview,r=S.researchResult;
 S.researchDate ||= new Date().toISOString().slice(0,10);
 return `<section class="panel" style="margin-bottom:24px"><div class="panel-header"><div><h2>Weekly research leads</h2><p>Prepare leads for a customer’s campaign. Customers receive them through Research Leads.</p></div><a class="button small" href="/research-import-template.csv" download>Download research template</a></div>
 <div class="three-col"><div class="field"><label>Customer workspace</label><select aria-label="Customer workspace" onchange="researchSelection('researchWorkspace',this.value)" ${S.researchBusy?'disabled':''}><option value="">Choose a customer</option>${workspaces.map(c=>`<option value="${esc(c.workspace_id)}" ${S.researchWorkspace===c.workspace_id?'selected':''}>${esc(c.workspace)} · ${esc(c.owner_email||c.workspace_id)}</option>`).join('')}</select></div>
 <div class="field"><label>Target campaign</label><select aria-label="Target campaign" onchange="researchSelection('researchCampaign',this.value)" ${!S.researchWorkspace||S.researchBusy?'disabled':''}><option value="">Choose a campaign</option>${campaigns.map(c=>`<option value="${esc(c.id)}" ${S.researchCampaign===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
 <div class="field"><label for="research-date">Available from (UTC)</label><input id="research-date" type="date" value="${esc(S.researchDate)}" onchange="researchSelection('researchDate',this.value)" ${S.researchBusy?'disabled':''}></div></div>
 <p class="helper">Up to 150 contacts per weekly file. Customers can receive up to 30 per day, on five days per UTC week, with one research campaign per day. Only matching, verified contacts become available. Use email_status=valid only after actual verification. Set quality_score (0–100); omitted scores default to 100. Approved scores replace calculated quality, while targeting and opt-outs remain enforced.</p>
 <p class="helper">Required columns: first_name, last_name, email, company. Add targeting fields and research_fact / research_url for personalised emails. The template row is an example; replace it with real research. For FTP Canadian contacts, include a reviewed CASL basis and evidence before sending; marking an email valid does not establish consent.</p>
 <p class="helper">Canada review columns: casl_basis (express, implied_publication, implied_relationship or exemption), casl_evidence (describe the reviewed record), casl_source_url (required for publication) and casl_expires_on (YYYY-MM-DD; required except for express consent). A recorded basis must be reviewed for the specific recipient; the app cannot determine legal compliance.</p>
 ${!all.length?'<p class="notice">No customer campaigns yet. A customer must create a campaign before you can prepare its leads.</p>':''}
 <button onclick="$('research-file').click()" ${!selected||S.researchBusy?'disabled':''}>${S.researchBusy?'Checking…':'Choose research CSV'}</button><input id="research-file" type="file" hidden accept=".csv,text/csv" onchange="previewResearchFile(this)">
 ${p?`<div style="margin-top:16px"><strong>${esc(S.researchFile.filename)}</strong><p>${p.valid} valid contacts · ${p.duplicates} duplicate rows · ${p.errors.length} invalid rows</p><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Company</th></tr></thead><tbody>${p.preview.map(x=>`<tr><td>${esc(x.first_name+' '+x.last_name)}</td><td>${esc(x.email)}</td><td>${esc(x.company)}</td></tr>`).join('')}</tbody></table></div>${p.errors.slice(0,10).map(e=>`<p class="helper">Row ${e.line}: ${esc(e.reason)}</p>`).join('')}<p>Upload to <strong>${esc(selected?.workspace)} — ${esc(selected?.name)}</strong>, available ${esc(S.researchDate)} (UTC for daily discovery; weekly preparation uses the IST calendar date). Campaign qualification runs on upload; this preview checks the file format.</p><button class="primary" onclick="prepareResearchFile()" ${S.researchBusy||p.errors.length||!p.valid?'disabled':''}>Confirm research upload</button></div>`:''}
 ${r?`<div class="notice" style="margin-top:16px" role="status"><div><strong>Research list processed</strong><p>${r.ready} matched contacts · ${r.rejected.length} did not qualify · ${r.import.rejected.length} import issues. No emails were sent.</p>${r.rejected.slice(0,10).map(x=>`<p class="helper">${esc(x.reason)}</p>`).join('')}${r.import.rejected.slice(0,10).map(x=>`<p class="helper">Row ${x.line}: ${esc(x.reason)}</p>`).join('')}</div></div>`:''}</section>`;
}
async function loadAdmin() { const [p, l, c] = await Promise.all([Api.get('/api/admin/people'), Api.get('/api/admin/log'),Api.get('/api/admin/research-campaigns')]); S.admin = p; S.adminLog = l.items; S.researchCampaigns=c.items; }
function adminView() {
  if (!S.session?.user.super_admin) return `<div class="panel empty"><h3>Super admins only</h3></div>`;
  const A = S.admin;
  const tag = p => [p.super_admin && badge('Super admin', 'green'), p.env_allowed && badge('Deployment setting'), p.added && badge('Added in portal'), !p.approved && badge('No access', 'red'), p.operator && badge('Operator', 'green')].filter(Boolean).join(' ');
  const acct = p => !p.account ? '<small class="subtle">Not signed up yet</small>' : `<strong>${esc(p.account.name)}</strong><small>${p.account.verified ? '' : 'Email not confirmed · '}${p.account.last_login_at ? 'Last active ' + fmtDate(p.account.last_login_at) : 'Never signed in'}${p.account.workspaces ? ' · ' + esc(p.account.workspaces) : ''}</small>`;
  const actions = p => p.super_admin ? '<small class="subtle">Set in deployment</small>'
    : p.editable ? `<label class="inline" style="margin:0"><input type="checkbox" ${p.operator ? 'checked' : ''} onchange="adminOperator('${esc(p.email)}',this.checked)"> Operator</label><button class="small ghost" onclick="adminRemove('${esc(p.email)}')">Remove access</button>`
    : p.approved ? '<small class="subtle">Managed in deployment settings</small>'
    : `<button class="small" onclick="adminAdd(['${esc(p.email)}'],false,false)">Restore access</button>`;
  return `<div class="heading"><div><div class="eyebrow">SUPER ADMIN</div><h1>Customer management</h1><p>Manage customer access and prepare campaign research.</p></div>${badge('Super admin', 'green')}</div>
  ${adminResearchView()}
  <div class="wizard-grid"><div class="stack">
  <section class="panel"><div class="panel-header"><div><h2>Add people</h2><p>One or many emails, separated by commas, spaces, or new lines.</p></div>${icon('people')}</div>
    <div class="field"><label for="admin-emails">Email addresses</label><textarea id="admin-emails" placeholder="name@company.com, other@company.com"></textarea></div>
    <div class="field"><label for="admin-note">Note (optional)</label><input id="admin-note" placeholder="e.g. Design partner, Acme"></div>
    <label class="inline"><input id="admin-operator" type="checkbox"> Operator: can import leads into the pilot pool</label>
    <label class="inline" style="margin-top:8px"><input id="admin-notify" type="checkbox" checked> Email them an invitation to sign up</label>
    <div style="margin-top:14px"><button class="primary" onclick="adminAddFromForm()" ${S.adminBusy ? 'disabled' : ''}>${S.adminBusy ? 'Adding…' : 'Approve'}</button></div></section>
  <section class="panel"><div class="panel-header"><div><h2>People</h2><p>${A ? (n => `${n} approved ${n === 1 ? 'person' : 'people'}`)(A.people.filter(p => p.approved).length) : ''}</p></div></div>
  ${!A ? loadingPanel() : `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Email</th><th>Account</th><th>Access</th><th></th></tr></thead><tbody>${A.people.map(p => `<tr><td>${esc(p.email)}${p.added?.note ? `<small>${esc(p.added.note)}</small>` : ''}</td><td>${acct(p)}</td><td>${tag(p)}</td><td><div class="inline">${actions(p)}</div></td></tr>`).join('')}</tbody></table></div>`}</section></div>
  <aside class="wizard-aside stack"><section class="panel"><h2 style="font-size:14px">How access works</h2><p class="subtle">Approved people can create an account with that exact email and get their own workspace. Removing access signs them out everywhere; their workspace data is kept.</p><p class="subtle">Super admins are set in the deployment configuration and can't be changed here.</p></section>

  <section class="panel"><h2 style="font-size:14px">Recent admin activity</h2>${(S.adminLog || []).map(e => `<div class="summary-row"><small>${fmtDate(e.created_at)} · ${esc(e.actor || '')}</small><p>${esc(e.summary)}</p></div>`).join('') || '<p class="helper">No admin activity yet.</p>'}</section></aside></div>`;
}
async function adminAdd(emails, operator, notify, note = '') {
  S.adminBusy = true; render();
  try {
    const r = await Api.post('/api/admin/people', { emails, operator, notify, note });
    S.admin = r; S.adminLog = (await Api.get('/api/admin/log')).items;
    const failed = r.results.filter(x => x.notify_error);
    toast(`${r.results.length} ${r.results.length === 1 ? 'person' : 'people'} approved.${failed.length ? ` Invitation email failed for ${failed.map(x => x.email).join(', ')}.` : ''}`);
    return true;
  } catch (e) { fail(e); return false; }
  finally { S.adminBusy = false; render(); }
}
async function adminAddFromForm() {
  const emails = $('admin-emails').value, ok = await adminAdd(emails, $('admin-operator').checked, $('admin-notify').checked, $('admin-note').value);
  if (ok && $('admin-emails')) $('admin-emails').value = '';
}
async function adminOperator(email, operator) {
  try { S.admin = await Api.patch(`/api/admin/people/${encodeURIComponent(email)}`, { operator }); S.adminLog = (await Api.get('/api/admin/log')).items; render(); toast(operator ? `${email} can import leads.` : `${email} can no longer import leads.`); } catch (e) { fail(e); }
}
async function adminRemove(email) {
  if (!confirm(`Remove ${email} from the pilot? They'll be signed out everywhere and can't sign in again until re-approved. Their workspace data is kept.`)) return;
  try { S.admin = await Api.del(`/api/admin/people/${encodeURIComponent(email)}`); S.adminLog = (await Api.get('/api/admin/log')).items; render(); toast(`${email} removed.`); } catch (e) { fail(e); }
}

async function signOutEverywhere() { try { await Api.post('/api/auth/logout-all'); } catch { /* ignore */ } S.auth = null; await showAuth('signin', { error: '' }); }

render();
authConfig().then(c => { S.authConfig = c; });
boot();

async function sendSmtp(id) { const t=S.tasks.items.find(x=>x.id===id); if(t?.kind==='followup'&&!confirm('Have you checked your inbox and confirmed there is no reply or opt-out from this recipient?')) return; try { await Api.post('/api/tasks/'+id+'/send-smtp',{no_reply_confirmed:t?.kind==='followup'}); toast('SMTP server accepted the message. Delivery is not yet confirmed.'); await loadTasks(); render(); } catch(e){fail(e);} }
function emailSetupView() {
 const m=S.mailbox||{}, owner=S.session?.user?.role==='owner';
 const field=(key,label,value='',type='text')=>`<div class="field"><label for="smtp-${key}">${label}</label><input id="smtp-${key}" type="${type}" value="${esc(value)}" autocomplete="${key==='password'?'new-password':'off'}" ${!owner?'disabled':''}></div>`;
 return `<div class="heading"><div><div class="eyebrow">WORKSPACE ONBOARDING · STEP 2 OF 2</div><h1>Connect your sending email.</h1><p>Connect once. Review and launch campaigns separately.</p></div><button onclick="navigate('account')">← Company context</button></div>
 <div class="wizard-grid"><section class="panel"><div class="panel-header"><h2>${m.sender?'Manage your connection':'Email setup'}</h2>${badge(m.sender?'Connection tested':'Not connected',m.sender?'green':'amber')}</div>
 ${m.sender?`<div class="notice"><span>Saved sender: ${esc(m.sender)}<br>Last tested: ${fmtDate(m.updated_at)}. SMTP acceptance does not confirm inbox delivery.</span></div>`:''}
 ${!owner?'<p>Only the workspace owner can connect or disconnect a mailbox.</p>':''}
 <div class="field"><label for="smtp-provider">Provider</label><select id="smtp-provider" onchange="smtpPreset(this.value)" ${!owner?'disabled':''}><option value="">Choose a provider</option><option value="gmail">Gmail / Google Workspace (app password where available)</option><option value="custom">Other approved SMTP provider</option></select></div>
 ${field('host','SMTP server')}${field('port','Port (465 or 587)','587','number')}${field('user','SMTP username')}${field('password',m.sender?'New app password (required to reconnect)':'Provider app password','','password')}${field('sender','Sender email',S.context.data.email,'email')}${field('postal_address','Business postal address',m.postal_address||'')}
 <p class="helper">Use a provider-issued app password or SMTP credential, not your normal account password. Your provider or administrator must permit SMTP. Saving sends one test email to the sender address shown above.</p>
 <button class="primary" onclick="connectSmtp()" ${!owner||S.smtpBusy?'disabled':''}>${S.smtpBusy?'Testing connection…':m.sender?'Test & replace connection':'Test & connect'}</button>
 ${m.sender?`<button class="ghost" onclick="disconnectSmtp()" ${!owner||S.smtpBusy?'disabled':''}>Disconnect</button><button onclick="navigate('home')">Continue to workspace →</button>`:''}</section>
 <aside class="panel wizard-aside"><h2>Your credentials stay private</h2><p>Encrypted before database storage. Saved passwords are never returned to this page or included in AI prompts.</p><h3>Before using campaigns</h3><p>Confirm the test email arrived. Configure your domain’s SPF, DKIM and DMARC with your email administrator.</p><h3>What SMTP does</h3><p>Sends email. It does not synchronize replies or bounces. Follow-ups still need an inbox check.</p><p>Disconnect removes the active credentials. Also revoke the app password with your provider if you no longer want it used.</p></aside></div>`;
}
function smtpPreset(provider){if(provider==='gmail'){$('smtp-host').value='smtp.gmail.com';$('smtp-port').value='465';$('smtp-user').value=S.context.data.email;}else{$('smtp-host').value='';$('smtp-port').value='587';}}
async function connectSmtp(){
 if(S.smtpBusy)return;
 const body=Object.fromEntries(['host','port','user','password','sender','postal_address'].map(k=>[k,$('smtp-'+k).value]));
 const provider=$('smtp-provider').value; let errorMessage='';
 S.smtpBusy=true; $('smtp-password').value='';
 try{S.mailbox=await Api.post('/api/mailbox',body);toast('Connection saved. Check your inbox for the test email.');}
 catch(e){errorMessage=e.message||'Connection failed.';}
 finally{
 body.password='';S.smtpBusy=false;render();
 if(errorMessage && S.view==='email'){
 for(const key of ['host','port','user','sender','postal_address']) if($('smtp-'+key)) $('smtp-'+key).value=body[key];
 if($('smtp-provider')) $('smtp-provider').value=provider;
 const notice=document.createElement('p');notice.className='notice';notice.setAttribute('role','alert');notice.textContent=errorMessage+' Re-enter your app password to retry.';
 $('smtp-password')?.closest('.field')?.after(notice);
 }
 if(errorMessage)toast(errorMessage);
 }
}
async function disconnectSmtp(){if(!confirm('Disconnect this mailbox? Future SMTP sends will be blocked.'))return;try{await Api.del('/api/mailbox');S.mailbox={sender:null};render();toast('Mailbox disconnected. Revoke its app password with your provider if no longer needed.');}catch(e){fail(e);}}
