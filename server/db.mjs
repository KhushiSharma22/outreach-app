// Persistence with two interchangeable drivers: PostgreSQL (e.g. Supabase) when DATABASE_URL is
// set, otherwise a local SQLite file. Services call the same async API either way; SQL is written
// to run on both. Every table that holds customer data carries workspace_id, directly or through
// its campaign, and every query is scoped by it.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (...parts) => createHash('sha256').update(parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join('\u0000')).digest('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mailboxes(workspace_id TEXT PRIMARY KEY, sender TEXT NOT NULL, postal_address TEXT NOT NULL, credentials TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS optout_tokens(token TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, UNIQUE(workspace_id,email));
CREATE TABLE IF NOT EXISTS pilot_allocations(workspace_id TEXT NOT NULL, day TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, day));
CREATE TABLE IF NOT EXISTS pilot_contacts(workspace_id TEXT NOT NULL, contact_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(workspace_id, contact_id));
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, sending_stopped INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', token_hash TEXT UNIQUE, created_at TEXT NOT NULL, password_hash TEXT, email_verified_at TEXT, google_sub TEXT, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, invited_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, user_id));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), method TEXT NOT NULL, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_id TEXT, email TEXT, workspace_id TEXT, role TEXT, data TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);

CREATE TABLE IF NOT EXISTS account_context_versions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), version INTEGER NOT NULL, data TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, UNIQUE(workspace_id, version));

CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', step INTEGER NOT NULL DEFAULT 0, context_version_id TEXT NOT NULL REFERENCES account_context_versions(id), config_version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, launched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_config_versions(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), version INTEGER NOT NULL, data TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, UNIQUE(campaign_id, version));

CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), filename TEXT NOT NULL, source TEXT NOT NULL, row_count INTEGER NOT NULL, created_count INTEGER NOT NULL, updated_count INTEGER NOT NULL, rejected TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, domain TEXT, industry TEXT, employees INTEGER, location TEXT, relationship TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS companies_domain ON companies(workspace_id, domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_name ON companies(workspace_id, lower(name)) WHERE domain IS NULL;
CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), company_id TEXT NOT NULL REFERENCES companies(id), first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', seniority TEXT, location TEXT, linkedin_url TEXT, email TEXT, email_status TEXT NOT NULL DEFAULT 'unverified', email_verifier TEXT, email_checked_at TEXT, source_import_id TEXT REFERENCES imports(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(workspace_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_linkedin ON contacts(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE TABLE IF NOT EXISTS campaign_contact_pool(workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL REFERENCES campaigns(id), contact_id TEXT NOT NULL REFERENCES contacts(id), source TEXT NOT NULL, available_on TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(campaign_id,contact_id,source));
CREATE TABLE IF NOT EXISTS research_days(workspace_id TEXT NOT NULL, day TEXT NOT NULL, campaign_id TEXT NOT NULL, allocated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,day));
CREATE TABLE IF NOT EXISTS campaign_contact_claims(workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, contact_id TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(workspace_id,contact_id));
CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), contact_id TEXT REFERENCES contacts(id), company_id TEXT REFERENCES companies(id), signal TEXT, fact TEXT NOT NULL, source_url TEXT, event_date TEXT, collected_at TEXT NOT NULL, provenance TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(workspace_id, fingerprint));

CREATE TABLE IF NOT EXISTS discovery_runs(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), batch INTEGER NOT NULL, config_version INTEGER NOT NULL, trigger TEXT NOT NULL, occurrence_date TEXT, status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '{}', candidates INTEGER NOT NULL DEFAULT 0, qualified INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0, shortfall_reason TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE(campaign_id, batch));
CREATE UNIQUE INDEX IF NOT EXISTS runs_occurrence ON discovery_runs(campaign_id, occurrence_date) WHERE occurrence_date IS NOT NULL;
CREATE TABLE IF NOT EXISTS campaign_leads(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), contact_id TEXT NOT NULL REFERENCES contacts(id), run_id TEXT NOT NULL REFERENCES discovery_runs(id), decision TEXT NOT NULL, score INTEGER NOT NULL, rationale TEXT NOT NULL, checks TEXT NOT NULL, missing TEXT NOT NULL, confidence TEXT NOT NULL, evidence_ids TEXT NOT NULL, assessed_by TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, override_by TEXT, override_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(campaign_id, contact_id));

CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), lead_id TEXT NOT NULL REFERENCES campaign_leads(id), current_revision_id TEXT, created_at TEXT NOT NULL, UNIQUE(lead_id));
CREATE TABLE IF NOT EXISTS draft_revisions(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), rev INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, origin TEXT NOT NULL, generator TEXT NOT NULL, evidence_ids TEXT NOT NULL, review_note TEXT, context_version_id TEXT NOT NULL, config_version INTEGER NOT NULL, created_by TEXT, created_at TEXT NOT NULL, UNIQUE(draft_id, rev));
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), revision_id TEXT NOT NULL REFERENCES draft_revisions(id), hash TEXT NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL, created_at TEXT NOT NULL, invalidated_at TEXT, invalidation_reason TEXT);

CREATE TABLE IF NOT EXISTS sequences(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL UNIQUE REFERENCES campaigns(id), status TEXT NOT NULL DEFAULT 'draft', steps TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, current_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequence_step_approvals(id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL REFERENCES sequences(id), step_index INTEGER NOT NULL, hash TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequence_versions(id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL REFERENCES sequences(id), version INTEGER NOT NULL, steps TEXT NOT NULL, approved_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(sequence_id, version));
CREATE TABLE IF NOT EXISTS enrollments(id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), sequence_id TEXT NOT NULL REFERENCES sequences(id), sequence_version_id TEXT NOT NULL REFERENCES sequence_versions(id), lead_id TEXT NOT NULL REFERENCES campaign_leads(id), contact_id TEXT NOT NULL REFERENCES contacts(id), anchor_sent_at TEXT NOT NULL, next_step INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', stop_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(sequence_id, lead_id));

CREATE TABLE IF NOT EXISTS send_tasks(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), campaign_id TEXT NOT NULL REFERENCES campaigns(id), lead_id TEXT NOT NULL REFERENCES campaign_leads(id), contact_id TEXT NOT NULL REFERENCES contacts(id), kind TEXT NOT NULL, draft_revision_id TEXT REFERENCES draft_revisions(id), enrollment_id TEXT REFERENCES enrollments(id), step_index INTEGER, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT, dedupe_key TEXT NOT NULL, confirmed_at TEXT, confirmed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id, dedupe_key));
CREATE UNIQUE INDEX IF NOT EXISTS step_execution ON send_tasks(enrollment_id, step_index) WHERE enrollment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL, send_task_id TEXT NOT NULL UNIQUE REFERENCES send_tasks(id), contact_id TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent_at TEXT NOT NULL, proof TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversation_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id), campaign_id TEXT, type TEXT NOT NULL, note TEXT, source TEXT NOT NULL, actor TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS suppressions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, contact_id TEXT, reason TEXT NOT NULL, note TEXT, actor TEXT, created_at TEXT NOT NULL, UNIQUE(workspace_id, email));
CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', actor TEXT, created_at TEXT NOT NULL, seq {{SEQ}});
CREATE INDEX IF NOT EXISTS audit_campaign ON audit_events(campaign_id, seq);

CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, campaign_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, last_error TEXT, dedupe_key TEXT UNIQUE, locked_at TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS idempotency_keys(workspace_id TEXT NOT NULL, key TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, key));
CREATE TABLE IF NOT EXISTS allowed_emails(email TEXT PRIMARY KEY, operator INTEGER NOT NULL DEFAULT 0, note TEXT, added_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limit_hits(key TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_key ON rate_limit_hits(key, at);
CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, operation TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, prompt_version TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, error TEXT, created_at TEXT NOT NULL);
`;
export const TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
const POST_SCHEMA = `CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS jobs_campaign ON jobs(campaign_id, type);
INSERT INTO memberships(workspace_id, user_id, role, created_at) SELECT workspace_id, id, role, created_at FROM users WHERE true ON CONFLICT DO NOTHING;`;

const clean = v => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;

// Shared API on top of a driver: { query(sql, params) -> { rows, changes }, tx(fn), close() }.
function wrap(driver, dialect) {
  const api = {
    dialect,
    run: (sql, p = []) => driver.query(sql, p),
    get: async (sql, p = []) => (await driver.query(sql, p)).rows[0],
    all: async (sql, p = []) => (await driver.query(sql, p)).rows,
    insert: async (table, row) => {
      const keys = Object.keys(row);
      await driver.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(k => ':' + k).join(',')})`, row);
      return row;
    },
    // Runs fn in a transaction; queries made anywhere in fn's async call chain join it. Nested calls use savepoints.
    tx: fn => driver.tx(fn),
    audit: (workspaceId, campaignId, type, summary, detail = {}, actor = null) => {
      const row = { id: id(), workspace_id: workspaceId, campaign_id: campaignId, type, summary, detail: JSON.stringify(detail), actor, created_at: now() };
      if (driver.nextSeq) row.seq = driver.nextSeq();
      return api.insert('audit_events', row);
    },
    close: () => driver.close(),
  };
  return api;
}

// ---------- SQLite ----------
// node:sqlite is synchronous; an async mutex keeps other requests out of an open transaction.
async function openSqlite(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA.replace('{{SEQ}}', 'INTEGER'));
  // Additive migrations for databases created by earlier versions.
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const userCols = cols('users');
  for (const col of ['password_hash', 'email_verified_at', 'google_sub', 'last_login_at']) if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  if (!cols('jobs').includes('campaign_id')) db.exec("ALTER TABLE jobs ADD COLUMN campaign_id TEXT; UPDATE jobs SET campaign_id=json_extract(payload,'$.campaign_id')");
  db.exec(POST_SCHEMA);
  let seq = Number(db.prepare('SELECT coalesce(max(seq),0) n FROM audit_events').get().n);
  const cache = new Map(), als = new AsyncLocalStorage();
  const stmt = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); s.setAllowUnknownNamedParameters(true); cache.set(sql, s); } return s; };
  const exec = (sql, p) => {
    const s = stmt(sql), args = Array.isArray(p) ? p.map(clean) : Object.fromEntries(Object.entries(p).map(([k, v]) => [k, clean(v)]));
    if (s.columns().length) { const rows = Array.isArray(args) ? s.all(...args) : s.all(args); return { rows, changes: 0 }; }
    const r = Array.isArray(args) ? s.run(...args) : s.run(args);
    return { rows: [], changes: Number(r.changes) };
  };
  // Work scheduled inside a transaction (timers, queued jobs) inherits its async context; ignore it once the transaction ends.
  const live = () => { const st = als.getStore(); return st && !st.done ? st : null; };
  let tail = Promise.resolve();
  const locked = async fn => { const prev = tail; let release; tail = new Promise(r => release = r); await prev; try { return await fn(); } finally { release(); } };
  return {
    query: async (sql, p) => live() ? exec(sql, p) : locked(() => exec(sql, p)),
    async tx(fn) {
      const store = live();
      if (store) {
        const sp = 'sp' + (++store.depth);
        db.exec(`SAVEPOINT ${sp}`);
        try { const r = await fn(); db.exec(`RELEASE ${sp}`); return r; }
        catch (e) { db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e; }
        finally { store.depth--; }
      }
      return locked(async () => {
        db.exec('BEGIN IMMEDIATE');
        const st = { depth: 0, done: false };
        try { const r = await als.run(st, fn); db.exec('COMMIT'); return r; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
        finally { st.done = true; }
      });
    },
    nextSeq: () => ++seq,
    close: async () => db.close(),
  };
}

// ---------- PostgreSQL ----------
// Converts ? and :name placeholders to $n, skipping quoted text.
const pgCache = new Map();
function toPg(sql) {
  let hit = pgCache.get(sql);
  if (hit) return hit;
  const names = []; let out = '', n = 0, i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") { const j = sql.indexOf("'", i + 1); out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '?') { out += '$' + (++n); i++; continue; }
    if (c === ':' && /[A-Za-z_]/.test(sql[i + 1] || '') && sql[i - 1] !== ':') {
      const m = sql.slice(i + 1).match(/^\w+/)[0];
      let k = names.indexOf(m);
      if (k < 0) { names.push(m); k = names.length - 1; }
      out += '$' + (k + 1); i += m.length + 1; continue;
    }
    out += c; i++;
  }
  hit = { text: out, names };
  pgCache.set(sql, hit);
  return hit;
}
async function openPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, v => Number(v));   // bigint (count) → number
  pg.types.setTypeParser(1700, v => Number(v)); // numeric (sum) → number
  // Supabase requires TLS. Its CA certificate verifies the server: DATABASE_CA_CERT_PEM holds the
  // certificate text (for hosts like Vercel), DATABASE_CA_CERT a path to the file.
  const ca = process.env.DATABASE_CA_CERT_PEM?.trim() || (process.env.DATABASE_CA_CERT ? readFileSync(process.env.DATABASE_CA_CERT, 'utf8') : null);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = local || process.env.DATABASE_SSL === 'false' ? false : ca ? { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false };
  if (ssl && !ca) console.warn('DATABASE_CA_CERT is not set: the database connection is encrypted but the server certificate is not verified.');
  // Serverless instances keep few connections and release idle ones quickly.
  const serverless = !!process.env.VERCEL;
  const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl, max: +(process.env.DATABASE_POOL_SIZE || (serverless ? 3 : 10)), idleTimeoutMillis: serverless ? 5000 : 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', e => console.error(JSON.stringify({ t: now(), event: 'db_pool_error', error: e.message })));
  const als = new AsyncLocalStorage();
  const live = () => { const st = als.getStore(); return st && !st.done ? st : null; };
  const query = async (sql, p) => {
    const { text, names } = toPg(sql);
    const values = Array.isArray(p) ? p.map(clean) : names.map(k => clean(p[k]));
    const r = await (live()?.client || pool).query(text, values);
    return { rows: r.rows || [], changes: r.rowCount ?? 0 };
  };
  // Create or update the schema when it changed. Runs in one transaction under a transaction-scoped
  // advisory lock, so it is safe through Supabase's transaction pooler and concurrent cold starts.
  const version = hash(SCHEMA, POST_SCHEMA, TABLES);
  const current = async c => (await c.query("SELECT to_regclass('schema_meta') t")).rows[0].t && (await c.query('SELECT version FROM schema_meta WHERE id=1')).rows[0]?.version;
  const c = await pool.connect();
  try {
    if (await current(c) !== version) {
      await c.query('BEGIN');
      try {
        await c.query('SELECT pg_advisory_xact_lock(727274)');
        if (await current(c) !== version) {
          await c.query(SCHEMA.replace('{{SEQ}}', 'BIGINT GENERATED BY DEFAULT AS IDENTITY'));
          await c.query(POST_SCHEMA);
          // Supabase publishes the public schema through its Data API. Enable row-level security with no
          // policies and revoke API-role access so only this server (the table owner) can read the data.
          await c.query(`DO $$ DECLARE t text; BEGIN
            FOREACH t IN ARRAY ARRAY['${[...TABLES, 'schema_meta'].join("','")}'] LOOP
              IF to_regclass(t) IS NULL THEN CONTINUE; END IF;
              EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon', t); END IF;
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated', t); END IF;
            END LOOP; END $$;`);
          await c.query('CREATE TABLE IF NOT EXISTS schema_meta(id INTEGER PRIMARY KEY, version TEXT NOT NULL, updated_at TEXT NOT NULL)');
          await c.query('ALTER TABLE schema_meta ENABLE ROW LEVEL SECURITY');
          await c.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON schema_meta FROM anon; END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON schema_meta FROM authenticated; END IF; END $$;`);
          await c.query('INSERT INTO schema_meta VALUES(1, $1, $2) ON CONFLICT (id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at', [version, now()]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    }
  } finally { c.release(); }
  return {
    query,
    async tx(fn) {
      const store = live();
      if (store) {
        const sp = 'sp' + (++store.depth);
        await store.client.query(`SAVEPOINT ${sp}`);
        try { const r = await fn(); await store.client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
        catch (e) { await store.client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
        finally { store.depth--; }
      }
      const client = await pool.connect(), st = { client, depth: 0, done: false };
      try {
        await client.query('BEGIN');
        const r = await als.run(st, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { st.done = true; client.release(); }
    },
    close: () => pool.end(),
  };
}

export async function openDb({ url = null, file = ':memory:' } = {}) {
  return url ? wrap(await openPostgres(url), 'postgres') : wrap(await openSqlite(file), 'sqlite');
}
