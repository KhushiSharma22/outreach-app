// Workspace company context (versioned) and campaign configuration (versioned).
import { id, now } from './db.mjs';
import { AppError, notFound, conflict, invalid, json, EMAIL_RE, validTimezone, WEEKDAYS } from './lib.mjs';
import { CATALOG } from './ai.mjs';

export const DEFAULT_CONTEXT = {
  company: 'Northstar', website: 'northstar.example',
  offering: 'We help B2B SaaS teams build a repeatable outbound process, from finding the right prospects to personalized outreach.',
  icp: 'Founders and heads of growth at B2B SaaS companies with 10–200 employees in India.',
  proof: 'Hands-on setup, a clear qualification process, and tailored messaging.',
  tone: 'Conversational', sender: 'Maya', email: 'maya@northstar.example', signature: 'Maya\nNorthstar',
  exclusions: 'Existing customers, competitors, agencies, and active opportunities',
};
const CONTEXT_FIELDS = Object.keys(DEFAULT_CONTEXT);
const TONES = ['Conversational', 'Professional', 'Warm'];

// ---------- Company context ----------
export async function currentContext(ctx) {
  const row = await ctx.db.get('SELECT * FROM account_context_versions WHERE workspace_id=? ORDER BY version DESC LIMIT 1', [ctx.ws]);
  return row && { id: row.id, version: row.version, data: json(row.data), created_at: row.created_at };
}
export async function contextById(ctx, versionId) {
  const row = await ctx.db.get('SELECT * FROM account_context_versions WHERE id=? AND workspace_id=?', [versionId, ctx.ws]);
  if (!row) throw notFound('Company context version');
  return { id: row.id, version: row.version, data: json(row.data) };
}
export async function saveContext(ctx, { version, data }) {
  const cur = await currentContext(ctx);
  if (cur && version !== cur.version) throw conflict('stale_version', 'Company context changed since you loaded it. Reload and reapply your edits.', { current: cur });
  const next = {};
  for (const k of CONTEXT_FIELDS) next[k] = String(data?.[k] ?? cur?.data[k] ?? '').trim();
  const fields = {};
  for (const k of ['company', 'offering', 'icp', 'sender', 'email', 'signature']) if (!next[k]) fields[k] = 'Required.';
  if (next.email && !EMAIL_RE.test(next.email)) fields.email = 'Enter a valid email address.';
  if (!TONES.includes(next.tone)) fields.tone = 'Choose a supported tone.';
  if (Object.keys(fields).length) throw invalid('Complete the required company context fields.', fields);
  const row = { id: id(), workspace_id: ctx.ws, version: (cur?.version || 0) + 1, data: JSON.stringify(next), created_by: ctx.user?.id, created_at: now() };
  await ctx.db.insert('account_context_versions', row);
  await ctx.db.audit(ctx.ws, null, 'context.saved', `Company context saved (version ${row.version})`, {}, ctx.user?.id);
  return await currentContext(ctx);
}

// ---------- Campaign configuration ----------
export function defaultConfig(context) {
  return {
    offer: context.offering,
    filters: { roles: [], industries: [], locations: [], sizes: [], seniority: [], exclude: ['Existing customers', 'Competitors', 'Active opportunities'] },
    notes: '', source: 'research', sourceRef: '', signals: ['Hiring', 'Funding'], freshness: 30,
    min: 25, target: 28, quality: 80, requireVerifiedEmail: true,
    writing: { tone: context.tone, length: 'Balanced', angle: 'Signal-led', cta: 'Start a conversation' },
    schedule: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], time: '09:00', timezone: 'Asia/Kolkata' },
    approval: 'daily', delivery: 'manual',
  };
}
const arr = v => Array.isArray(v) ? [...new Set(v.map(x => String(x).trim()).filter(Boolean))].slice(0, 30) : [];
export function normalizeConfig(base, patch = {}) {
  const c = structuredClone(base);
  if ('offer' in patch) c.offer = String(patch.offer || '').trim();
  if (patch.filters) for (const k of Object.keys(c.filters)) if (k in patch.filters) c.filters[k] = arr(patch.filters[k]);
  if ('notes' in patch) c.notes = String(patch.notes || '').slice(0, 2000);
  if ('source' in patch) c.source = ['research', 'upload', 'import', 'salesnav'].includes(patch.source) ? patch.source : c.source;
  if ('sourceRef' in patch) c.sourceRef = String(patch.sourceRef || '').slice(0, 500);
  if ('signals' in patch) c.signals = arr(patch.signals).filter(s => CATALOG.signals.includes(s));
  if ('freshness' in patch) c.freshness = [7, 30, 90].includes(+patch.freshness) ? +patch.freshness : c.freshness;
  if ('target' in patch) c.target = Math.min(30, Math.max(1, Math.round(+patch.target || 1)));
  c.min = Math.min(c.min, c.target);
  if ('quality' in patch) c.quality = Math.min(95, Math.max(70, Math.round(+patch.quality || 80)));
  if ('requireVerifiedEmail' in patch) c.requireVerifiedEmail = !!patch.requireVerifiedEmail;
  if (patch.writing) {
    const w = patch.writing;
    if (TONES.includes(w.tone)) c.writing.tone = w.tone;
    if (['Balanced', 'Concise'].includes(w.length)) c.writing.length = w.length;
    if (['Signal-led', 'Company-led'].includes(w.angle)) c.writing.angle = w.angle;
    if (['Start a conversation', 'Book a meeting', 'Ask permission'].includes(w.cta)) c.writing.cta = w.cta;
  }
  if (patch.schedule) {
    const s = patch.schedule;
    if ('days' in s) c.schedule.days = WEEKDAYS.filter(d => arr(s.days).includes(d));
    if ('time' in s) c.schedule.time = String(s.time || '');
    if ('timezone' in s) c.schedule.timezone = String(s.timezone || '');
  }
  if ('approval' in patch) {
    if (patch.approval === 'rules') throw invalid('Pre-approved rules mode is not available yet. Every daily batch needs your review.', { approval: 'Unavailable.' });
    c.approval = 'daily';
  }
  return c;
}
export function scheduleErrors(s) {
  const e = [];
  if (!s.days.length) e.push('Choose at least one day.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) e.push('Choose a valid time (HH:MM).');
  if (!validTimezone(s.timezone)) e.push('Choose a valid timezone.');
  return e;
}

// ---------- Campaign records ----------
async function configRow(ctx, campaignId, version) {
  return json((await ctx.db.get('SELECT data FROM campaign_config_versions WHERE campaign_id=? AND version=?', [campaignId, version])).data);
}
export async function loadCampaign(ctx, campaignId) {
  const c = await ctx.db.get('SELECT * FROM campaigns WHERE id=? AND workspace_id=?', [campaignId, ctx.ws]);
  if (!c) throw notFound('Campaign');
  c.config = await configRow(ctx, c.id, c.config_version);
  c.context = await contextById(ctx, c.context_version_id);
  return c;
}
export async function listCampaigns(ctx) {
  return await Promise.all((await ctx.db.all(`SELECT c.*, (SELECT count(*) FROM campaign_leads l WHERE l.campaign_id=c.id AND l.selected=1) selected_count,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id) sent_count,
      (SELECT count(*) FROM conversation_events e WHERE e.campaign_id=c.id AND e.type='reply') reply_count
    FROM campaigns c WHERE c.workspace_id=? ORDER BY c.created_at DESC`, [ctx.ws]))
    .map(async c => ({ ...c, config: await configRow(ctx, c.id, c.config_version) })));
}
export async function createCampaign(ctx, { name, prompt = '', brief, source } = {}) {
  const context = await currentContext(ctx);
  if (!context) throw new AppError(409, 'missing_context', 'Save your company context first.');
  let config = defaultConfig(context.data);
  if (['import','salesnav','research','upload'].includes(source)) config.source=source;
  // An interpreted brief is applied only as the user confirmed it; the original prompt is kept verbatim.
  if (brief) config = normalizeConfig(config, { filters: brief.filters, signals: Array.isArray(brief.signals) ? brief.signals : config.signals, notes: brief.notes });
  const t = now(), c = { id: id(), workspace_id: ctx.ws, name: String(name || brief?.name || 'Untitled campaign').trim().slice(0, 120) || 'Untitled campaign', prompt: String(prompt).slice(0, 4000), status: 'draft', step: 0, context_version_id: context.id, config_version: 1, revision: 1, launched_at: null, created_at: t, updated_at: t };
  await ctx.db.tx(async () => {
    await ctx.db.insert('campaigns', c);
    await ctx.db.insert('campaign_config_versions', { id: id(), campaign_id: c.id, version: 1, data: JSON.stringify(config), created_by: ctx.user?.id, created_at: t });
    await ctx.db.audit(ctx.ws, c.id, 'campaign.created', prompt ? 'Campaign created from assistant brief' : 'Campaign created', {}, ctx.user?.id);
  });
  return await loadCampaign(ctx, c.id);
}
export async function updateCampaign(ctx, campaignId, body) {
  const c = await loadCampaign(ctx, campaignId);
  const onlyStep = Object.keys(body).every(k => k === 'step' || k === 'revision');
  if (!onlyStep && body.revision !== c.revision) throw conflict('stale_revision', 'This campaign changed since you loaded it. Reload to see the latest version.', { revision: c.revision });
  if (c.status === 'stopped') throw conflict('campaign_stopped', 'Stopped campaigns cannot be edited.');
  const t = now(), changes = [];
  await ctx.db.tx(async () => {
    if ('step' in body) await ctx.db.run('UPDATE campaigns SET step=? WHERE id=?', [Math.min(5, Math.max(0, +body.step || 0)), c.id]);
    if ('name' in body) {
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) throw invalid('Campaign name is required.', { name: 'Required.' });
      if (name !== c.name) { await ctx.db.run('UPDATE campaigns SET name=? WHERE id=?', [name, c.id]); changes.push('name'); }
    }
    if (body.context === 'latest') {
      const cur = await currentContext(ctx);
      if (cur.id !== c.context_version_id) { await ctx.db.run('UPDATE campaigns SET context_version_id=? WHERE id=?', [cur.id, c.id]); changes.push('context'); }
    }
    if (body.config) {
      const next = normalizeConfig(c.config, body.config);
      if (c.status !== 'draft') { const e = scheduleErrors(next.schedule); if (e.length) throw invalid(e.join(' '), { schedule: e }); }
      if (JSON.stringify(next) !== JSON.stringify(c.config)) {
        const v = c.config_version + 1;
        await ctx.db.insert('campaign_config_versions', { id: id(), campaign_id: c.id, version: v, data: JSON.stringify(next), created_by: ctx.user?.id, created_at: t });
        await ctx.db.run('UPDATE campaigns SET config_version=? WHERE id=?', [v, c.id]);
        changes.push(...Object.keys(body.config));
      }
    }
    if (changes.length) {
      await ctx.db.run('UPDATE campaigns SET revision=revision+1, updated_at=? WHERE id=?', [t, c.id]);
      await ctx.db.audit(ctx.ws, c.id, 'campaign.updated', `Campaign settings updated (${[...new Set(changes)].join(', ')})`, { changes }, ctx.user?.id);
    }
  });
  return await loadCampaign(ctx, c.id);
}
