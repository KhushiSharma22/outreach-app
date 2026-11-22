// Campaign leads, drafts with immutable revisions, and revision-bound approvals.
import { id, now, hash } from './db.mjs';
import { AppError, notFound, conflict, invalid, json, localView } from './lib.mjs';
import { runAi, offlineProvider, checkDraft, checkFtpDraft, checkAttachmentReference } from './ai.mjs';
import { loadCampaign } from './campaigns.mjs';

// ---------- Leads ----------
const LEAD_SELECT = `SELECT l.*, ct.first_name, ct.last_name, ct.role, ct.seniority, ct.email, ct.email_status, ct.linkedin_url, ct.location, ct.company_id,
  co.name company, co.domain, co.industry, co.employees, co.location company_location, r.batch, s.reason suppressed, wslot.slot_date,
  d.id draft_id, d.current_revision_id,
  (SELECT 1 FROM approvals a JOIN draft_revisions dr ON dr.id=a.revision_id WHERE a.draft_id=d.id AND a.revision_id=d.current_revision_id AND a.invalidated_at IS NULL AND a.hash=dr.hash) approved,
  (SELECT st.status FROM send_tasks st WHERE st.lead_id=l.id AND st.kind='initial' ORDER BY st.created_at DESC LIMIT 1) send_status
  FROM campaign_leads l JOIN contacts ct ON ct.id=l.contact_id JOIN companies co ON co.id=ct.company_id JOIN discovery_runs r ON r.id=l.run_id
  JOIN campaigns c ON c.id=l.campaign_id LEFT JOIN suppressions s ON s.workspace_id=c.workspace_id AND s.email=ct.email LEFT JOIN drafts d ON d.lead_id=l.id LEFT JOIN weekly_slots wslot ON wslot.campaign_id=l.campaign_id AND wslot.contact_id=l.contact_id`;
export async function shapeLead(ctx, l, withEvidence = true) {
  return {
    id: l.id, campaign_id: l.campaign_id, contact_id: l.contact_id, run_id: l.run_id, batch: l.batch,
    name: `${l.first_name} ${l.last_name}`.trim(), first_name: l.first_name, role: l.role, seniority: l.seniority, email: l.email, email_status: l.email_status, linkedin_url: l.linkedin_url,
    company: l.company, domain: l.domain, industry: l.industry, employees: l.employees, location: l.location || l.company_location,
    decision: l.decision, score: l.score, rationale: l.rationale, checks: json(l.checks), missing: json(l.missing), confidence: l.confidence, assessed_by: l.assessed_by,
    slot_date: l.slot_date || null, selected: !!l.selected, override_by: l.override_by, override_reason: l.override_reason, suppressed: l.suppressed,
    draft_id: l.draft_id, approved: !!l.approved, send_status: l.send_status,
    evidence: withEvidence ? await ctx.db.all('SELECT id, signal, fact, source_url, event_date, collected_at, provenance FROM evidence WHERE workspace_id=? AND (contact_id=? OR (company_id=? AND contact_id IS NULL)) ORDER BY collected_at DESC LIMIT 20', [ctx.ws,l.contact_id,l.company_id]) : [],
  };
}
export async function listLeads(ctx, campaignId, { run_id, decision, q, page = 0, page_size = 7, selected } = {}) {
  await loadCampaign(ctx, campaignId);
  const where = ['l.campaign_id=:cid', 'c.workspace_id=:ws'], p = { cid: campaignId, ws: ctx.ws };
  if (run_id && run_id !== 'all') { where.push('l.run_id=:run'); p.run = run_id; }
  if (decision && decision !== 'all') { where.push('l.decision=:decision'); p.decision = decision; }
  if (selected) where.push('l.selected=1');
  if (q) { where.push("(lower(ct.first_name||' '||ct.last_name||' '||co.name) LIKE :q)"); p.q = `%${String(q).toLowerCase()}%`; }
  const base = `${LEAD_SELECT} WHERE ${where.join(' AND ')}`;
  const total = (await ctx.db.get(`SELECT count(*) n FROM (${base})`, p)).n;
  const size = Math.min(100, Math.max(1, +page_size || 7));
  const items = await Promise.all((await ctx.db.all(`${base} ORDER BY l.selected DESC, l.score DESC, l.id LIMIT :lim OFFSET :off`, { ...p, lim: size, off: Math.max(0, +page || 0) * size })).map(async l => await shapeLead(ctx, l)));
  const counts = Object.fromEntries((await ctx.db.all(`SELECT l.decision, count(*) n FROM campaign_leads l WHERE l.campaign_id=?${run_id && run_id !== 'all' ? ' AND l.run_id=?' : ''} GROUP BY l.decision`, run_id && run_id !== 'all' ? [campaignId, run_id] : [campaignId])).map(r => [r.decision, r.n]));
  const selectedCount = (await ctx.db.get('SELECT count(*) n FROM campaign_leads WHERE campaign_id=? AND selected=1', [campaignId])).n;
  return { items, total, page: +page || 0, page_size: size, counts, selected: selectedCount };
}
export async function getLead(ctx, leadId) {
  const l = await ctx.db.get(`${LEAD_SELECT} WHERE l.id=? AND c.workspace_id=?`, [leadId, ctx.ws]);
  if (!l) throw notFound('Lead');
  return l;
}
export async function updateLead(ctx, leadId, body) {
  const l = await getLead(ctx, leadId), c = await loadCampaign(ctx, l.campaign_id), t = now();
  await ctx.db.tx(async () => {
    if (body.decision === 'excluded') {
      await ctx.db.run("UPDATE campaign_leads SET decision='excluded', selected=0, override_by=?, override_reason=?, updated_at=? WHERE id=?", [ctx.user?.id, String(body.reason || 'Manually excluded from this campaign.').slice(0, 300), t, l.id]);
      await cancelLeadTasks(ctx, l.id, 'Lead excluded from campaign');
      await ctx.db.audit(ctx.ws, c.id, 'lead.excluded', `${l.first_name} ${l.last_name} excluded`, { lead_id: l.id }, ctx.user?.id);
    } else if (body.decision === 'qualified') {
      if (l.decision === 'qualified') return;
      if (l.decision !== 'review') throw conflict('not_reviewable', 'Excluded leads cannot be qualified. Hard exclusions and failed checks stay in force.');
      const checks = json(l.checks);
      if (checks.some(x => x.status === 'fail')) throw conflict('hard_check_failed', 'This lead failed a required check and cannot be approved.');
      if (!l.email) throw conflict('email_missing', 'Add an email address before qualifying this lead.');
      if (l.suppressed) throw conflict('suppressed', 'This address is suppressed.');
      if (!String(body.reason || '').trim()) throw invalid('Explain why you are qualifying this lead.', { reason: 'Required.' });
      await ctx.db.run("UPDATE campaign_leads SET decision='qualified', override_by=?, override_reason=?, updated_at=? WHERE id=?", [ctx.user?.id, String(body.reason).slice(0, 300), t, l.id]);
      await ctx.db.audit(ctx.ws, c.id, 'lead.qualified_manually', `${l.first_name} ${l.last_name} qualified after review`, { lead_id: l.id, reason: body.reason }, ctx.user?.id);
    }
    if ('selected' in body) {
      const cur = await ctx.db.get('SELECT decision FROM campaign_leads WHERE id=?', [l.id]);
      if (body.selected && cur.decision !== 'qualified') throw conflict('not_qualified', 'Only qualified leads can be selected.');
      if (!body.selected && l.send_status === 'sent') throw conflict('already_sent', 'This lead has already been emailed.');
      await ctx.db.run('UPDATE campaign_leads SET selected=?, updated_at=? WHERE id=?', [body.selected ? 1 : 0, t, l.id]);
      if (!body.selected) await cancelLeadTasks(ctx, l.id, 'Lead deselected');
    }
  });
  return await shapeLead(ctx, await getLead(ctx, l.id));
}
export async function selectLeads(ctx, campaignId, { lead_ids, selected }) {
  const c = await loadCampaign(ctx, campaignId);
  if (!Array.isArray(lead_ids)) throw invalid('lead_ids must be a list.');
  await ctx.db.tx(async () => {
    for (const lid of lead_ids) {
      const l = await ctx.db.get('SELECT * FROM campaign_leads WHERE id=? AND campaign_id=?', [lid, c.id]);
      if (!l || (selected && l.decision !== 'qualified')) continue;
      await ctx.db.run('UPDATE campaign_leads SET selected=?, updated_at=? WHERE id=?', [selected ? 1 : 0, now(), l.id]);
      if (!selected) await cancelLeadTasks(ctx, l.id, 'Lead deselected');
    }
  });
  return await listLeads(ctx, campaignId, { selected: true, page_size: 1 });
}
export async function cancelLeadTasks(ctx, leadId, reason) {
  await ctx.db.run("UPDATE send_tasks SET status='canceled', status_reason=?, updated_at=? WHERE lead_id=? AND status IN ('pending','held')", [reason, now(), leadId]);
}

// ---------- Drafts ----------
export async function startDraftRun(ctx, campaignId, { regenerate = false } = {}) {
  const c = await loadCampaign(ctx, campaignId);
  const open = await ctx.db.get("SELECT * FROM jobs WHERE workspace_id=? AND type='drafts' AND status IN ('queued','running') AND campaign_id=?", [ctx.ws, c.id]);
  if (open && !regenerate) return open;
  return await ctx.jobs.enqueue(ctx.ws, 'drafts', { campaign_id: c.id, regenerate: regenerate === 'all' ? 'all' : !!regenerate });
}
export async function executeDraftRun(ctx, { campaign_id, regenerate, batch_limit = 0, after_lead_id = null, at = Date.now() }) {
  const c = await loadCampaign(ctx, campaign_id);
  const leads = await ctx.db.all(`${LEAD_SELECT} WHERE l.campaign_id=? AND l.selected=1 AND l.decision='qualified' AND c.workspace_id=? AND (wslot.slot_date IS NULL OR wslot.slot_date<=?) ORDER BY l.id`, [c.id, ctx.ws, localView(at,c.config.schedule.timezone).date]);
  let made = 0, flagged = 0, remaining = false, lastLeadId = after_lead_id;
  for (const l of leads) {
    if (after_lead_id && l.id <= after_lead_id) continue;
    if (['sent','sending','unknown'].includes(l.send_status)) continue;
    const fresh = await ctx.db.get('SELECT d.current_revision_id, r.config_version, r.context_version_id FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id WHERE d.lead_id=?', [l.id]);
    if (fresh?.current_revision_id && !(regenerate && (fresh.config_version !== c.config_version || fresh.context_version_id !== c.context_version_id || regenerate === 'all'))) continue;
    if (batch_limit && made >= batch_limit) { remaining = true; break; }
    const lead = await shapeLead(ctx, l), evidence = lead.evidence;
    const files=fresh?.current_revision_id ? await ctx.db.all('SELECT a.filename FROM draft_revision_attachments ra JOIN attachments a ON a.id=ra.attachment_id WHERE ra.revision_id=?',[fresh.current_revision_id]) : await ctx.db.all('SELECT a.filename FROM campaign_attachment_defaults cd JOIN attachments a ON a.id=cd.attachment_id WHERE cd.campaign_id=?',[c.id]);
    let { out, provider, model, degraded } = await runAi(ctx.db, ctx.ws, 'draft', p => p.draftEmail({ context: c.context.data, config: c.config, lead, evidence, attachments:files.map(f=>f.filename) }));
    let problems = [...checkDraft(out, evidence, c.context.data.signature, [c.config.offer, c.context.data.proof]), ...checkFtpDraft(out, c.context.data, c.config),...checkAttachmentReference(out,files)];
    let note = degraded || out.review_note || null;
    if (problems.length && provider !== 'offline') {
      note = `AI draft failed checks (${problems.join(' ')}). A safe template was used instead.`;
      out = await offlineProvider.draftEmail({ context: c.context.data, config: c.config, lead, evidence });
      provider = 'offline'; model = null; problems = [];
    }
    if (note) flagged++;
    await saveRevision(ctx, c, l, { subject: out.subject.trim(), body: out.body.trim(), origin: fresh?.current_revision_id ? 'regenerated' : 'generated', generator: { provider, model }, evidence_ids: (out.evidence_ids || []).filter(x => evidence.some(e => e.id === x)), review_note: note, expected: fresh?.current_revision_id || null });
    made++; lastLeadId = l.id;
  }
  await ctx.db.audit(ctx.ws, c.id, 'drafts.generated', `${made} email draft${made === 1 ? '' : 's'} prepared${flagged ? `, ${flagged} flagged for review` : ''}`, { made, flagged });
  return { made, flagged, remaining, lastLeadId };
}
async function saveRevision(ctx, c, lead, { subject, body, origin, generator, evidence_ids, review_note, expected, attachmentIds }) {
  return await ctx.db.tx(async () => {
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
    let d = await ctx.db.get('SELECT * FROM drafts WHERE lead_id=?', [lead.id]);
    if (expected !== undefined && (d?.current_revision_id || null) !== expected) throw conflict('stale_revision','This draft changed since you loaded it. Reload to see the latest version.');
    if (d?.current_revision_id) await editable(ctx,d,d.current_revision_id);
    const existingIds = d?.current_revision_id ? await ctx.db.all('SELECT attachment_id FROM draft_revision_attachments WHERE revision_id=?',[d.current_revision_id]) : await ctx.db.all('SELECT attachment_id FROM campaign_attachment_defaults WHERE campaign_id=?',[c.id]);
    if (!d) { d = { id: id(), campaign_id: c.id, lead_id: lead.id, current_revision_id: null, created_at: now() }; await ctx.db.insert('drafts', d); }
    const rev = ((await ctx.db.get('SELECT max(rev) r FROM draft_revisions WHERE draft_id=?', [d.id])).r || 0) + 1;
    const r = { id: id(), draft_id: d.id, rev, subject, body, hash: hash(subject, body, lead.email), origin, generator: JSON.stringify(generator), evidence_ids: JSON.stringify(evidence_ids), review_note, context_version_id: c.context_version_id, config_version: c.config_version, created_by: ctx.user?.id || null, created_at: now() };
    await ctx.db.insert('draft_revisions', r);
    for(const attachmentId of (attachmentIds === undefined ? existingIds.map(x=>x.attachment_id) : attachmentIds)) await ctx.db.insert('draft_revision_attachments',{revision_id:r.id,attachment_id:attachmentId});
    await ctx.db.run('UPDATE drafts SET current_revision_id=? WHERE id=?', [r.id, d.id]);
    if(origin!=='attachment')await ctx.db.run('DELETE FROM draft_rewrite_required WHERE draft_id=?',[d.id]);
    const n = (await ctx.db.run("UPDATE approvals SET invalidated_at=?, invalidation_reason=? WHERE draft_id=? AND invalidated_at IS NULL", [now(), `Superseded by revision ${rev} (${origin})`, d.id])).changes;
    await cancelLeadTasks(ctx, lead.id, `Draft changed (${origin}) after approval; re-approval required`);
    if (n) await ctx.db.audit(ctx.ws, c.id, 'approval.invalidated', `Approval cleared for ${lead.first_name} ${lead.last_name}: ${origin}`, { draft_id: d.id }, ctx.user?.id);
    return r;
  });
}
async function shapeDraft(ctx, d) {
  const r = await ctx.db.get('SELECT * FROM draft_revisions WHERE id=?', [d.current_revision_id]);
  const appr = await ctx.db.get('SELECT * FROM approvals WHERE draft_id=? AND revision_id=? AND invalidated_at IS NULL AND hash=?', [d.id, r.id, r.hash]);
  const c = await ctx.db.get('SELECT config_version, context_version_id FROM campaigns WHERE id=?', [d.campaign_id]);
  const attachments=await ctx.db.all('SELECT a.id,a.filename,a.mime,a.size FROM draft_revision_attachments ra JOIN attachments a ON a.id=ra.attachment_id WHERE ra.revision_id=? AND a.workspace_id=?',[r.id,ctx.ws]);
  return { id: d.id, lead_id: d.lead_id, revision_id: r.id, rev: r.rev, subject: r.subject, body: r.body, origin: r.origin, generator: json(r.generator), evidence_ids: json(r.evidence_ids), attachments, review_note: r.review_note, approved: !!appr, approved_at: appr?.created_at || null, stale: r.config_version !== c.config_version || r.context_version_id !== c.context_version_id, created_at: r.created_at };
}
export async function listDrafts(ctx, campaignId) {
  const c = await loadCampaign(ctx, campaignId);
  const leads = await ctx.db.all(`${LEAD_SELECT} WHERE l.campaign_id=? AND l.selected=1 AND c.workspace_id=? AND (wslot.slot_date IS NULL OR wslot.slot_date<=?) ORDER BY l.score DESC, l.id`, [campaignId, ctx.ws, localView(Date.now(),c.config.schedule.timezone).date]);
  const revisions = await ctx.db.all(`SELECT d.id draft_id, d.lead_id, r.*, a.created_at approved_at FROM drafts d JOIN draft_revisions r ON r.id=d.current_revision_id LEFT JOIN approvals a ON a.id=(SELECT a2.id FROM approvals a2 WHERE a2.draft_id=d.id AND a2.revision_id=r.id AND a2.invalidated_at IS NULL AND a2.hash=r.hash ORDER BY a2.created_at DESC LIMIT 1) WHERE d.campaign_id=?`, [campaignId]);
  const evidence = await ctx.db.all(`SELECT l.id lead_id,e.id,e.signal,e.fact,e.source_url,e.event_date,e.collected_at,e.provenance FROM campaign_leads l JOIN contacts ct ON ct.id=l.contact_id JOIN evidence e ON e.workspace_id=ct.workspace_id AND (e.contact_id=ct.id OR (e.company_id=ct.company_id AND e.contact_id IS NULL)) WHERE l.campaign_id=? AND l.selected=1 AND ct.workspace_id=? ORDER BY e.collected_at DESC`, [campaignId,ctx.ws]);
  const byLead = new Map(); for (const e of evidence) {const {lead_id,...item}=e;const list=byLead.get(lead_id)||[];if(list.length<20)list.push(item);byLead.set(lead_id,list);}
  const byDraft = new Map(revisions.map(r=>[r.draft_id,r]));
  const files=await ctx.db.all('SELECT ra.revision_id,a.id,a.filename,a.mime,a.size FROM draft_revision_attachments ra JOIN attachments a ON a.id=ra.attachment_id JOIN draft_revisions r ON r.id=ra.revision_id JOIN drafts d ON d.id=r.draft_id WHERE d.campaign_id=? AND a.workspace_id=?',[campaignId,ctx.ws]);
  const byRevision=new Map();for(const {revision_id,...file} of files){const list=byRevision.get(revision_id)||[];list.push(file);byRevision.set(revision_id,list);}
  const items = await Promise.all(leads.map(async l => {
    const lead=await shapeLead(ctx,l,false);lead.evidence=byLead.get(l.id)||[];
    const r=byDraft.get(l.draft_id);
    const draft=r?{id:r.draft_id,lead_id:r.lead_id,revision_id:r.id,rev:r.rev,subject:r.subject,body:r.body,origin:r.origin,generator:json(r.generator),evidence_ids:json(r.evidence_ids),attachments:byRevision.get(r.id)||[],review_note:r.review_note,approved:!!r.approved_at,approved_at:r.approved_at||null,stale:r.config_version!==c.config_version||r.context_version_id!==c.context_version_id,created_at:r.created_at}:null;
    return {lead,draft};
  }));
  const pending = await ctx.db.get("SELECT status, last_error FROM jobs WHERE workspace_id=? AND type='drafts' AND campaign_id=? ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END, created_at DESC LIMIT 1", [ctx.ws, campaignId]);
  const future = await ctx.db.get("SELECT count(*) n FROM weekly_slots ws JOIN campaign_leads l ON l.campaign_id=ws.campaign_id AND l.contact_id=ws.contact_id WHERE ws.workspace_id=? AND ws.campaign_id=? AND ws.slot_date>? AND l.selected=1 AND l.decision='qualified'",[ctx.ws,campaignId,localView(Date.now(),c.config.schedule.timezone).date]);
  return { items, total: items.length, approved: items.filter(x => x.draft?.approved).length, scheduled_future:Number(future.n), job: pending || null };
}
async function loadDraft(ctx, draftId) {
  const d = await ctx.db.get('SELECT d.* FROM drafts d JOIN campaigns c ON c.id=d.campaign_id WHERE d.id=? AND c.workspace_id=?', [draftId, ctx.ws]);
  if (!d) throw notFound('Draft');
  return d;
}
export const getDraft = async (ctx, draftId) => await shapeDraft(ctx, await loadDraft(ctx, draftId));
async function editable(ctx, d, expected) {
  if (d.current_revision_id !== expected) throw conflict('stale_revision', 'This draft changed since you loaded it. Reload to see the latest version.', { draft: await shapeDraft(ctx, d) });
  if (await ctx.db.get("SELECT 1 FROM send_tasks WHERE lead_id=? AND kind='initial' AND status IN ('sent','sending','unknown')", [d.lead_id])) throw conflict('delivery_in_progress', 'This email was sent, is sending, or needs a mailbox check; its draft cannot be changed.');
}
export async function editDraft(ctx, draftId, { revision_id, subject, body }) {
  const d = await loadDraft(ctx, draftId);
  await editable(ctx, d, revision_id);
  const cur = await shapeDraft(ctx, d);
  subject = String(subject ?? cur.subject).trim(); body = String(body ?? cur.body).trim();
  if (!subject || !body) throw invalid('Add a subject and message.', { subject: !subject ? 'Required.' : undefined, body: !body ? 'Required.' : undefined });
  if (subject === cur.subject && body === cur.body) return cur;
  const c = await loadCampaign(ctx, d.campaign_id), lead = await getLead(ctx, d.lead_id);
  await saveRevision(ctx, c, lead, { subject, body, origin: 'edit', generator: { provider: 'user' }, evidence_ids: cur.evidence_ids, review_note: null, expected:revision_id });
  return await getDraft(ctx, d.id);
}
export async function rewriteDraft(ctx, draftId, { revision_id, style, instruction, writing, history=[] }) {
  if (!['human', 'short', 'direct','custom','preferences'].includes(style)) throw invalid('Choose a rewrite style.');
  if(style==='custom' && (typeof instruction!=='string'||!instruction.trim()||instruction.length>1000)) throw invalid('Enter an editing request of up to 1,000 characters.');
  if(!Array.isArray(history)||history.length>6||history.some(x=>typeof x!=='string'||x.length>1000))throw invalid('Editing history is invalid.');
  const choices={tone:['Conversational','Professional','Warm'],length:['Balanced','Concise'],angle:['Signal-led','Company-led'],cta:['Start a conversation','Book a meeting','Ask permission']};
  if(style==='preferences' && (!writing || Object.entries(writing).some(([key,value])=>!choices[key]?.includes(value)))) throw invalid('Choose valid writing preferences.');
  const d = await loadDraft(ctx, draftId);
  // Stop an already-approved email before the model call, which may take tens of seconds.
  // Even if the provider fails, the old version must be explicitly approved again.
  await ctx.db.tx(async()=>{
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
    await editable(ctx,await loadDraft(ctx,draftId),revision_id);
    const cleared=await ctx.db.run("UPDATE approvals SET invalidated_at=?,invalidation_reason=? WHERE draft_id=? AND invalidated_at IS NULL",[now(),'AI rewrite requested',d.id]);
    await cancelLeadTasks(ctx,d.lead_id,'AI rewrite requested; re-approval required');
    if(cleared.changes)await ctx.db.audit(ctx.ws,d.campaign_id,'approval.invalidated','Approval cleared while editing an email',{draft_id:d.id},ctx.user?.id);
  });
  const c = await loadCampaign(ctx, d.campaign_id), l = await getLead(ctx, d.lead_id), lead = await shapeLead(ctx, l), cur = await shapeDraft(ctx, d);
  const config=style==='preferences'?{...c.config,writing:{...c.config.writing,...writing}}:c.config;
  let { out, provider, model, degraded } = await runAi(ctx.db, ctx.ws, 'rewrite', p => {
    if((style==='custom'||style==='preferences') && p.name==='offline') throw new AppError(503,'ai_unavailable','AI editing is unavailable. Please try again when your AI provider is connected.');
    return p.rewriteEmail({ context: c.context.data, config, lead, draft: cur, evidence: lead.evidence, style, instruction, history, attachments:cur.attachments.map(a=>a.filename) });
  });
  let problems = [...checkDraft(out, lead.evidence, c.context.data.signature, [c.config.offer, c.context.data.proof]), ...checkFtpDraft(out, c.context.data, c.config),...checkAttachmentReference(out,cur.attachments)], note = degraded || null;
  if (problems.length && ['custom','preferences'].includes(style)) throw invalid(`AI rewrite could not be used: ${problems.join(' ')} Try a different request.`);
  if (problems.length && provider !== 'offline') { note = `AI rewrite failed checks (${problems.join(' ')}). A template rewrite was used.`; out = await offlineProvider.rewriteEmail({ context: c.context.data, config: c.config, lead, draft: cur, style }); provider = 'offline'; model = null; }
  await editable(ctx, await loadDraft(ctx, d.id), revision_id); // content may have changed while the model ran
  await saveRevision(ctx, c, l, { subject: out.subject.trim() || cur.subject, body: out.body.trim(), origin: `rewrite:${style}`, generator: { provider, model }, evidence_ids: (out.evidence_ids || []).filter(x => lead.evidence.some(e => e.id === x)), review_note: note, expected:revision_id });
  return await getDraft(ctx, d.id);
}

// Attachments are immutable snapshots of each approved revision. A campaign default is
// copied to future drafts; changing a file always creates a new, unapproved revision.
const MAX_ATTACHMENT_BYTES=3*1024*1024;
const MAX_ATTACHMENT_BASE64=4*Math.ceil(MAX_ATTACHMENT_BYTES/3);
export async function setAttachment(ctx,campaignId,{draft_id,revision_id,scope,file}) {
  if(!['one','all'].includes(scope)) throw invalid('Choose this email or all campaign emails.');
  const c=await loadCampaign(ctx,campaignId),selected=await loadDraft(ctx,draft_id);
  if(selected.campaign_id!==c.id) throw notFound('Draft');
  await editable(ctx,selected,revision_id);
  if(['stopped','deleted'].includes(c.status)) throw conflict('campaign_stopped','This campaign cannot be changed.');
  let data=null;
  if(file!==null){
    if(!file||typeof file.name!=='string'||typeof file.base64!=='string'||file.base64.length>MAX_ATTACHMENT_BASE64||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))throw invalid('Choose a PDF, PNG, JPEG or TXT file up to 3 MB.');
    const bytes=Buffer.from(file.base64,'base64'),name=file.name.trim();
    if(!name||name.length>180||/[\x00-\x1f\x7f/\\]/.test(name)||bytes.length===0||bytes.length>MAX_ATTACHMENT_BYTES||bytes.toString('base64')!==file.base64)throw invalid('Choose a valid file up to 3 MB.');
    let mime;
    if(/\.pdf$/i.test(name)&&bytes.subarray(0,5).toString()==='%PDF-')mime='application/pdf';
    else if(/\.png$/i.test(name)&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))mime='image/png';
    else if(/\.jpe?g$/i.test(name)&&bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))mime='image/jpeg';
    else if(/\.txt$/i.test(name)&&!bytes.includes(0))mime='text/plain';
    if(!mime)throw invalid('File content must match its PDF, PNG, JPEG or TXT extension.');
    data={id:id(),workspace_id:ctx.ws,filename:name,mime,size:bytes.length,content_base64:file.base64,created_at:now()};
  }
  let changed=0,skipped=0;
  await ctx.db.tx(async()=>{
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
    await editable(ctx,await loadDraft(ctx,draft_id),revision_id);
    if(data)await ctx.db.insert('attachments',data);
    if(scope==='all'){
      await ctx.db.run('DELETE FROM campaign_attachment_defaults WHERE campaign_id=?',[c.id]);
      if(data)await ctx.db.insert('campaign_attachment_defaults',{campaign_id:c.id,attachment_id:data.id});
    }
    const rows=scope==='one'?[selected]:await ctx.db.all('SELECT d.* FROM drafts d JOIN campaign_leads l ON l.id=d.lead_id WHERE d.campaign_id=? AND l.selected=1 AND l.decision=?',[c.id,'qualified']);
    for(const row of rows){
      if(await ctx.db.get("SELECT 1 FROM send_tasks WHERE lead_id=? AND kind='initial' AND status IN ('sent','sending','unknown')",[row.lead_id])){skipped++;continue;}
      const cur=await shapeDraft(ctx,row),lead=await getLead(ctx,row.lead_id);
      if(!data&&!cur.attachments.length)continue;
      const versions=await ctx.db.get('SELECT config_version,context_version_id FROM draft_revisions WHERE id=?',[row.current_revision_id]);
      await saveRevision(ctx,{...c,...versions},lead,{subject:cur.subject,body:cur.body,origin:'attachment',generator:cur.generator,evidence_ids:cur.evidence_ids,review_note:cur.review_note,expected:row.current_revision_id,attachmentIds:data?[data.id]:[]});changed++;
    }
    await ctx.db.audit(ctx.ws,c.id,'draft.attachments_updated','Email attachment settings updated',{scope,changed,skipped,filename:data?.filename||null},ctx.user?.id);
  });
  return {changed,skipped,draft:await getDraft(ctx,draft_id)};
}

// Approves exact revisions. Each item succeeds or fails independently.
export async function approveDrafts(ctx, { items, confirm }, onApproved) {
  if (!Array.isArray(items) || !items.length) throw invalid('Choose the drafts to approve.');
  if (items.length > 1 && confirm !== true) throw invalid('Confirm you reviewed these drafts.', { confirm: 'Required.' });
  const approveOne = async ({ draft_id, revision_id }) => {
    try {
      return await ctx.db.tx(async () => {
        await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
        const d = await loadDraft(ctx, draft_id);
        if (d.current_revision_id !== revision_id) return { draft_id, status: 'conflict', code: 'stale_revision', message: 'The draft changed after you reviewed it. Review the latest version.', current_revision_id: d.current_revision_id };
        if(await ctx.db.get('SELECT 1 FROM draft_rewrite_required WHERE draft_id=?',[d.id]))return {draft_id,status:'rejected',code:'rewrite_required',message:'Writing settings changed. Update this draft before approving it.'};
        const r = await ctx.db.get('SELECT * FROM draft_revisions WHERE id=?', [revision_id]);
        const l = await getLead(ctx, d.lead_id);
        if (!r.subject.trim() || !r.body.trim()) return { draft_id, status: 'rejected', code: 'empty', message: 'Subject and body are required.' };
        const attachment=await ctx.db.get('SELECT 1 FROM draft_revision_attachments WHERE revision_id=? LIMIT 1',[r.id]);
        if(checkAttachmentReference(r,attachment?[attachment]:[]).length) return {draft_id,status:'rejected',code:'attachment_missing',message:'This email mentions an attachment, but no file is attached.'};
        if (l.decision !== 'qualified' || !l.selected) return { draft_id, status: 'rejected', code: 'not_selected', message: 'This lead is no longer selected.' };
        if (!l.email || l.suppressed) return { draft_id, status: 'rejected', code: 'not_contactable', message: l.suppressed ? 'Recipient is suppressed.' : 'Recipient has no email address.' };
        if (r.hash !== hash(r.subject, r.body, l.email)) return { draft_id, status: 'conflict', code: 'recipient_changed', message: 'The recipient address changed. Regenerate or edit the draft.' };
        const existing = await ctx.db.get('SELECT * FROM approvals WHERE draft_id=? AND revision_id=? AND invalidated_at IS NULL', [d.id, r.id]);
        if (!existing) {
          await ctx.db.insert('approvals', { id: id(), draft_id: d.id, revision_id: r.id, hash: r.hash, actor: ctx.user?.id || 'system', via: items.length > 1 ? 'bulk' : 'individual', created_at: now(), invalidated_at: null, invalidation_reason: null });
          await ctx.db.audit(ctx.ws, d.campaign_id, 'draft.approved', `Email to ${l.first_name} ${l.last_name} approved (revision ${r.rev})`, { draft_id: d.id, revision_id: r.id }, ctx.user?.id);
        }
        await onApproved?.(d, r, l);
        return { draft_id, status: 'approved', revision_id: r.id };
      });
    } catch (e) {
      if (e instanceof AppError) return { draft_id, status: 'rejected', code: e.code, message: e.message };
      throw e;
    }
  };
  const results = [];
  for (const item of items) results.push(await approveOne(item));
  return results;
}
export async function validApproval(ctx, draftRevisionId) {
  return !!await ctx.db.get('SELECT 1 FROM approvals a JOIN drafts d ON d.id=a.draft_id JOIN draft_revisions r ON r.id=a.revision_id WHERE a.revision_id=? AND d.current_revision_id=a.revision_id AND a.invalidated_at IS NULL AND a.hash=r.hash', [draftRevisionId]);
}
