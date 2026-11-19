// Sourcing: CSV import with identity resolution, deterministic eligibility checks,
// deterministic qualification and persisted discovery batches.
import { id, now, hash } from './db.mjs';
import { AppError, notFound, invalid, conflict, json, parseCsv, EMAIL_RE, normEmail, normDomain, normLinkedin, localView } from './lib.mjs';
import { CATALOG, sizeBuckets } from './ai.mjs';
import { loadCampaign } from './campaigns.mjs';
import { startCampaignDiscovery, assessPrepared } from './lead-pools.mjs';

// ---------- Import ----------
const HEADERS = {
  first_name: ['first_name', 'first name', 'firstname', 'given name'], last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  full_name: ['full_name', 'name', 'full name', 'contact name'], email: ['email', 'email address', 'work email', 'e-mail'],
  email_status: ['email_status', 'email status', 'verification', 'email verification'], role: ['role', 'title', 'job title', 'position'],
  seniority: ['seniority'], company: ['company', 'company name', 'organization', 'account', 'account name'], domain: ['domain', 'website', 'company website', 'company domain'],
  industry: ['industry'], employees: ['employees', 'company_size', 'company size', 'headcount', 'employee count', 'size'],
  location: ['location', 'country', 'region', 'city'], linkedin_url: ['linkedin_url', 'linkedin', 'linkedin url', 'profile url', 'person linkedin url'],
  relationship: ['relationship', 'account status', 'status', 'tags'],
  casl_basis: ['casl_basis'], casl_evidence: ['casl_evidence'], casl_source_url: ['casl_source_url'], casl_expires_on: ['casl_expires_on'],
  signal: ['signal', 'signal type', 'signal_type', 'trigger'], signal_fact: ['signal_fact', 'signal fact', 'evidence', 'signal detail', 'research_fact', 'company_research'],
  signal_date: ['signal_date', 'signal date', 'event date', 'event_date'], signal_url: ['signal_url', 'source', 'source url', 'signal source', 'evidence url', 'research_url'],
};
const EMAIL_STATUSES = { valid: 'valid', verified: 'valid', deliverable: 'valid', ok: 'valid', invalid: 'invalid', undeliverable: 'invalid', bounced: 'invalid', 'catch-all': 'catch_all', catch_all: 'catch_all', catchall: 'catch_all', 'accept-all': 'catch_all', unknown: 'unknown', risky: 'unknown', unverified: 'unverified', '': 'unverified' };
const SIGNAL_ALIASES = { hiring: 'Hiring', 'job opening': 'Hiring', jobs: 'Hiring', funding: 'Funding', fundraise: 'Funding', 'funding round': 'Funding', 'new leadership': 'New leadership', leadership: 'New leadership', 'new hire': 'New leadership', expansion: 'Expansion', expanding: 'Expansion' };
const MAX_ROWS = 5000;

export async function importCsv(ctx, { filename = 'import.csv', csv, source = 'csv' }, importedIds = null) {
  if (typeof csv !== 'string' || !csv.trim()) throw invalid('Choose a CSV file with a header row.');
  if (csv.length > 5_000_000) throw invalid('CSV files are limited to 5 MB.');
  if (/^\s*PK|^\s*%PDF|<html/i.test(csv.slice(0, 20))) throw invalid('This file is not a CSV. Export your list as comma-separated values and try again.');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw invalid('The CSV needs a header row and at least one contact.');
  if (rows.length - 1 > MAX_ROWS) throw invalid(`Import up to ${MAX_ROWS} contacts at a time.`);
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) { const i = header.findIndex(h => names.includes(h)); if (i >= 0) col[k] = i; }
  const missing = [];
  if (col.company === undefined) missing.push('company');
  if (col.first_name === undefined && col.full_name === undefined) missing.push('first_name or name');
  if (col.email === undefined && col.linkedin_url === undefined) missing.push('email or linkedin_url');
  if (missing.length) throw invalid(`Missing required column(s): ${missing.join(', ')}. Recognized headers include first_name, last_name, email, title, company, domain, industry, employees, location, linkedin_url, signal, signal_fact, signal_date, signal_url.`);

  const t = now(), imp = { id: id(), workspace_id: ctx.ws, filename: String(filename).slice(0, 200), source: source === 'salesnav_export' ? 'salesnav_export' : 'csv', row_count: rows.length - 1, created_count: 0, updated_count: 0, rejected: '[]', created_by: ctx.user?.id, created_at: t };
  const rejected = [];
  await ctx.db.tx(async () => {
    await ctx.db.insert('imports', imp);
    for (const [i, r] of rows.slice(1).entries()) {
      const v = k => col[k] === undefined ? '' : String(r[col[k]] ?? '').trim();
      const line = i + 2;
      let first = v('first_name'), last = v('last_name');
      if (!first && v('full_name')) { const p = v('full_name').split(/\s+/); first = p[0]; last = last || p.slice(1).join(' '); }
      const companyName = v('company'), email = normEmail(v('email')), linkedin = normLinkedin(v('linkedin_url'));
      if (!first) { rejected.push({ line, reason: 'Missing first name.' }); continue; }
      if (!companyName) { rejected.push({ line, reason: 'Missing company.' }); continue; }
      if (email && !EMAIL_RE.test(email)) { rejected.push({ line, reason: `Invalid email address "${email}".` }); continue; }
      if (!email && !linkedin) { rejected.push({ line, reason: 'Needs an email address or a LinkedIn profile URL to identify the person.' }); continue; }
      const statusKey = v('email_status').toLowerCase();
      if (!(statusKey in EMAIL_STATUSES)) { rejected.push({ line, reason: `Unrecognized email_status "${v('email_status')}". Use valid, invalid, catch-all, unknown, or leave blank.` }); continue; }
      const employees = parseEmployees(v('employees'));
      const domain = normDomain(v('domain')) || (email && !FREE_MAIL.test(email) ? email.split('@')[1] : null);
      const company = await upsertCompany(ctx, { name: companyName, domain, industry: v('industry') || null, employees, location: v('location') || null, relationship: v('relationship').toLowerCase() || null }, t);
      const existing = (email && await ctx.db.get('SELECT * FROM contacts WHERE workspace_id=? AND email=?', [ctx.ws, email]))
        || (linkedin && await ctx.db.get('SELECT * FROM contacts WHERE workspace_id=? AND linkedin_url=?', [ctx.ws, linkedin]))
        || (!email && await ctx.db.get('SELECT * FROM contacts WHERE workspace_id=? AND company_id=? AND lower(first_name)=lower(?) AND lower(last_name)=lower(?) AND email IS NULL', [ctx.ws, company.id, first, last]));
      const emailStatus = email ? EMAIL_STATUSES[statusKey] : 'missing';
      const fields = { company_id: company.id, first_name: first, last_name: last, role: v('role'), seniority: v('seniority') || null, location: v('location') || null };
      let contactId;
      if (existing) {
        contactId = existing.id;
        const keepStatus = !statusKey && existing.email === email; // a blank status never downgrades a known verification
        await ctx.db.run(`UPDATE contacts SET company_id=:company_id, first_name=:first_name, last_name=:last_name, role=coalesce(nullif(:role,''),role), seniority=coalesce(:seniority,seniority), location=coalesce(:location,location),
          email=coalesce(:email,email), linkedin_url=coalesce(:linkedin,linkedin_url), email_status=CASE WHEN :keep=1 THEN email_status ELSE :status END,
          email_verifier=CASE WHEN :keep=1 THEN email_verifier ELSE :verifier END, email_checked_at=CASE WHEN :keep=1 THEN email_checked_at ELSE :checked END, updated_at=:t WHERE id=:id`,
        { ...fields, email, linkedin, keep: keepStatus ? 1 : 0, status: emailStatus, verifier: statusKey ? 'import' : null, checked: statusKey ? t : null, t, id: existing.id });
        imp.updated_count++;
      } else {
        contactId = id();
        await ctx.db.insert('contacts', { id: contactId, workspace_id: ctx.ws, ...fields, linkedin_url: linkedin, email, email_status: emailStatus, email_verifier: statusKey ? 'import' : null, email_checked_at: statusKey ? t : null, source_import_id: imp.id, created_at: t, updated_at: t });
        imp.created_count++;
      }
      // A reviewer must record a legal basis; an email marked valid is not consent.
      const basis=v('casl_basis').toLowerCase(), consentEvidence=v('casl_evidence'), consentUrl=v('casl_source_url'), expiry=v('casl_expires_on');
      if (basis || consentEvidence || consentUrl || expiry) {
        const validDate = !expiry || (/^\d{4}-\d{2}-\d{2}$/.test(expiry) && Number.isFinite(Date.parse(expiry)) && new Date(expiry).toISOString().slice(0,10)===expiry);
        const validBasis = ['express','implied_publication','implied_relationship','exemption'].includes(basis);
        if (!email || !validBasis || consentEvidence.length < 15 || !validDate || (basis !== 'express' && !expiry) || (basis === 'implied_publication' && !safeUrl(consentUrl)) || (consentUrl && !safeUrl(consentUrl))) {
          await ctx.db.run('UPDATE casl_authorizations SET invalidated_at=? WHERE workspace_id=? AND contact_id=?',[t,ctx.ws,contactId]);
          rejected.push({line,reason:'Contact imported; previous CASL record invalidated and new record not saved. Supply a supported basis, at least 15 characters of evidence, a source URL for publication, and an expiry date for non-express bases.',partial:true});
        } else {
          await ctx.db.run(`INSERT INTO casl_authorizations(workspace_id,contact_id,email,basis,evidence,source_url,expires_on,reviewed_by,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,contact_id) DO UPDATE SET email=excluded.email,basis=excluded.basis,evidence=excluded.evidence,source_url=excluded.source_url,expires_on=excluded.expires_on,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,invalidated_at=NULL`,[ctx.ws,contactId,email,basis,consentEvidence.slice(0,2000),safeUrl(consentUrl),expiry||null,ctx.user?.id||null,t]);
        }
      }
      if (importedIds) importedIds.push(contactId);
      const fact = v('signal_fact'), signal = SIGNAL_ALIASES[v('signal').toLowerCase()] || null;
      if (v('signal') && !signal) rejected.push({ line, reason: `Contact imported; unrecognized signal "${v('signal')}" was ignored. Use Hiring, Funding, New leadership, or Expansion.`, partial: true });
      if (fact || signal) {
        const eventDate = parseDate(v('signal_date'));
        if (v('signal_date') && !eventDate) rejected.push({ line, reason: `Contact imported; signal date "${v('signal_date')}" was not understood (use YYYY-MM-DD) so the signal has no event date.`, partial: true });
        const factText = (fact || `${companyName}: ${signal} signal`).slice(0, 600);
        const fingerprint = hash(contactId, signal, factText, eventDate);
        if (!await ctx.db.get('SELECT 1 FROM evidence WHERE workspace_id=? AND fingerprint=?', [ctx.ws, fingerprint]))
          await ctx.db.insert('evidence', { id: id(), workspace_id: ctx.ws, contact_id: contactId, company_id: company.id, signal, fact: factText, source_url: safeUrl(v('signal_url')), event_date: eventDate, collected_at: t, provenance: `import:${imp.id}`, fingerprint });
      }
    }
    await ctx.db.run('UPDATE imports SET created_count=?, updated_count=?, rejected=? WHERE id=?', [imp.created_count, imp.updated_count, JSON.stringify(rejected), imp.id]);
    await ctx.db.audit(ctx.ws, null, 'import.completed', `Imported ${imp.filename}: ${imp.created_count} new, ${imp.updated_count} updated, ${rejected.filter(r => !r.partial).length} rejected`, { import_id: imp.id }, ctx.user?.id);
  });
  return { ...imp, rejected };
}
const FREE_MAIL = /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton(mail)?|aol|zoho|yandex|gmx)\./i;
const safeUrl = u => /^https?:\/\/[^\s<>"']+$/i.test(u) ? u.slice(0, 500) : null;
function parseEmployees(s) {
  if (!s) return null;
  const nums = s.replace(/,/g, '').match(/\d+/g);
  if (!nums) return null;
  return nums.length > 1 ? Math.round((+nums[0] + +nums[1]) / 2) : +nums[0];
}
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d) || d.getFullYear() < 2000 ? null : d.toISOString().slice(0, 10);
}
async function upsertCompany(ctx, c, t) {
  const found = c.domain ? await ctx.db.get('SELECT * FROM companies WHERE workspace_id=? AND domain=?', [ctx.ws, c.domain])
    : await ctx.db.get('SELECT * FROM companies WHERE workspace_id=? AND domain IS NULL AND lower(name)=lower(?)', [ctx.ws, c.name]);
  if (found) {
    await ctx.db.run('UPDATE companies SET name=?, industry=coalesce(?,industry), employees=coalesce(?,employees), location=coalesce(?,location), relationship=coalesce(?,relationship), updated_at=? WHERE id=?', [c.name, c.industry, c.employees, c.location, c.relationship, t, found.id]);
    return found;
  }
  const row = { id: id(), workspace_id: ctx.ws, ...c, created_at: t, updated_at: t };
  await ctx.db.insert('companies', row);
  return row;
}

// ---------- Deterministic checks ----------
const ROLE_ALIASES = { 'Soccer Coach': /\bcoach(?:ing)?\b/, 'Academy Director': /(?:academy|club|coaching|technical|sporting|soccer|football).{0,25}director|director.{0,25}(?:academy|club|coaching|technical|sporting|soccer|football)/, Founder: /founder|co-founder|owner/, CEO: /\bceo\b|chief executive/, CTO: /\bcto\b|chief technology/, 'Head of Growth': /head of growth|growth lead|vp,? growth|director of growth/, 'Head of Sales': /head of sales|sales head|director of sales|sales director/, 'VP Sales': /vp,? sales|vice president,? sales/, 'Marketing Director': /marketing director|director of marketing|head of marketing|\bcmo\b/, 'HR Director': /\bhr\b|human resources|people|talent/ };
const SENIORITY_RULES = [['Founder / Owner', /founder|owner/], ['C-level', /\bc[etofmr]o\b|chief/], ['VP / Head', /\bvp\b|vice president|head of/], ['Director', /director/], ['Manager', /manager|\blead\b/]];
const LOCATION_ALIASES = { Canada: /\bcanada\b|\bcanadian\b/, 'United States': /united states|\busa?\b|america/, 'United Kingdom': /united kingdom|\buk\b|england|london|scotland|britain/, UAE: /\buae\b|emirates|dubai|abu dhabi/, Europe: /europe|germany|france|spain|netherlands|ireland|sweden|italy|poland|portugal|denmark|finland|belgium|austria|switzerland/ };
const EXCLUDE_REL = { 'Existing customers': /customer|client/, Competitors: /competitor/, 'Active opportunities': /opportunit|in pipeline|deal/, Agencies: /agency/ };
const INDUSTRY_ALIASES = { 'Soccer clubs and academies': /\bsoccer\b|\bfootball\b/, 'B2B SaaS': /saas|software/, 'E-commerce': /e-?commerce|d2c|online retail/, 'IT services': /it services|information technology|consult/ };

export const deriveSeniority = role => (SENIORITY_RULES.find(([, re]) => re.test((role || '').toLowerCase())) || [null])[0];
const matches = (value, options, aliases = {}) => options.some(o => (aliases[o] || new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).test(value.toLowerCase()));

export function checkCandidate(ctx, config, context, cand, evidence, today) {
  const f = config.filters, checks = [];
  const add = (key, label, status, detail, weight) => checks.push({ key, label, status, detail, weight });
  // Email usability
  if (!cand.email) add('email', 'Email', 'unknown', 'No email address. Add one from an enrichment provider to proceed.', 0);
  else if (cand.suppressed) add('email', 'Email', 'fail', `Suppressed (${cand.suppressed}). This person cannot be contacted.`, 0);
  else if (cand.email_status === 'invalid') add('email', 'Email', 'fail', 'Verification marked this address invalid.', 0);
  else if (cand.email_status === 'valid') add('email', 'Email', 'pass', `Verified ${cand.email_verifier === 'import' ? 'by your import' : ''}`.trim(), 0);
  else add('email', 'Email', config.requireVerifiedEmail ? 'unknown' : 'pass', cand.email_status === 'catch_all' ? 'Catch-all domain: deliverability cannot be confirmed.' : 'Not verified. Verify it or approve manually.', 0);
  // Audience filters — missing data never counts as a match.
  const role = cand.role || '';
  if (f.roles.length) add('role', 'Role fit', !role ? 'unknown' : matches(role, f.roles, ROLE_ALIASES) ? 'pass' : 'fail', role || 'Job title unknown', 30);
  if (f.seniority.length) { const s = cand.seniority || deriveSeniority(role); add('seniority', 'Seniority', !s ? 'unknown' : f.seniority.includes(s) ? 'pass' : 'fail', s || 'Seniority unknown', 10); }
  if (f.industries.length) add('industry', 'Industry', !cand.industry ? 'unknown' : matches(cand.industry, f.industries, INDUSTRY_ALIASES) ? 'pass' : 'fail', cand.industry || 'Industry unknown', 15);
  if (f.locations.length) { const loc = cand.location || cand.company_location || ''; add('location', 'Location', !loc ? 'unknown' : matches(loc, f.locations, LOCATION_ALIASES) ? 'pass' : 'fail', loc || 'Location unknown', 10); }
  if (f.sizes.length) add('size', 'Company size', cand.employees == null ? 'unknown' : f.sizes.some(b => sizeBuckets(cand.employees, cand.employees).includes(b)) ? 'pass' : 'fail', cand.employees == null ? 'Employee count unknown' : `${cand.employees} employees`, 10);
  // Exclusions
  const rel = cand.relationship || '';
  const relHit = f.exclude.find(x => EXCLUDE_REL[x]?.test(rel)) || f.exclude.find(x => !EXCLUDE_REL[x] && (rel.includes(x.toLowerCase()) || cand.company.toLowerCase() === x.toLowerCase()));
  const listHit = exclusionList(context.exclusions).find(x => x === (cand.domain || '') || x === cand.company.toLowerCase());
  add('exclusions', 'Exclusions', relHit || listHit ? 'fail' : 'pass', relHit ? `Excluded: ${relHit} (${rel})` : listHit ? `On your company exclusion list (${listHit})` : 'No exclusion matched', 0);
  if (cand.other_campaign) add('duplicate', 'Not already contacted', 'unknown', `Already contacted in “${cand.other_campaign}”.`, 0);
  // Signals
  const relevant = evidence.filter(e => config.signals.includes(e.signal));
  const dated = relevant.filter(e => e.event_date).map(e => ({ e, age: Math.round((Date.parse(today) - Date.parse(e.event_date)) / 864e5) }));
  const fresh = dated.filter(x => x.age >= -1 && x.age <= config.freshness).sort((a, b) => a.age - b.age)[0];
  let signalScore = 0;
  if (!config.signals.length) add('signal', 'Signal', 'pass', 'No event trigger required; campaign uses audience fit.', 0);
  else if (fresh) { signalScore = 25 * (1 - 0.5 * Math.max(0, fresh.age) / config.freshness); add('signal', 'Signal', 'pass', `${fresh.e.signal}, ${fresh.age <= 0 ? 'today' : fresh.age + ' days ago'}`, 25); }
  else if (relevant.some(e => !e.event_date)) add('signal', 'Signal', 'unknown', 'Signal found but its event date is unknown, so it cannot count as recent.', 25);
  else if (dated.length) add('signal', 'Signal', 'fail', `Latest ${config.signals.join('/')} signal is older than ${config.freshness} days.`, 25);
  else add('signal', 'Signal', 'fail', `No ${config.signals.join(' or ')} evidence.`, 25);

  const weighted = checks.filter(c => c.weight);
  const possible = weighted.reduce((s, c) => s + c.weight, 0) || 1;
  const earned = weighted.reduce((s, c) => s + (c.key === 'signal' ? (c.status === 'pass' ? signalScore : 0) : c.status === 'pass' ? c.weight : 0), 0);
  const score = Math.round(100 * earned / possible);
  const fail = checks.find(c => c.status === 'fail'), unknown = checks.filter(c => c.status === 'unknown');
  const decision = fail ? 'excluded' : unknown.length ? 'review' : score < config.quality ? 'review' : 'qualified';
  const rationale = fail ? fail.detail : unknown.length ? unknown.map(c => c.detail).join(' ') : score < config.quality ? `Fit score ${score} is below your ${config.quality} threshold.` : (config.signals.length ? 'Role, company profile, and a recent signal match the campaign brief.' : 'Audience filters match; no event trigger is required. Buying intent still needs review.');
  return { decision, score, rationale, checks: checks.map(({ weight, ...c }) => c), missing: unknown.map(c => c.label), evidence_ids: (fresh ? [fresh.e] : relevant).slice(0, 3).map(e => e.id), confidence: unknown.length ? 'low' : 'high' };
}
const exclusionList = text => (text || '').toLowerCase().split(/[,;\n]/).map(s => normDomain(s.trim()) || '').filter(s => s.includes('.') || s.split(' ').length === 1).filter(Boolean);

// ---------- Discovery runs ----------
export async function startDiscovery(ctx, campaignId, { trigger = 'manual', occurrenceDate = null } = {}) {
  const c = await loadCampaign(ctx, campaignId);
  if (['research','upload'].includes(c.config.source)) return startCampaignDiscovery(ctx,c,{trigger,occurrenceDate});
  if (c.status === 'stopped') throw conflict('campaign_stopped', 'This campaign is stopped.');
  if (!c.config.filters.roles.length && !c.config.filters.industries.length) throw invalid('Choose at least one job role or industry so discovery has an audience.', { filters: 'Required.' });
  let runId;
  await ctx.db.tx(async () => {
    // Lock before counting or reserving: all campaigns share one daily allowance.
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?', [ctx.ws]);
    const running = await ctx.db.get("SELECT id FROM discovery_runs WHERE campaign_id=? AND status IN ('queued','running')", [c.id]);
    if (running) {
      if (occurrenceDate) await ctx.db.run('UPDATE discovery_runs SET occurrence_date=coalesce(occurrence_date,?) WHERE id=?',[occurrenceDate,running.id]);
      runId=running.id; return;
    }
    const allocations = await ctx.db.all('SELECT * FROM pilot_allocations WHERE workspace_id=? ORDER BY day', [ctx.ws]);
    const createdAt=now(), day=createdAt.slice(0,10);
    const existingDay=allocations.some(a=>a.day===day);
    if ((!existingDay && allocations.length>=5) || (allocations.length && Date.parse(day)-Date.parse(allocations[0].day)>=7*864e5)) throw conflict('pilot_complete', 'Your five-day pilot allocation has ended. Contact the team to extend your pilot.');
    const remaining=await remainingPilotContacts(ctx,day);
    if (!remaining) throw conflict('daily_limit', 'All 30 contact checks for today have been allocated across your campaigns (UTC). Excluded contacts also count as checked.');
    const batch=((await ctx.db.get('SELECT max(batch) b FROM discovery_runs WHERE campaign_id=?',[c.id])).b||0)+1;
    const run={id:id(),campaign_id:c.id,batch,config_version:c.config_version,trigger,occurrence_date:occurrenceDate,status:'queued',progress:'{}',created_at:createdAt};
    const contacts=await unallocatedContacts(ctx,c.id,remaining);
    if (!contacts.length) throw conflict('no_new_contacts','No new contacts are available to check. Import more prospects; previous contacts will not be counted again.');
    await ctx.db.insert('discovery_runs',run);
    if (!existingDay) await ctx.db.insert('pilot_allocations',{workspace_id:ctx.ws,day,run_id:run.id,created_at:createdAt});
    for (const contact of contacts) await ctx.db.insert('pilot_contacts',{workspace_id:ctx.ws,contact_id:contact.id,run_id:run.id});
    await ctx.jobs.enqueue(ctx.ws,'discovery',{run_id:run.id},{dedupe:'discovery:'+run.id});
    await ctx.db.audit(ctx.ws,c.id,'discovery.queued',`Discovery batch ${batch} queued: ${contacts.length} contacts reserved`,{run_id:run.id,trigger},ctx.user?.id);
    runId=run.id;
  });
  return await getRun(ctx,runId);
}
async function remainingPilotContacts(ctx,day) {
 const row=await ctx.db.get(`SELECT count(*) n FROM pilot_contacts pc JOIN discovery_runs r ON r.id=pc.run_id WHERE pc.workspace_id=? AND substr(r.created_at,1,10)=?`,[ctx.ws,day]);
 return Math.max(0,30-Number(row.n));
}
async function unallocatedContacts(ctx,campaignId,limit) {
 return await ctx.db.all(`SELECT ct.id FROM contacts ct WHERE ct.workspace_id=?
 AND NOT EXISTS (SELECT 1 FROM pilot_contacts pc WHERE pc.workspace_id=ct.workspace_id AND pc.contact_id=ct.id)
 AND NOT EXISTS (SELECT 1 FROM campaign_leads l WHERE l.campaign_id=? AND l.contact_id=ct.id)
 AND NOT EXISTS (SELECT 1 FROM campaign_contact_pool p WHERE p.workspace_id=ct.workspace_id AND p.contact_id=ct.id)
 ORDER BY ct.created_at,ct.id LIMIT ?`,[ctx.ws,campaignId,limit]);
}

export async function getRun(ctx, runId) {
  const r = await ctx.db.get('SELECT r.* FROM discovery_runs r JOIN campaigns c ON c.id=r.campaign_id WHERE r.id=? AND c.workspace_id=?', [runId, ctx.ws]);
  if (!r) throw notFound('Discovery run');
  return { ...r, progress: json(r.progress) };
}
export const listRuns = async (ctx, campaignId) => { await loadCampaign(ctx, campaignId); return (await ctx.db.all('SELECT * FROM discovery_runs WHERE campaign_id=? ORDER BY batch DESC', [campaignId])).map(r => ({ ...r, progress: json(r.progress) })); };

const MAX_CANDIDATES = () => +(process.env.MAX_CANDIDATES_PER_RUN || 300);

export async function executeDiscovery(ctx, runId) {
  const run = await getRun(ctx, runId);
  if (run.status === 'completed') return;
  const c = await loadCampaign(ctx, run.campaign_id), config = json((await ctx.db.get('SELECT data FROM campaign_config_versions WHERE campaign_id=? AND version=?', [c.id, run.config_version])).data);
  await ctx.db.run("UPDATE discovery_runs SET status='running', started_at=coalesce(started_at,?), error=NULL WHERE id=?", [now(), run.id]);
  // A retried run restarts cleanly: drop leads it created that have no downstream work.
  await ctx.db.run('DELETE FROM campaign_leads WHERE run_id=? AND id NOT IN (SELECT lead_id FROM drafts)', [run.id]);
  const today = localView(Date.now(), config.schedule.timezone || 'UTC').date;
  const scoped=['research','upload'].includes(config.source);
  if (!scoped) {
  // Compatibility for a run queued by an older deployment before contacts were reserved.
  await ctx.db.tx(async()=>{
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
    const reserved=await ctx.db.get('SELECT count(*) n FROM pilot_contacts WHERE workspace_id=? AND run_id=?',[ctx.ws,run.id]);
    if (!Number(reserved.n)) {
      const remaining=await remainingPilotContacts(ctx,run.created_at.slice(0,10));
      for (const contact of await unallocatedContacts(ctx,c.id,remaining)) await ctx.db.insert('pilot_contacts',{workspace_id:ctx.ws,contact_id:contact.id,run_id:run.id});
    }
  });
  }
  const candidates = await ctx.db.all(`SELECT ct.*, co.name company, co.domain, co.industry, co.employees, co.location company_location, co.relationship,
      s.reason suppressed,
      (SELECT c2.name FROM messages m JOIN campaigns c2 ON c2.id=m.campaign_id WHERE m.contact_id=ct.id AND m.campaign_id<>:cid LIMIT 1) other_campaign
    FROM ${scoped ? 'campaign_contact_claims' : 'pilot_contacts'} pc JOIN contacts ct ON ct.id=pc.contact_id AND ct.workspace_id=pc.workspace_id
    JOIN companies co ON co.id=ct.company_id
    LEFT JOIN suppressions s ON s.workspace_id=ct.workspace_id AND s.email=ct.email
    WHERE pc.workspace_id=:ws AND pc.run_id=:rid ORDER BY ct.created_at,ct.id`,{ws:ctx.ws,cid:c.id,rid:run.id});
  const progress = async p => await ctx.db.run('UPDATE discovery_runs SET progress=? WHERE id=?', [JSON.stringify(p), run.id]);
  await progress({ stage: 'checking', checked: 0, total: candidates.length });
  const assessed = [];
  for (const [i, cand] of candidates.entries()) {
    cand.name = `${cand.first_name} ${cand.last_name}`.trim();
    const evidence = await ctx.db.all('SELECT * FROM evidence WHERE workspace_id=? AND (contact_id=? OR (company_id=? AND contact_id IS NULL)) ORDER BY event_date DESC', [ctx.ws, cand.id, cand.company_id]);
    let result = config.source==='research' ? await assessPrepared(ctx,{...c,config},cand,evidence) : checkCandidate(ctx,config,c.context.data,cand,evidence,today), by = 'rules';
    assessed.push({ cand, result, by });
    if (i % 5 === 4) await progress({ stage: 'checking', checked: i + 1, total: candidates.length });
  }
  const qualified = assessed.filter(a => a.result.decision === 'qualified').sort((a, b) => b.result.score - a.result.score);
  const selected = new Set(qualified.slice(0, config.target).map(a => a.cand.id));
  const t = now();
  const shortfall = qualified.length < config.min ? shortfallReason(assessed, qualified.length, config, candidates.length) : null;
  await ctx.db.tx(async () => {
    for (const { cand, result, by } of assessed) {
      await ctx.db.insert('campaign_leads', { id: id(), campaign_id: c.id, contact_id: cand.id, run_id: run.id, decision: result.decision, score: result.score, rationale: result.rationale, checks: JSON.stringify(result.checks), missing: JSON.stringify(result.missing), confidence: result.confidence, evidence_ids: JSON.stringify(result.evidence_ids), assessed_by: by, selected: selected.has(cand.id) ? 1 : 0, override_by: null, override_reason: null, created_at: t, updated_at: t });
    }
    await ctx.db.run("UPDATE discovery_runs SET status='completed', candidates=?, qualified=?, selected=?, shortfall_reason=?, progress=?, finished_at=? WHERE id=?", [assessed.length, qualified.length, selected.size, shortfall, JSON.stringify({ stage: 'done', checked: assessed.length, total: assessed.length }), t, run.id]);
    await ctx.db.audit(ctx.ws, c.id, 'discovery.completed', `Batch ${run.batch}: ${qualified.length} qualified from ${assessed.length} candidates`, { run_id: run.id, shortfall });
  });
  return { campaign: c, run: await getRun(ctx, run.id) };
}
function shortfallReason(assessed, n, config, total) {
  if (!total) return 'No new contacts are available. Import more contacts that match this campaign.';
  const reasons = {};
  for (const a of assessed) if (a.result.decision !== 'qualified') { const k = a.result.checks.find(c => c.status === 'fail' || c.status === 'unknown')?.label || 'Fit below threshold'; reasons[k] = (reasons[k] || 0) + 1; }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ');
  return `${n} of ${total} candidates qualified, below the minimum of ${config.min}. Most common blockers: ${top || 'none'}. Import more matching contacts or refine filters; weaker matches were not added.`;
}
export async function failRun(db, runId, message) {
  await db.run("UPDATE discovery_runs SET status='failed', error=?, finished_at=? WHERE id=?", [message, now(), runId]);
}
