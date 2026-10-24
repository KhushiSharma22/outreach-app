// Durable job queue (SQLite-backed) with retries and dead-lettering, plus the daily scheduler.
import { id, now } from './db.mjs';
import { json, localView } from './lib.mjs';
import { executeDiscovery, failRun, startDiscovery } from './sourcing.mjs';
import { executeDraftRun, startDraftRun } from './drafts.mjs';
import { planFollowups } from './sequences.mjs';

export function createJobs(db, log = () => {}) {
  const handlers = {}, running = new Set(), inflight = new Set();
  let timer = null, schedTimer = null;
  const jobs = {
    async enqueue(workspaceId, type, payload, { dedupe = null, runAt = now(), maxAttempts = 3 } = {}) {
      if (dedupe) { const ex = await db.get('SELECT * FROM jobs WHERE dedupe_key=?', [dedupe]); if (ex) return ex; }
      const row = { id: id(), workspace_id: workspaceId, campaign_id: payload.campaign_id || null, type, payload: JSON.stringify(payload), status: 'queued', run_at: runAt, attempts: 0, max_attempts: maxAttempts, last_error: null, dedupe_key: dedupe, locked_at: null, created_at: now(), finished_at: null };
      await db.insert('jobs', row);
      setImmediate(async () => await jobs.tick());
      return row;
    },
    on(type, handler, onDead) { handlers[type] = { handler, onDead }; },
    // Runs due jobs; each job is claimed atomically so it executes once per attempt.
    async tick() {
      const due = await db.all("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY run_at LIMIT 4", [now()]);
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
            try { h?.onDead?.(json(j.payload), j, msg); } catch (err) { log('dead_handler_failed', { job: j.id, error: String(err) }); }
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
  jobs.on('drafts', async (payload, job) => { await executeDraftRun(ctxFor(job.workspace_id), payload); },
    async (payload, job, msg) => await db.audit(job.workspace_id, payload.campaign_id, 'drafts.failed', 'Email drafting failed; retry from Email studio', { error: msg }));
}

// Creates at most one discovery occurrence per campaign per local day, only for today (no backlog
// after downtime), and plans due follow-ups.
export async function runScheduler(db, ctxFor, at = Date.now()) {
  for (const c of await db.all("SELECT c.id, c.workspace_id, v.data FROM campaigns c JOIN campaign_config_versions v ON v.campaign_id=c.id AND v.version=c.config_version WHERE c.status='active'")) {
    const ctx = ctxFor(c.workspace_id), s = json(c.data).schedule;
    try {
      const local = localView(at, s.timezone);
      if (s.days.includes(local.weekday) && local.time >= s.time && !await db.get('SELECT 1 FROM discovery_runs WHERE campaign_id=? AND occurrence_date=?', [c.id, local.date])) {
        await startDiscovery(ctx, c.id, { trigger: 'schedule', occurrenceDate: local.date });
      }
      await planFollowups(ctx, c.id);
    } catch (e) {
      await db.audit(c.workspace_id, c.id, 'scheduler.error', 'Scheduled work could not be created', { error: String(e.message) });
    }
  }
}
