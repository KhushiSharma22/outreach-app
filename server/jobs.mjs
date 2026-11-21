// Durable job queue (stored in the database) with retries and dead-lettering, plus the daily scheduler.
// Long-running server: a poller runs due jobs. Serverless (Vercel): enqueue() only records that work is
// waiting; the request handler runs it after the response via waitUntil, and a cron sweeps the rest.
import { id, now } from './db.mjs';
import { json, localView } from './lib.mjs';
import { executeDiscovery, failRun, startDiscovery } from './sourcing.mjs';
import { executeDraftRun, startDraftRun, approveDrafts } from './drafts.mjs';
import { dispatchApproved, onDraftApproved } from './delivery.mjs';
import { loadCampaign, scheduleTime } from './campaigns.mjs';
import { planFollowups } from './sequences.mjs';

const STALE_MS = () => +(process.env.JOB_STALE_MS || (process.env.VERCEL ? 6 * 60e3 : 15 * 60e3)); // a running job older than this was cut off

export function createJobs(db, log = () => {}, { serverless = false } = {}) {
  const handlers = {}, running = new Set(), inflight = new Set();
  let kicked = false;
  let timer = null, schedTimer = null;
  const jobs = {
    async enqueue(workspaceId, type, payload, { dedupe = null, runAt = now(), maxAttempts = 3 } = {}) {
      if (dedupe) { const ex = await db.get('SELECT * FROM jobs WHERE dedupe_key=?', [dedupe]); if (ex) return ex; }
      const row = { id: id(), workspace_id: workspaceId, campaign_id: payload.campaign_id || null, type, payload: JSON.stringify(payload), status: 'queued', run_at: runAt, attempts: 0, max_attempts: maxAttempts, last_error: null, dedupe_key: dedupe, locked_at: null, created_at: now(), finished_at: null };
      await db.insert('jobs', row);
      if (serverless) kicked = true;
      else setImmediate(() => jobs.tick().catch(e => log('tick_error', { error: String(e) })));
      return row;
    },
    on(type, handler, onDead) { handlers[type] = { handler, onDead }; },
    // Runs due jobs; each job is claimed atomically so it executes once per attempt.
    async tick() {
      // Requeue jobs whose worker died (crash, or a serverless function hitting its time limit).
      await db.run("UPDATE jobs SET status='queued', locked_at=NULL WHERE status='running' AND locked_at<?", [new Date(Date.now() - STALE_MS()).toISOString()]);
      const due = await db.all("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY run_at LIMIT 2", [now()]);
      const batch = Promise.all(due.filter(j => !running.has(j.id)).map(async j => {
        if (!(await db.run("UPDATE jobs SET status='running', attempts=attempts+1, locked_at=? WHERE id=? AND status='queued'", [now(), j.id])).changes) return;
        running.add(j.id);
        const h = handlers[j.type];
        try {
          if (!h) throw new Error(`No handler for ${j.type}`);
          await h.handler(json(j.payload), j);
          await db.run("UPDATE jobs SET status='done', finished_at=?, last_error=NULL WHERE id=?", [now(), j.id]);
        } catch (e) {
          const attempts = j.attempts + 1, msg = String(e?.message || e).slice(0, 500);
          log('job_failed', { job: j.id, type: j.type, attempts, error: msg });
          if (attempts >= j.max_attempts) {
            await db.run("UPDATE jobs SET status='dead', last_error=?, finished_at=? WHERE id=?", [msg, now(), j.id]);
            try { await h?.onDead?.(json(j.payload), j, msg); } catch (err) { log('dead_handler_failed', { job: j.id, error: String(err) }); }
          } else {
            await db.run("UPDATE jobs SET status='queued', last_error=?, run_at=? WHERE id=?", [msg, new Date(Date.now() + 2000 * 2 ** attempts).toISOString(), j.id]);
          }
        } finally { running.delete(j.id); }
      }));
      inflight.add(batch);
      try { await batch; } finally { inflight.delete(batch); }
    },
    async start({ pollMs = 1000, scheduleMs = 30000, scheduler } = {}) {
      // Jobs left running by a crash are retried; handlers are idempotent.
      await db.run("UPDATE jobs SET status='queued', locked_at=NULL WHERE status='running'");
      timer = setInterval(() => jobs.tick().catch(e => log('tick_error', { error: String(e) })), pollMs);
      if (scheduler) { schedTimer = setInterval(async () => { try { await scheduler(); } catch (e) { log('scheduler_error', { error: String(e) }); } }, scheduleMs); setTimeout(async () => { try { await scheduler(); } catch (e) { log('scheduler_error', { error: String(e) }); } }, 500); }
    },
    stop() { clearInterval(timer); clearInterval(schedTimer); },
    // Serverless: true once per request if that request queued work (and resets the flag).
    takeKick() { const k = kicked; kicked = false; return k; },
    // Runs due jobs until none are left or the time budget is used up (serverless functions have a limit).
    async runDue(budgetMs = 240e3) {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        await jobs.tick();
        while (inflight.size) await Promise.all([...inflight]);
        if (!await db.get("SELECT 1 FROM jobs WHERE status='queued' AND run_at<=?", [now()])) return;
      }
    },
    // Test helper: runs due jobs until none are queued, waiting for jobs already in flight.
    async drain(max = 50) {
      for (let i = 0; i < max; i++) {
        await jobs.tick();
        while (inflight.size) await Promise.all([...inflight]);
        if (!await db.get("SELECT 1 FROM jobs WHERE status='queued' AND run_at<=?", [now()])) return;
      }
    },
  };
  return jobs;
}

// Wires job types to services. ctxFor(workspaceId) returns a system-actor context for that workspace.
export function registerHandlers(jobs, db, ctxFor) {
  jobs.on('discovery', async ({ run_id }, job) => {
    const ws = job.workspace_id, ctx = ctxFor(ws);
    const res = await executeDiscovery(ctx, run_id);
    if (res?.run?.trigger === 'schedule' || res?.campaign?.status === 'active') await startDraftRun(ctx, res.campaign.id);
  }, async ({ run_id }, job, msg) => {
    await failRun(db, run_id, `Discovery failed after retries: ${msg}`);
    const r = await db.get('SELECT campaign_id FROM discovery_runs WHERE id=?', [run_id]);
    await db.audit(job.workspace_id, r?.campaign_id, 'discovery.failed', 'Discovery failed; you can retry it', { error: msg });
  });
  jobs.on('drafts', async (payload, job) => {
    const ctx = ctxFor(job.workspace_id);
    const result = await executeDraftRun(ctx, {...payload, batch_limit:4});
    if (result.remaining) await jobs.enqueue(job.workspace_id, 'drafts', {...payload, after_lead_id:result.lastLeadId}, {dedupe:'draft-continuation:'+job.id});
    const c = await loadCampaign(ctx, payload.campaign_id);
    if (c.status !== 'active' || c.config.delivery !== 'smtp' || c.config.approval !== 'rules') return;
    const rows = await db.all(`SELECT d.id draft_id,r.id revision_id FROM drafts d JOIN draft_revisions r ON r.id=d.current_revision_id JOIN campaign_leads l ON l.id=d.lead_id WHERE d.campaign_id=? AND l.selected=1 AND l.decision='qualified' AND r.origin='generated' AND r.review_note IS NULL AND r.config_version=? AND r.context_version_id=? AND NOT EXISTS (SELECT 1 FROM send_tasks st WHERE st.lead_id=l.id AND st.kind='initial') AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.revision_id=r.id)`, [c.id,c.config_version,c.context_version_id]);
    if (rows.length) await approveDrafts(ctx, {items:rows,confirm:true}, onDraftApproved(ctx));
  },
    async (payload, job, msg) => await db.audit(job.workspace_id, payload.campaign_id, 'drafts.failed', 'Email drafting failed; retry from Email studio', { error: msg }));
}

// Creates at most one discovery occurrence per campaign per local day, only for today (no backlog
// after downtime), and plans due follow-ups.
export async function runScheduler(db, ctxFor, at = Date.now(), send, { weeklyOnly = false } = {}) {
  await db.run("UPDATE send_tasks SET status='unknown',status_reason='Worker stopped during sending. Check mailbox before retrying.',updated_at=? WHERE status='sending' AND updated_at<?",[new Date(at).toISOString(),new Date(at-15*60e3).toISOString()]);
  for (const c of await db.all("SELECT c.id, c.workspace_id, v.data FROM campaigns c JOIN campaign_config_versions v ON v.campaign_id=c.id AND v.version=c.config_version WHERE c.status='active'")) {
    if (weeklyOnly && !await db.get('SELECT 1 FROM weekly_slots WHERE workspace_id=? AND campaign_id=? LIMIT 1',[c.workspace_id,c.id])) continue;
    const ctx = ctxFor(c.workspace_id), s = json(c.data).schedule;
    try {
      const local = localView(at, s.timezone);
      if (s.days.includes(local.weekday) && local.time >= scheduleTime(s,local.weekday) && !await db.get('SELECT 1 FROM weekly_slots WHERE workspace_id=? AND campaign_id=? AND slot_date=?',[c.workspace_id,c.id,local.date]) && !await db.get('SELECT 1 FROM discovery_runs WHERE campaign_id=? AND occurrence_date=?', [c.id, local.date])) {
        await startDiscovery(ctx, c.id, { trigger: 'schedule', occurrenceDate: local.date });
      }
      await planFollowups(ctx, c.id);
    } catch (e) {
      await db.audit(c.workspace_id, c.id, 'scheduler.error', 'Scheduled work could not be created', { error: String(e.message) });
    }
    await dispatchApproved(ctx,c.id,at,send);
  }
}
