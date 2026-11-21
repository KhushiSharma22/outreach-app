// Metrics from persisted records, activity history, and the contact directory.
import { json, localView, addDays } from './lib.mjs';
import { loadCampaign } from './campaigns.mjs';

const n = async (db, sql, p) => (await db.get(sql, p)).n;
export async function campaignMetrics(ctx, campaignId) {
  const c = await loadCampaign(ctx, campaignId), db = ctx.db, id = c.id;
  const outcome = async type => await n(db, 'SELECT count(DISTINCT contact_id) n FROM conversation_events WHERE campaign_id=? AND type=?', [id, type]);
  const contacted = await n(db, 'SELECT count(DISTINCT contact_id) n FROM messages WHERE campaign_id=?', [id]);
  const replies = await outcome('reply');
  const tz = c.config.schedule.timezone, today = localView(Date.now(), tz).date;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const byDay = (rows) => { const m = {}; for (const r of rows) { const d = localView(Date.parse(r.t), tz).date; m[d] = (m[d] || 0) + 1; } return days.map(d => m[d] || 0); };
  const since = new Date(Date.now() - 8 * 864e5).toISOString();
  const todayWeekly = await db.get(`SELECT count(*) total, sum(CASE WHEN d.current_revision_id IS NOT NULL THEN 1 ELSE 0 END) drafted, sum(CASE WHEN d.current_revision_id IS NOT NULL AND d.current_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.draft_id=d.id AND a.revision_id=d.current_revision_id AND a.invalidated_at IS NULL) THEN 1 ELSE 0 END) awaiting FROM weekly_slots ws JOIN campaign_leads l ON l.campaign_id=ws.campaign_id AND l.contact_id=ws.contact_id LEFT JOIN drafts d ON d.lead_id=l.id WHERE ws.workspace_id=? AND ws.campaign_id=? AND ws.slot_date=? AND l.selected=1 AND l.decision='qualified'`,[ctx.ws,id,today]);
  const slots = await db.get('SELECT count(*) total FROM weekly_slots WHERE workspace_id=? AND campaign_id=? AND slot_date=?',[ctx.ws,id,today]);
  const nextSlot = await db.get('SELECT min(slot_date) AS next_date FROM weekly_slots WHERE workspace_id=? AND campaign_id=? AND slot_date>?',[ctx.ws,id,today]);
  const sentSeries=byDay(await db.all('SELECT sent_at t FROM messages WHERE campaign_id=? AND sent_at>=?', [id,since]));
  return {
    daily: {date:today,timezone:tz,planned:Number(todayWeekly.total||0),reserved:Number(slots.total||0),next_date:nextSlot.next_date||null,drafted:Number(todayWeekly.drafted||0),awaiting:Number(todayWeekly.awaiting||0),sent_today:sentSeries[6],sent_yesterday:sentSeries[5]},
    definitions: { sent: 'SMTP acceptance or manual confirmation; inbox delivery is not verified.', reply_rate: 'Unique contacts with a recorded reply ÷ unique contacts emailed.', meetings: 'Recorded manually.' },
    candidates: await n(db, "SELECT coalesce(sum(candidates),0) n FROM discovery_runs WHERE campaign_id=? AND status='completed'", [id]),
    qualified: await n(db, "SELECT count(*) n FROM campaign_leads WHERE campaign_id=? AND decision='qualified'", [id]),
    review: await n(db, "SELECT count(*) n FROM campaign_leads WHERE campaign_id=? AND decision='review'", [id]),
    excluded: await n(db, "SELECT count(*) n FROM campaign_leads WHERE campaign_id=? AND decision='excluded'", [id]),
    selected: await n(db, 'SELECT count(*) n FROM campaign_leads WHERE campaign_id=? AND selected=1', [id]),
    drafts_approved: await n(db, 'SELECT count(*) n FROM drafts d JOIN approvals a ON a.draft_id=d.id AND a.revision_id=d.current_revision_id AND a.invalidated_at IS NULL WHERE d.campaign_id=?', [id]),
    queued: await n(db, "SELECT count(*) n FROM send_tasks WHERE campaign_id=? AND status IN ('pending','held')", [id]),
    unknown: await n(db, "SELECT count(*) n FROM send_tasks WHERE campaign_id=? AND status='unknown'", [id]),
    sent: await n(db, 'SELECT count(*) n FROM messages WHERE campaign_id=?', [id]),
    contacted, replies, bounces: await outcome('bounce'), opt_outs: await outcome('opt_out'), meetings: await outcome('meeting'),
    reply_rate: contacted ? Math.round(1000 * replies / contacted) / 10 : null,
    batches: await n(db, 'SELECT count(*) n FROM discovery_runs WHERE campaign_id=?', [id]),
    enrollments: Object.fromEntries((await db.all('SELECT status, count(*) n FROM enrollments WHERE campaign_id=? GROUP BY status', [id])).map(r => [r.status, r.n])),
    series: {
      days,
      qualified: byDay(await db.all("SELECT created_at t FROM campaign_leads WHERE campaign_id=? AND decision='qualified' AND created_at>=?", [id, since])),
      sent: sentSeries,
    },
  };
}
export async function workspaceSummary(ctx) {
  const db = ctx.db, ws = ctx.ws, week = new Date(Date.now() - 7 * 864e5).toISOString();
  return {
    active_campaigns: await n(db, "SELECT count(*) n FROM campaigns WHERE workspace_id=? AND status='active'", [ws]),
    awaiting_review: await n(db, `SELECT count(*) n FROM campaign_leads l JOIN campaigns c ON c.id=l.campaign_id LEFT JOIN drafts d ON d.lead_id=l.id
      WHERE c.workspace_id=? AND c.status NOT IN ('stopped','deleted') AND l.selected=1 AND d.current_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.draft_id=d.id AND a.revision_id=d.current_revision_id AND a.invalidated_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM send_tasks st WHERE st.lead_id=l.id AND st.status='sent')`, [ws]),
    tasks_due: await n(db, "SELECT count(*) n FROM send_tasks st JOIN campaigns c ON c.id=st.campaign_id WHERE st.workspace_id=? AND c.status='active' AND st.status IN ('pending','held') AND st.due_at<=?", [ws, new Date().toISOString()]),
    replies_7d: await n(db, "SELECT count(DISTINCT e.contact_id) n FROM conversation_events e LEFT JOIN campaigns c ON c.id=e.campaign_id WHERE e.workspace_id=? AND e.type='reply' AND e.occurred_at>=? AND (e.campaign_id IS NULL OR c.status<>'deleted')", [ws, week]),
    contacts: await n(db, `SELECT count(*) n FROM contacts ct WHERE ct.workspace_id=? AND (EXISTS (SELECT 1 FROM campaign_leads l JOIN campaigns c ON c.id=l.campaign_id WHERE l.contact_id=ct.id AND c.status<>'deleted') OR EXISTS (SELECT 1 FROM campaign_contact_pool p JOIN campaigns c ON c.id=p.campaign_id WHERE p.contact_id=ct.id AND p.workspace_id=ct.workspace_id AND c.status<>'deleted') OR (NOT EXISTS (SELECT 1 FROM campaign_leads l WHERE l.contact_id=ct.id) AND NOT EXISTS (SELECT 1 FROM campaign_contact_pool p WHERE p.contact_id=ct.id AND p.workspace_id=ct.workspace_id)))`, [ws]),
    sending_stopped: !!(await db.get('SELECT sending_stopped FROM workspaces WHERE id=?', [ws])).sending_stopped,
    failed_jobs: await db.all("SELECT type, last_error, finished_at FROM jobs WHERE workspace_id=? AND status='dead' AND finished_at>=? ORDER BY finished_at DESC LIMIT 5", [ws, week]),
  };
}
export async function listEvents(ctx, { campaign_id, limit = 30, before } = {}) {
  if (campaign_id) await loadCampaign(ctx, campaign_id);
  const rows = await ctx.db.all(`SELECT id, campaign_id, type, summary, detail, actor, created_at, seq FROM audit_events WHERE workspace_id=:ws${campaign_id ? ' AND campaign_id=:cid' : ''}${before ? ' AND seq<:before' : ''} ORDER BY seq DESC LIMIT :lim`, { ws: ctx.ws, cid: campaign_id, before: before ? +before : null, lim: Math.min(100, +limit || 30) });
  return { items: rows.map(r => ({ ...r, detail: json(r.detail) })), next: rows.length ? rows.at(-1).seq : null };
}
export async function listContacts(ctx, { q, page = 0, page_size = 25 } = {}) {
  const where = ['ct.workspace_id=:ws'], p = { ws: ctx.ws };
  if (q) { where.push("lower(ct.first_name||' '||ct.last_name||' '||co.name||' '||coalesce(ct.email,'')) LIKE :q"); p.q = `%${String(q).toLowerCase()}%`; }
  const size = Math.min(100, +page_size || 25);
  const total = (await ctx.db.get(`SELECT count(*) n FROM contacts ct JOIN companies co ON co.id=ct.company_id WHERE ${where.join(' AND ')}`, p)).n;
  const items = await ctx.db.all(`SELECT ct.id, ct.first_name, ct.last_name, ct.role, ct.email, ct.email_status, ct.linkedin_url, ct.location, co.name company, co.industry, co.employees, s.reason suppressed,
      (SELECT string_agg(c.name, ' · ') FROM campaign_leads l JOIN campaigns c ON c.id=l.campaign_id WHERE l.contact_id=ct.id) campaigns,
      (SELECT count(*) FROM evidence e WHERE e.contact_id=ct.id) evidence_count,
      (SELECT type FROM conversation_events e WHERE e.contact_id=ct.id ORDER BY occurred_at DESC LIMIT 1) last_outcome
    FROM contacts ct JOIN companies co ON co.id=ct.company_id LEFT JOIN suppressions s ON s.workspace_id=ct.workspace_id AND s.email=ct.email
    WHERE ${where.join(' AND ')} ORDER BY ct.created_at DESC, ct.id LIMIT :lim OFFSET :off`, { ...p, lim: size, off: (+page || 0) * size });
  return { items, total };
}
export const listImports = async ctx => (await ctx.db.all('SELECT * FROM imports WHERE workspace_id=? ORDER BY created_at DESC LIMIT 20', [ctx.ws])).map(i => ({ ...i, rejected: json(i.rejected) }));
export const listSuppressions = async ctx => await ctx.db.all('SELECT * FROM suppressions WHERE workspace_id=? ORDER BY created_at DESC', [ctx.ws]);
