// Launch, campaign state, manual send tasks, outcomes, and suppression.
// Delivery is manual: the app prepares approved messages; the user sends them from their own
// mailbox and confirms. A confirmation is recorded as user-confirmed, never as provider-verified.
import { randomBytes } from 'node:crypto';
import { transport } from './mailbox.mjs';
import { id, now } from './db.mjs';
import { conflict, invalid, notFound, EMAIL_RE, normEmail, localView, zonedToUtc } from './lib.mjs';
import { loadCampaign, scheduleErrors } from './campaigns.mjs';
import { validApproval, cancelLeadTasks } from './drafts.mjs';
import { enrollOnSend, stopEnrollments, advanceEnrollment, holdOverdue, planFollowups } from './sequences.mjs';

export async function blockers(ctx, c) {
  const out = [], cfg = c.config;
  if (!c.name.trim() || !cfg.offer.trim()) out.push({ code: 'brief', message: 'Complete your campaign brief.' });
  if (!cfg.filters.roles.length && !cfg.filters.industries.length) out.push({ code: 'audience', message: 'Choose at least one job role or industry.' });
  const sel = await ctx.db.all(`SELECT l.id, ct.email, s.reason suppressed, d.current_revision_id,
    EXISTS (SELECT 1 FROM approvals a JOIN draft_revisions r ON r.id=a.revision_id WHERE a.draft_id=d.id AND a.revision_id=d.current_revision_id AND a.invalidated_at IS NULL AND a.hash=r.hash) approved FROM campaign_leads l JOIN contacts ct ON ct.id=l.contact_id
    LEFT JOIN suppressions s ON s.workspace_id=ct.workspace_id AND s.email=ct.email LEFT JOIN drafts d ON d.lead_id=l.id
    WHERE l.campaign_id=? AND l.selected=1 AND l.decision='qualified'`, [c.id]);
  if (!sel.length) out.push({ code: 'leads', message: 'Select at least one qualified prospect.' });
  const unapproved = sel.filter(l => !l.current_revision_id || !l.approved).length;
  if (unapproved) out.push({ code: 'approvals', message: `Approve every email (${unapproved} still need approval).` });
  const bad = sel.filter(l => !l.email || !EMAIL_RE.test(l.email) || l.suppressed).length;
  if (bad) out.push({ code: 'recipients', message: `${bad} selected recipient${bad > 1 ? 's are' : ' is'} missing a usable email or suppressed.` });
  if(cfg.delivery==='smtp'){
    if(!await ctx.db.get('SELECT 1 FROM mailboxes WHERE workspace_id=?',[ctx.ws]))out.push({code:'mailbox',message:'Connect your email before launching scheduled delivery.'});
    if(!ctx.publicUrl?.startsWith('https://'))out.push({code:'unsubscribe_url',message:'Configure a public HTTPS URL for unsubscribe links before launching scheduled delivery.'});
  }
  const se = scheduleErrors(cfg.schedule);
  if (se.length) out.push({ code: 'schedule', message: 'Choose a valid schedule. ' + se.join(' ') });
  if (!['daily','rules'].includes(cfg.approval)) out.push({ code: 'approval_mode', message: 'Choose an approval mode.' });
  if (cfg.approval === 'rules' && cfg.delivery !== 'smtp') out.push({ code: 'approval_mode', message: 'Automatic approval requires scheduled SMTP delivery.' });
  if ((await ctx.db.get('SELECT sending_stopped FROM workspaces WHERE id=?', [ctx.ws])).sending_stopped) out.push({ code: 'sending_stopped', message: 'Sending is stopped for this workspace.' });
  return out;
}

export function scheduledDue(config,at=Date.now()){
 const schedule=config.schedule,local=localView(at,schedule.timezone);
 for(let n=0;n<8;n++){
  const date=new Date(Date.parse(local.date+'T12:00:00Z')+n*864e5).toISOString().slice(0,10);
  const when=Date.parse(zonedToUtc(date,schedule.time,schedule.timezone)),view=localView(when,schedule.timezone);
  if(schedule.days.includes(view.weekday))return new Date(Math.max(at,when)).toISOString();
 }
 throw invalid('Select at least one sending day.');
}

async function createInitialTask(ctx, c, leadId, revisionId) {
  const r = await ctx.db.get('SELECT r.*, ct.email, ct.id contact_id FROM draft_revisions r JOIN drafts d ON d.id=r.draft_id JOIN campaign_leads l ON l.id=d.lead_id JOIN contacts ct ON ct.id=l.contact_id WHERE r.id=? AND l.id=?', [revisionId, leadId]);
  if (!r || await ctx.db.get("SELECT 1 FROM send_tasks WHERE lead_id=? AND kind='initial' AND status IN ('sent')", [leadId])) return null;
  const key = `init:${leadId}:${revisionId}`;
  const existing = await ctx.db.get('SELECT * FROM send_tasks WHERE workspace_id=? AND dedupe_key=?', [ctx.ws, key]);
  if (existing) {
    if (existing.status === 'canceled' && await validApproval(ctx, revisionId)) await ctx.db.run("UPDATE send_tasks SET status='pending', status_reason=NULL, updated_at=? WHERE id=?", [now(), existing.id]);
    return existing.id;
  }
  const t = now();
  await ctx.db.insert('send_tasks', { id: id(), workspace_id: ctx.ws, campaign_id: c.id, lead_id: leadId, contact_id: r.contact_id, kind: 'initial', draft_revision_id: r.id, enrollment_id: null, step_index: null, to_email: r.email, subject: r.subject, body: r.body, due_at: c.config.delivery==='smtp'?scheduledDue(c.config):t, status: 'pending', status_reason: null, dedupe_key: key, confirmed_at: null, confirmed_by: null, created_at: t, updated_at: t });
  return true;
}
// Called inside the approval transaction: approved content for a running campaign becomes a send task.
export function onDraftApproved(ctx) {
  return async (draft, revision) => {
    const c = await loadCampaign(ctx, draft.campaign_id);
    if (c.status === 'active' || c.status === 'paused') await createInitialTask(ctx, c, draft.lead_id, revision.id);
  };
}

export async function launch(ctx, campaignId, { revision, authorize_automatic = false }) {
  const c = await loadCampaign(ctx, campaignId);
  if (c.status !== 'draft') return { campaign: c, created: 0, already: true };
  if (c.config.approval === 'rules' && authorize_automatic !== true) throw invalid('Confirm automatic approval and scheduled SMTP delivery.');
  if (revision !== c.revision) throw conflict('stale_revision', 'This campaign changed since you reviewed it. Review the launch summary again.', { revision: c.revision });
  const b = await blockers(ctx, c);
  if (b.length) throw Object.assign(invalid(b.map(x => x.message).join(' ')), { fields: { blockers: b } });
  let created = 0;
  await ctx.db.tx(async () => {
    const t = now();
    await ctx.db.run("UPDATE campaigns SET status='active', step=5, launched_at=?, revision=revision+1, updated_at=? WHERE id=? AND status='draft'", [t, t, c.id]);
    for (const l of await ctx.db.all("SELECT l.id, d.current_revision_id FROM campaign_leads l JOIN drafts d ON d.lead_id=l.id WHERE l.campaign_id=? AND l.selected=1 AND l.decision='qualified'", [c.id])) {
      if (await createInitialTask(ctx, c, l.id, l.current_revision_id)) created++;
    }
    // The launch batch counts as today's occurrence so the scheduler does not run a second batch today.
    const today = localView(c.config.delivery==='smtp'?Date.parse(scheduledDue(c.config)):Date.now(), c.config.schedule.timezone).date;
    const latest = await ctx.db.get("SELECT id FROM discovery_runs WHERE campaign_id=? AND status='completed' ORDER BY batch DESC LIMIT 1", [c.id]);
    if (latest && !await ctx.db.get('SELECT 1 FROM discovery_runs WHERE campaign_id=? AND occurrence_date=?', [c.id, today])) await ctx.db.run('UPDATE discovery_runs SET occurrence_date=? WHERE id=?', [today, latest.id]);
    await ctx.db.audit(ctx.ws, c.id, 'campaign.launched', `Campaign launched; ${created} approved email${created === 1 ? '' : 's'} ready for ${c.config.delivery==='smtp'?'scheduled SMTP delivery':'manual sending'}`, { created }, ctx.user?.id);
  });
  return { campaign: await loadCampaign(ctx, c.id), created };
}
export async function setCampaignState(ctx, campaignId, action) {
  const c = await loadCampaign(ctx, campaignId), t = now();
  const to = { pause: ['active', 'paused'], resume: ['paused', 'active'], stop: [null, 'stopped'] }[action];
  if (!to) throw notFound('Action');
  if (c.status === to[1]) return await loadCampaign(ctx, c.id);
  if (action === 'stop' ? c.status === 'draft' : c.status !== to[0]) throw conflict('invalid_transition', `A ${c.status} campaign cannot ${action}.`);
  await ctx.db.tx(async () => {
    await ctx.db.run('UPDATE campaigns SET status=?, revision=revision+1, updated_at=? WHERE id=?', [to[1], t, c.id]);
    if (action === 'resume') await holdOverdue(ctx, c.id, 'Became overdue while the campaign was paused; review before sending.');
    if (action === 'stop') {
      await ctx.db.run("UPDATE send_tasks SET status='canceled', status_reason='Campaign stopped', updated_at=? WHERE campaign_id=? AND status IN ('pending','held')", [t, c.id]);
      await ctx.db.run("UPDATE enrollments SET status='stopped', stop_reason='Campaign stopped', updated_at=? WHERE campaign_id=? AND status='active'", [t, c.id]);
      await ctx.db.run("UPDATE sequences SET status='paused' WHERE campaign_id=? AND status='active'", [c.id]);
    }
    await ctx.db.audit(ctx.ws, c.id, `campaign.${to[1]}`, { pause: 'Campaign paused; no new work will be released', resume: 'Campaign resumed; overdue follow-ups held for review', stop: 'Campaign stopped; remaining work canceled' }[action], {}, ctx.user?.id);
  });
  if (action === 'resume') await planFollowups(ctx, c.id);
  return await loadCampaign(ctx, c.id);
}

// ---------- Send tasks ----------
function blockedReason(t) {
  if (t.status !== 'pending' && t.status !== 'held') return null;
  if (t.sending_stopped) return 'Sending is stopped for this workspace.';
  if (t.campaign_status !== 'active') return `Campaign is ${t.campaign_status}.`;
  if (t.email_status === 'invalid') return 'Recipient email is invalid.';
  if (t.suppressed) return `Recipient is suppressed (${t.suppressed}).`;
  if (t.kind === 'followup' && t.sequence_status !== 'active') return t.sequence_status === 'draft' ? 'Sequence is being edited.' : 'Sequence is paused.';
  if (t.kind === 'followup' && t.enrollment_status !== 'active') return 'Follow-ups stopped for this recipient.';
  return null;
}
const TASK_SELECT = `SELECT st.*, c.name campaign_name, c.status campaign_status, cv.data campaign_config, w.sending_stopped, ct.first_name, ct.last_name, ct.email_status, co.name company,
  s.reason suppressed, e.status enrollment_status, sq.status sequence_status, v.steps sequence_steps, m.sent_at, m.proof
  FROM send_tasks st JOIN campaigns c ON c.id=st.campaign_id JOIN campaign_config_versions cv ON cv.campaign_id=c.id AND cv.version=c.config_version JOIN workspaces w ON w.id=st.workspace_id JOIN contacts ct ON ct.id=st.contact_id JOIN companies co ON co.id=ct.company_id
  LEFT JOIN suppressions s ON s.workspace_id=st.workspace_id AND s.email=st.to_email LEFT JOIN enrollments e ON e.id=st.enrollment_id
  LEFT JOIN sequences sq ON sq.id=e.sequence_id LEFT JOIN sequence_versions v ON v.id=e.sequence_version_id LEFT JOIN messages m ON m.send_task_id=st.id`;
function shapeTask(t) {
  const blocked = blockedReason(t);
  return { id: t.id, campaign_id: t.campaign_id, campaign_name: t.campaign_name, delivery: JSON.parse(t.campaign_config).delivery || 'manual', lead_id: t.lead_id, contact_id: t.contact_id, kind: t.kind, step_index: t.step_index, day: t.sequence_steps && t.step_index != null ? JSON.parse(t.sequence_steps)[t.step_index]?.day : null,
    recipient: `${t.first_name} ${t.last_name}`.trim(), company: t.company, to_email: t.to_email, subject: t.subject, body: t.body, due_at: t.due_at,
    status: t.status, status_reason: t.status_reason, blocked_reason: blocked, due: t.status === 'pending' && !blocked && Date.parse(t.due_at) <= Date.now(),
    sent_at: t.sent_at, proof: t.proof, confirmed_by: t.confirmed_by };
}
export async function listTasks(ctx, { campaign_id, status = 'open', page = 0, page_size = 50 } = {}) {
  const where = ['st.workspace_id=:ws'], p = { ws: ctx.ws };
  if (campaign_id) { where.push('st.campaign_id=:cid'); p.cid = campaign_id; }
  if (status === 'open') where.push("st.status IN ('pending','held')");
  else if (status !== 'all') { where.push('st.status=:st'); p.st = status; }
  const size = Math.min(200, Math.max(1, +page_size || 50));
  const total = (await ctx.db.get(`SELECT count(*) n FROM send_tasks st WHERE ${where.join(' AND ')}`, p)).n;
  const items = (await ctx.db.all(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE st.status WHEN 'held' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, st.due_at, st.id LIMIT :lim OFFSET :off`, { ...p, lim: size, off: (+page || 0) * size })).map(shapeTask);
  const counts = Object.fromEntries((await ctx.db.all(`SELECT st.status, count(*) n FROM send_tasks st WHERE st.workspace_id=:ws${campaign_id ? ' AND st.campaign_id=:cid' : ''} GROUP BY st.status`, p)).map(r => [r.status, r.n]));
  return { items, total, counts };
}
async function loadTask(ctx, taskId) {
  const t = await ctx.db.get(`${TASK_SELECT} WHERE st.id=? AND st.workspace_id=?`, [taskId, ctx.ws]);
  if (!t) throw notFound('Send task');
  return t;
}
export async function confirmSent(ctx, taskId, { sent_at } = {}) {
  const t = await loadTask(ctx, taskId);
  if (t.kind === 'initial' && JSON.parse(t.campaign_config).delivery === 'smtp') throw conflict('automatic_delivery', 'This campaign sends initial emails through scheduled SMTP.');
  if (t.status === 'sent') return shapeTask(t); // idempotent
  if (t.status === 'held') throw conflict('held', 'Review and release this overdue follow-up before sending it.');
  if (t.status !== 'pending') throw conflict('not_pending', `This task is ${t.status}${t.status_reason ? ': ' + t.status_reason : ''}.`);
  const blocked = blockedReason(t);
  if (blocked) throw conflict('blocked', blocked);
  if (t.kind === 'initial' && !await validApproval(ctx, t.draft_revision_id)) throw conflict('approval_invalid', 'This email’s approval no longer matches its content.');
  const sentAt = sent_at ? new Date(sent_at) : new Date();
  if (isNaN(sentAt)) throw invalid('Enter a valid send time.');
  if (sentAt.getTime() > Date.now() + 5 * 60e3) throw invalid('The send time cannot be in the future.');
  if (sentAt.getTime() < Date.parse(t.created_at) - 60e3) throw invalid('The send time is earlier than when this task was created.');
  const iso = sentAt.toISOString();
  await ctx.db.tx(async () => {
    const changed = (await ctx.db.run("UPDATE send_tasks SET status='sent', confirmed_at=?, confirmed_by=?, updated_at=? WHERE id=? AND status='pending'", [now(), ctx.user?.id, now(), t.id])).changes;
    if (!changed) return;
    await ctx.db.insert('messages', { id: id(), workspace_id: ctx.ws, campaign_id: t.campaign_id, send_task_id: t.id, contact_id: t.contact_id, to_email: t.to_email, subject: t.subject, body: t.body, sent_at: iso, proof: 'user_confirmed', recorded_by: ctx.user?.id || 'system', created_at: now() });
    await ctx.db.audit(ctx.ws, t.campaign_id, 'message.confirmed_sent', `${t.kind === 'initial' ? 'Initial email' : `Follow-up ${t.step_index + 1}`} to ${t.first_name} ${t.last_name} confirmed sent (manual)`, { task_id: t.id }, ctx.user?.id);
    if (t.kind === 'initial') await enrollOnSend(ctx, t.campaign_id, t.lead_id);
    else await advanceEnrollment(ctx, t.enrollment_id, t.step_index);
  });
  return shapeTask(await loadTask(ctx, t.id));
}
export async function skipTask(ctx, taskId, { reason } = {}) {
  const t = await loadTask(ctx, taskId);
  if (!['pending', 'held'].includes(t.status)) throw conflict('not_open', `This task is ${t.status}.`);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE send_tasks SET status='skipped', status_reason=?, updated_at=? WHERE id=?", [String(reason || 'Skipped by user').slice(0, 300), now(), t.id]);
    await ctx.db.audit(ctx.ws, t.campaign_id, 'task.skipped', `Send task for ${t.first_name} ${t.last_name} skipped`, { task_id: t.id }, ctx.user?.id);
    if (t.kind === 'followup') await advanceEnrollment(ctx, t.enrollment_id, t.step_index);
  });
  return shapeTask(await loadTask(ctx, t.id));
}
export async function releaseTask(ctx, taskId) {
  const t = await loadTask(ctx, taskId);
  if (t.status !== 'held') throw conflict('not_held', 'Only held follow-ups can be released.');
  await ctx.db.run("UPDATE send_tasks SET status='pending', status_reason='Released after review', due_at=?, updated_at=? WHERE id=?", [now(), now(), t.id]);
  await ctx.db.audit(ctx.ws, t.campaign_id, 'task.released', `Overdue follow-up for ${t.first_name} ${t.last_name} released`, { task_id: t.id }, ctx.user?.id);
  return shapeTask(await loadTask(ctx, t.id));
}

// ---------- Outcomes and suppression ----------
const EVENT_TYPES = { reply: 'Reply recorded', bounce: 'Bounce recorded', opt_out: 'Opt-out recorded', meeting: 'Meeting booked' };
export async function recordOutcome(ctx, contactId, { type, campaign_id = null, note = '', occurred_at }) {
  if (!EVENT_TYPES[type]) throw invalid('Choose reply, bounce, opt-out, or meeting.');
  const ct = await ctx.db.get('SELECT * FROM contacts WHERE id=? AND workspace_id=?', [contactId, ctx.ws]);
  if (!ct) throw notFound('Contact');
  if (campaign_id) await loadCampaign(ctx, campaign_id);
  const at = occurred_at ? new Date(occurred_at) : new Date();
  if (isNaN(at) || at.getTime() > Date.now() + 5 * 60e3) throw invalid('Enter a valid time that is not in the future.');
  let stopped = 0;
  await ctx.db.tx(async () => {
    await ctx.db.insert('conversation_events', { id: id(), workspace_id: ctx.ws, contact_id: ct.id, campaign_id, type, note: String(note).slice(0, 2000), source: 'manual', actor: ctx.user?.id, occurred_at: at.toISOString(), created_at: now() });
    stopped = await stopEnrollments(ctx, ct.id, { reply: 'reply received', bounce: 'email bounced', opt_out: 'recipient opted out', meeting: 'meeting booked' }[type]);
    if ((type === 'opt_out' || type === 'bounce') && ct.email) {
      await addSuppression(ctx, { email: ct.email, reason: type, contact_id: ct.id, note });
      for (const l of await ctx.db.all('SELECT DISTINCT lead_id FROM send_tasks WHERE contact_id=? AND status IN (\'pending\',\'held\')', [ct.id])) await cancelLeadTasks(ctx, l.lead_id, type === 'opt_out' ? 'Recipient opted out' : 'Email bounced');
      if (type === 'bounce') await ctx.db.run("UPDATE contacts SET email_status='invalid', email_verifier='bounce', email_checked_at=? WHERE id=?", [now(), ct.id]);
    }
    await ctx.db.audit(ctx.ws, campaign_id, `outcome.${type}`, `${EVENT_TYPES[type]} for ${ct.first_name} ${ct.last_name} (manual)${stopped ? '; follow-ups stopped' : ''}`, { contact_id: ct.id }, ctx.user?.id);
  });
  return { type, stopped_enrollments: stopped };
}
export async function addSuppression(ctx, { email, reason = 'manual', contact_id = null, note = '' }) {
  email = normEmail(email);
  if (!email || !EMAIL_RE.test(email)) throw invalid('Enter a valid email address.');
  if (!['manual', 'opt_out', 'bounce'].includes(reason)) throw invalid('Unknown suppression reason.');
  return ctx.db.tx(async()=>{
    await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
    let row=await ctx.db.get('SELECT * FROM suppressions WHERE workspace_id=? AND email=?',[ctx.ws,email]);
    const ct=(await ctx.db.get('SELECT id FROM contacts WHERE workspace_id=? AND email=?',[ctx.ws,email]))?.id||null;
    if(row){if(reason==='opt_out'&&row.reason!=='opt_out'){await ctx.db.run("UPDATE suppressions SET reason='opt_out' WHERE id=?",[row.id]);row={...row,reason:'opt_out'};}}
    else{row={id:id(),workspace_id:ctx.ws,email,contact_id:ct,reason,note:String(note).slice(0,500),actor:ctx.user?.id,created_at:now()};await ctx.db.insert('suppressions',row);await ctx.db.audit(ctx.ws,null,'suppression.added',`${email} suppressed (${reason})`,{},ctx.user?.id);}
    if(ct)await stopEnrollments(ctx,ct,'suppressed');
    await ctx.db.run("UPDATE send_tasks SET status='canceled',status_reason='Recipient suppressed',updated_at=? WHERE workspace_id=? AND to_email=? AND status IN ('pending','held')",[now(),ctx.ws,email]);
    return row;
  });
}

export async function removeSuppression(ctx, suppressionId) {
  const s = await ctx.db.get('SELECT * FROM suppressions WHERE id=? AND workspace_id=?', [suppressionId, ctx.ws]);
  if (!s) throw notFound('Suppression');
  if (s.reason !== 'manual') throw conflict('not_removable', 'Opt-outs and bounces stay suppressed. Only manual suppressions can be removed.');
  await ctx.db.run('DELETE FROM suppressions WHERE id=?', [s.id]);
  await ctx.db.audit(ctx.ws, null, 'suppression.removed', `${s.email} removed from manual suppression`, {}, ctx.user?.id);
  return { removed: true };
}
export async function setSendingStopped(ctx, stopped) {
  await ctx.db.run('UPDATE workspaces SET sending_stopped=? WHERE id=?', [stopped ? 1 : 0, ctx.ws]);
  await ctx.db.audit(ctx.ws, null, stopped ? 'workspace.sending_stopped' : 'workspace.sending_resumed', stopped ? 'All sending stopped for the workspace' : 'Sending re-enabled for the workspace', {}, ctx.user?.id);
  return { sending_stopped: !!stopped };
}

export async function smtpSend(ctx, taskId, publicUrl, {no_reply_confirmed=false,automatic=false} = {}, makeTransport=transport) {
 if (!publicUrl.startsWith('https://')) throw invalid('A public HTTPS URL is required for unsubscribe links.');
 const {row,client}=await makeTransport(ctx);
 let t, token;
 try {await ctx.db.tx(async()=>{
  await ctx.db.run('UPDATE workspaces SET name=name WHERE id=?',[ctx.ws]);
  t=await loadTask(ctx,taskId);
  if(t.kind==='followup' && no_reply_confirmed!==true) throw invalid('Check your inbox and confirm no reply or opt-out before this follow-up.');
  if(t.status!=='pending'||blockedReason(t)||Date.parse(t.due_at)>Date.now()) throw conflict('blocked','This task is not eligible for sending.');
  const campaign=await loadCampaign(ctx,t.campaign_id);
  if(automatic && (campaign.config.delivery!=='smtp'||!campaign.config.schedule.days.includes(localView(Date.now(),campaign.config.schedule.timezone).weekday)||localView(Date.now(),campaign.config.schedule.timezone).time<campaign.config.schedule.time))throw conflict('schedule_closed','Outside the campaign sending schedule.');
  if(t.kind==='initial'){
   const local=localView(Date.now(),campaign.config.schedule.timezone);const start=new Date(zonedToUtc(local.date,'00:00',campaign.config.schedule.timezone)).toISOString();
   const sent=await ctx.db.get("SELECT count(*) n FROM send_tasks WHERE campaign_id=? AND kind='initial' AND status IN ('sending','sent','unknown') AND updated_at>=?",[t.campaign_id,start]);
   if(Number(sent.n)>=campaign.config.target)throw conflict('campaign_send_limit','Campaign daily sending target reached.');
  }
  if(t.kind==='initial'&&!await validApproval(ctx,t.draft_revision_id)) throw conflict('approval_invalid','Review and approve this message again.');
  const n=await ctx.db.get("SELECT count(*) n FROM send_tasks WHERE workspace_id=? AND status IN ('sending','sent','unknown') AND updated_at>=?",[ctx.ws,now().slice(0,10)]);
  if(Number(n.n)>=30) throw conflict('daily_send_limit','Daily safety cap reached: 30 emails including follow-ups (UTC).');
  const previous=await ctx.db.get('SELECT token FROM optout_tokens WHERE workspace_id=? AND email=?',[ctx.ws,t.to_email]);
  token=previous?.token||randomBytes(32).toString('hex');
  if(!previous) await ctx.db.insert('optout_tokens',{token,workspace_id:ctx.ws,email:t.to_email});
  await ctx.db.run("UPDATE send_tasks SET status='sending',updated_at=? WHERE id=?",[now(),t.id]);
 });} catch(e){client.close();throw e;}
 const url=publicUrl+'/unsubscribe/'+token;
 const body=t.body+'\n\nBusiness marketing message\n'+row.postal_address+'\nUnsubscribe: '+url;
 try {
  // Last check before handing the message to the provider.
  const current=await loadTask(ctx,t.id);
  if(blockedReason({...current,status:'pending'}) || (t.kind==='initial'&&!await validApproval(ctx,t.draft_revision_id))) throw new Error('Eligibility changed before dispatch');
  await client.sendMail({from:row.sender,to:t.to_email,subject:t.subject,text:body,disableFileAccess:true,disableUrlAccess:true});
 } catch {
  await ctx.db.run("UPDATE send_tasks SET status='unknown', status_reason='SMTP outcome uncertain. Review mailbox before any retry.',updated_at=? WHERE id=?",[now(),t.id]);
  throw conflict('send_uncertain','Sending could not be confirmed. Check the mailbox; this task will not retry automatically.');
 } finally {client.close();}
 await ctx.db.tx(async()=>{
  await ctx.db.run("UPDATE send_tasks SET status='sent',confirmed_at=?,updated_at=? WHERE id=?",[now(),now(),t.id]);
  await ctx.db.insert('messages',{id:id(),workspace_id:ctx.ws,campaign_id:t.campaign_id,send_task_id:t.id,contact_id:t.contact_id,to_email:t.to_email,subject:t.subject,body,sent_at:now(),proof:'smtp_accepted',recorded_by:ctx.user?.id||'system',created_at:now()});
  if(t.kind==='initial') await enrollOnSend(ctx,t.campaign_id,t.lead_id); else await advanceEnrollment(ctx,t.enrollment_id,t.step_index);
 });
 return shapeTask(await loadTask(ctx,t.id));
}

// Called by the scheduler. Exact draft approval and suppression are checked again by smtpSend.
// Unknown SMTP outcomes are never automatically retried. Follow-ups require a human inbox check.
export async function dispatchApproved(ctx,campaignId,at=Date.now(),send=smtpSend){
 const c=await loadCampaign(ctx,campaignId),s=c.config.schedule,local=localView(at,s.timezone);
 if(c.status!=='active'||c.config.delivery!=='smtp'||!s.days.includes(local.weekday)||local.time<s.time)return;
 const tasks=await ctx.db.all("SELECT id FROM send_tasks WHERE workspace_id=? AND campaign_id=? AND kind='initial' AND status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 30",[ctx.ws,c.id,new Date(at).toISOString()]);
 for(const task of tasks){
  try{await send(ctx,task.id,ctx.publicUrl,{automatic:true});}
  catch(e){
   if(['daily_send_limit','campaign_send_limit','schedule_closed'].includes(e.code))break;
   if(['blocked','approval_invalid'].includes(e.code))continue;
   await ctx.db.audit(ctx.ws,c.id,'delivery.error','Scheduled email could not be sent',{task_id:task.id,code:e.code||'delivery_error'});
   break;
  }
 }
}
