// Follow-up sequences: editable working copy with per-step approvals, immutable launched
// versions, recipient enrollments anchored on each recipient's own initial send, and durable
// step executions (send tasks, unique per enrollment and step).
import { id, now, hash } from './db.mjs';
import { notFound, conflict, invalid, json, localView, addDays, weekdayOf, zonedToUtc } from './lib.mjs';
import { loadCampaign } from './campaigns.mjs';

export const MERGE_FIELDS = ['first_name', 'company'];
const TITLES = ['Gentle reminder', 'Add value', 'Find the right moment', 'Close the loop'];
const HOLD_AFTER_MS = 60 * 60 * 1000; // steps more than an hour overdue are held for review, never burst

function defaultSteps(c) {
  const sig = c.context.data.signature, offer = c.config.offer;
  const bodies = [
    `Hi {{first_name}},\n\nFollowing up on my note about {{company}}. ${offer}\n\nIs this a priority for your team right now?\n\n${sig}`,
    `Hi {{first_name}},\n\nA useful place to start is looking at how your team currently handles prospect research and outreach.\n\nWould it help if I shared a short overview of how we approach this for teams like {{company}}?\n\n${sig}`,
    `Hi {{first_name}},\n\nI know priorities move quickly. Is there someone else at {{company}} who owns this area, or would another time be better?\n\n${sig}`,
    `Hi {{first_name}},\n\nI’ll close the loop for now. If this becomes relevant for {{company}}, I’d be happy to pick up the conversation.\n\nThanks for your time,\n${sig}`,
  ];
  return [1, 3, 5, 7].map((day, i) => ({ day, title: TITLES[i], subject: i === 0 ? 'Re: A thought for {{company}}' : i === 3 ? 'Closing the loop' : 'A quick follow-up for {{company}}', body: bodies[i] }));
}
const stepHash = s => hash(s.day, s.subject, s.body);

export function sequenceErrors(steps) {
  const errors = [];
  if (!Array.isArray(steps) || !steps.length) return ['Add at least one follow-up.'];
  if (steps.length > 8) errors.push('Use at most eight follow-ups.');
  steps.forEach((x, i) => {
    if (!Number.isInteger(x.day) || x.day < 1 || x.day > 90 || (i && x.day <= steps[i - 1].day)) errors.push('Use increasing, unique days between 1 and 90.');
    if (!String(x.subject || '').trim() || !String(x.body || '').trim()) errors.push('Each email needs a subject and body.');
    if (String(x.subject).length > 140 || String(x.body).length > 3000) errors.push('Keep subjects under 140 and bodies under 3,000 characters.');
    const leftover = String(x.subject + x.body).replace(/\{\{\s*(first_name|company)\s*\}\}/g, '');
    if (/\{\{|\}\}/.test(leftover)) errors.push('Use only the supported personalization fields: {{first_name}} and {{company}}.');
  });
  return [...new Set(errors)];
}
export const render = (text, contact) => text.replace(/\{\{\s*first_name\s*\}\}/g, contact.first_name).replace(/\{\{\s*company\s*\}\}/g, contact.company);

async function loadSequenceRow(ctx, sequenceId) {
  const s = await ctx.db.get('SELECT s.* FROM sequences s JOIN campaigns c ON c.id=s.campaign_id WHERE s.id=? AND c.workspace_id=?', [sequenceId, ctx.ws]);
  if (!s) throw notFound('Sequence');
  return s;
}
export async function getSequence(ctx, campaignId) {
  const c = await loadCampaign(ctx, campaignId);
  let s = await ctx.db.get('SELECT * FROM sequences WHERE campaign_id=?', [c.id]);
  if (!s) {
    s = { id: id(), campaign_id: c.id, status: 'draft', steps: JSON.stringify(defaultSteps(c)), revision: 1, current_version_id: null, created_at: now(), updated_at: now() };
    await ctx.db.insert('sequences', s);
  }
  return await shapeSequence(ctx, s);
}
async function shapeSequence(ctx, s) {
  const steps = json(s.steps);
  const approvals = await ctx.db.all('SELECT step_index, hash FROM sequence_step_approvals WHERE sequence_id=?', [s.id]);
  const versions = await ctx.db.all('SELECT id, version, created_at FROM sequence_versions WHERE sequence_id=? ORDER BY version DESC', [s.id]);
  const enroll = Object.fromEntries((await ctx.db.all('SELECT status, count(*) n FROM enrollments WHERE sequence_id=? GROUP BY status', [s.id])).map(r => [r.status, r.n]));
  const tasks = Object.fromEntries((await ctx.db.all("SELECT st.status, count(*) n FROM send_tasks st JOIN enrollments e ON e.id=st.enrollment_id WHERE e.sequence_id=? GROUP BY st.status", [s.id])).map(r => [r.status, r.n]));
  return {
    id: s.id, campaign_id: s.campaign_id, status: s.status, revision: s.revision, current_version: versions[0] || null, versions,
    steps: steps.map((x, i) => ({ ...x, title: x.title || TITLES[i] || 'Follow-up email', approved: approvals.some(a => a.step_index === i && a.hash === stepHash(x)) })),
    errors: sequenceErrors(steps), enrollments: enroll, tasks,
  };
}
export async function updateSequence(ctx, sequenceId, { revision, steps }) {
  const s = await loadSequenceRow(ctx, sequenceId);
  if (s.status !== 'draft') throw conflict('sequence_locked', 'Choose “Edit sequence” before changing a launched sequence.');
  if (revision !== s.revision) throw conflict('stale_revision', 'This sequence changed since you loaded it.', { sequence: await shapeSequence(ctx, s) });
  if (!Array.isArray(steps) || steps.length > 8 || !steps.length) throw invalid('A sequence has between one and eight follow-ups.');
  const clean = steps.map((x, i) => ({ day: Number(x.day), title: String(x.title || TITLES[i] || 'Follow-up email').slice(0, 60), subject: String(x.subject ?? ''), body: String(x.body ?? '') }));
  await ctx.db.run('UPDATE sequences SET steps=?, revision=revision+1, updated_at=? WHERE id=?', [JSON.stringify(clean), now(), s.id]);
  return await shapeSequence(ctx, await loadSequenceRow(ctx, s.id));
}
export async function approveSteps(ctx, sequenceId, { revision, steps: indexes, confirm }) {
  const s = await loadSequenceRow(ctx, sequenceId);
  if (s.status !== 'draft') throw conflict('sequence_locked', 'This sequence is already launched.');
  if (revision !== s.revision) throw conflict('stale_revision', 'This sequence changed since you reviewed it.', { sequence: await shapeSequence(ctx, s) });
  const steps = json(s.steps), errors = sequenceErrors(steps);
  if (errors.length) throw invalid(errors[0], { steps: errors });
  const list = indexes === 'all' ? steps.map((_, i) => i) : indexes;
  if (!Array.isArray(list) || !list.length || list.some(i => !steps[i])) throw invalid('Choose the follow-ups to approve.');
  if (list.length > 1 && confirm !== true) throw invalid('Confirm you reviewed every follow-up and its timing.');
  await ctx.db.tx(async () => {
    for (const i of list) {
      await ctx.db.run('DELETE FROM sequence_step_approvals WHERE sequence_id=? AND step_index=?', [s.id, i]);
      await ctx.db.insert('sequence_step_approvals', { id: id(), sequence_id: s.id, step_index: i, hash: stepHash(steps[i]), actor: ctx.user?.id || 'system', created_at: now() });
    }
    await ctx.db.audit(ctx.ws, s.campaign_id, 'sequence.approved', `${list.length} follow-up${list.length > 1 ? 's' : ''} approved`, { steps: list }, ctx.user?.id);
  });
  return await shapeSequence(ctx, s);
}
// Existing enrollments stay pinned to the version they started with; relaunching applies the
// new version only to recipients enrolled afterwards.
export async function launchSequence(ctx, sequenceId, { revision }) {
  const s = await loadSequenceRow(ctx, sequenceId), c = await loadCampaign(ctx, s.campaign_id);
  if (s.status === 'active') return await shapeSequence(ctx, s);
  if (revision !== s.revision) throw conflict('stale_revision', 'This sequence changed since you reviewed it.');
  if (c.status !== 'active') throw conflict('campaign_not_active', c.status === 'paused' ? 'Resume the initial campaign before launching its sequence.' : 'Launch the initial campaign first.');
  const shaped = await shapeSequence(ctx, s);
  if (shaped.errors.length) throw invalid(shaped.errors[0]);
  if (s.status === 'draft' && !shaped.steps.every(x => x.approved)) throw conflict('approval_required', 'Review and approve every follow-up first.');
  await ctx.db.tx(async () => {
    if (s.status === 'draft') {
      const last = await ctx.db.get('SELECT * FROM sequence_versions WHERE id=?', [s.current_version_id]);
      if (!last || last.steps !== s.steps) {
        const v = { id: id(), sequence_id: s.id, version: (last?.version || 0) + 1, steps: s.steps, approved_by: ctx.user?.id || 'system', created_at: now() };
        await ctx.db.insert('sequence_versions', v);
        await ctx.db.run('UPDATE sequences SET current_version_id=? WHERE id=?', [v.id, s.id]);
      }
    }
    await ctx.db.run("UPDATE sequences SET status='active', revision=revision+1, updated_at=? WHERE id=?", [now(), s.id]);
    const n = await enrollExisting(ctx, c, s.id);
    await ctx.db.audit(ctx.ws, c.id, 'sequence.launched', `Follow-up sequence launched; ${n} existing recipient${n === 1 ? '' : 's'} enrolled`, { steps: shaped.steps.map(x => x.day) }, ctx.user?.id);
  });
  await planFollowups(ctx, c.id);
  return await shapeSequence(ctx, await loadSequenceRow(ctx, s.id));
}
export async function setSequenceState(ctx, sequenceId, action) {
  const s = await loadSequenceRow(ctx, sequenceId), t = now();
  if (action === 'pause') {
    if (s.status !== 'active') throw conflict('not_active', 'Only an active sequence can be paused.');
    await ctx.db.run("UPDATE sequences SET status='paused', revision=revision+1, updated_at=? WHERE id=?", [t, s.id]);
    await ctx.db.audit(ctx.ws, s.campaign_id, 'sequence.paused', 'Follow-up sequence paused', {}, ctx.user?.id);
  } else if (action === 'resume') {
    if (s.status !== 'paused') throw conflict('not_paused', 'Only a paused sequence can be resumed.');
    const c = await loadCampaign(ctx, s.campaign_id);
    if (c.status !== 'active') throw conflict('campaign_not_active', 'Resume the campaign first.');
    await ctx.db.tx(async () => {
      await ctx.db.run("UPDATE sequences SET status='active', revision=revision+1, updated_at=? WHERE id=?", [t, s.id]);
      await holdOverdue(ctx, s.campaign_id, 'Became overdue while paused; review before sending.');
      await ctx.db.audit(ctx.ws, s.campaign_id, 'sequence.resumed', 'Follow-up sequence resumed; overdue steps held for review', {}, ctx.user?.id);
    });
    await planFollowups(ctx, s.campaign_id);
  } else if (action === 'edit') {
    if (s.status === 'draft') return await shapeSequence(ctx, s);
    await ctx.db.tx(async () => {
      await ctx.db.run("UPDATE sequences SET status='draft', revision=revision+1, updated_at=? WHERE id=?", [t, s.id]);
      await ctx.db.run('DELETE FROM sequence_step_approvals WHERE sequence_id=?', [s.id]);
      await ctx.db.audit(ctx.ws, s.campaign_id, 'sequence.editing', 'Sequence returned to draft; follow-ups pause until it is re-approved and relaunched', {}, ctx.user?.id);
    });
  }
  return await shapeSequence(ctx, await loadSequenceRow(ctx, s.id));
}
export async function holdOverdue(ctx, campaignId, reason) {
  await ctx.db.run("UPDATE send_tasks SET status='held', status_reason=?, updated_at=? WHERE campaign_id=? AND kind='followup' AND status='pending' AND due_at < ?", [reason, now(), campaignId, new Date(Date.now() - HOLD_AFTER_MS).toISOString()]);
}

// ---------- Enrollment ----------
const STOP_EVENTS = "('reply','opt_out','bounce','meeting')";
async function eligibleToEnroll(ctx, leadId) {
  return await ctx.db.get(`SELECT l.id lead_id, l.contact_id, m.sent_at FROM campaign_leads l
    JOIN send_tasks st ON st.lead_id=l.id AND st.kind='initial' AND st.status='sent' JOIN messages m ON m.send_task_id=st.id
    JOIN contacts ct ON ct.id=l.contact_id
    WHERE l.id=? AND l.decision='qualified'
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id=ct.workspace_id AND s.email=ct.email)
      AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.contact_id=l.contact_id AND e.type IN ${STOP_EVENTS} AND e.occurred_at >= m.sent_at)`, [leadId]);
}
async function enrollExisting(ctx, c, sequenceId) {
  const s = await ctx.db.get('SELECT * FROM sequences WHERE id=?', [sequenceId]);
  let n = 0;
  for (const { id: leadId } of await ctx.db.all("SELECT DISTINCT l.id FROM campaign_leads l JOIN send_tasks st ON st.lead_id=l.id AND st.kind='initial' AND st.status='sent' WHERE l.campaign_id=?", [c.id])) {
    if (await enroll(ctx, c.id, s, leadId)) n++;
  }
  return n;
}
async function enroll(ctx, campaignId, s, leadId) {
  if (await ctx.db.get('SELECT 1 FROM enrollments WHERE sequence_id=? AND lead_id=?', [s.id, leadId])) return false;
  const e = await eligibleToEnroll(ctx, leadId);
  if (!e) return false;
  const t = now();
  await ctx.db.insert('enrollments', { id: id(), campaign_id: campaignId, sequence_id: s.id, sequence_version_id: s.current_version_id, lead_id: leadId, contact_id: e.contact_id, anchor_sent_at: e.sent_at, next_step: 0, status: 'active', stop_reason: null, created_at: t, updated_at: t });
  return true;
}
export async function enrollOnSend(ctx, campaignId, leadId) {
  const s = await ctx.db.get("SELECT * FROM sequences WHERE campaign_id=? AND status='active'", [campaignId]);
  if (s && await enroll(ctx, campaignId, s, leadId)) await planFollowups(ctx, campaignId);
}
export async function stopEnrollments(ctx, contactId, reason) {
  const t = now(), rows = await ctx.db.all("SELECT e.id, e.campaign_id FROM enrollments e JOIN contacts ct ON ct.id=e.contact_id WHERE e.contact_id=? AND ct.workspace_id=? AND e.status='active'", [contactId, ctx.ws]);
  for (const r of rows) {
    await ctx.db.run("UPDATE enrollments SET status='stopped', stop_reason=?, updated_at=? WHERE id=?", [reason, t, r.id]);
    await ctx.db.run("UPDATE send_tasks SET status='canceled', status_reason=?, updated_at=? WHERE enrollment_id=? AND status IN ('pending','held')", [`Sequence stopped: ${reason}`, t, r.id]);
    await ctx.db.audit(ctx.ws, r.campaign_id, 'enrollment.stopped', `Follow-ups stopped (${reason})`, { enrollment_id: r.id });
  }
  return rows.length;
}
export async function advanceEnrollment(ctx, enrollmentId, stepIndex) {
  const e = await ctx.db.get('SELECT e.*, v.steps FROM enrollments e JOIN sequence_versions v ON v.id=e.sequence_version_id WHERE e.id=?', [enrollmentId]);
  if (!e || e.next_step !== stepIndex) return;
  const done = stepIndex + 1 >= json(e.steps).length;
  await ctx.db.run('UPDATE enrollments SET next_step=?, status=?, updated_at=? WHERE id=?', [stepIndex + 1, done ? 'completed' : e.status, now(), e.id]);
  if (!done) await planFollowups(ctx, e.campaign_id);
}

// Due date: the step's calendar-day offset from the recipient's initial send (in the campaign
// timezone), moved forward to the next scheduled weekday, at the campaign's daily time.
export function followupDue(anchorIso, day, schedule) {
  let date = addDays(localView(Date.parse(anchorIso), schedule.timezone).date, day);
  for (let i = 0; i < 7 && !schedule.days.includes(weekdayOf(date)); i++) date = addDays(date, 1);
  return zonedToUtc(date, schedule.time, schedule.timezone);
}
// Creates the next due step for every active enrollment. Unique (enrollment, step) prevents duplicates.
export async function planFollowups(ctx, campaignId) {
  const c = await loadCampaign(ctx, campaignId);
  const rows = await ctx.db.all(`SELECT e.*, v.steps, ct.first_name, ct.email, co.name company FROM enrollments e
    JOIN sequence_versions v ON v.id=e.sequence_version_id JOIN contacts ct ON ct.id=e.contact_id JOIN companies co ON co.id=ct.company_id
    WHERE e.campaign_id=? AND e.status='active'`, [c.id]);
  let created = 0;
  for (const e of rows) {
    const steps = json(e.steps), step = steps[e.next_step];
    if (!step) { await ctx.db.run("UPDATE enrollments SET status='completed', updated_at=? WHERE id=?", [now(), e.id]); continue; }
    if (await ctx.db.get('SELECT 1 FROM send_tasks WHERE enrollment_id=? AND step_index=?', [e.id, e.next_step])) continue;
    const due = followupDue(e.anchor_sent_at, step.day, c.config.schedule);
    const overdue = Date.parse(due) < Date.now() - HOLD_AFTER_MS;
    const missing = !e.first_name || !e.company || !e.email;
    const t = now();
    await ctx.db.insert('send_tasks', { id: id(), workspace_id: ctx.ws, campaign_id: c.id, lead_id: e.lead_id, contact_id: e.contact_id, kind: 'followup', draft_revision_id: null, enrollment_id: e.id, step_index: e.next_step, to_email: e.email || '', subject: render(step.subject, e), body: render(step.body, e), due_at: due, status: missing ? 'canceled' : overdue ? 'held' : 'pending', status_reason: missing ? 'Missing personalization data' : overdue ? 'Step was already overdue when scheduled; review before sending.' : null, dedupe_key: `fu:${e.id}:${e.next_step}`, confirmed_at: null, confirmed_by: null, created_at: t, updated_at: t });
    created++;
  }
  return created;
}
