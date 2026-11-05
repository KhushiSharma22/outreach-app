## Private pilot: run your cloned copy locally

Use Node.js 24 or newer. From this repository directory:

```sh
git pull --ff-only
npm ci
npm run setup:local
npm start
```

Open http://127.0.0.1:4191/ (unless you already configured a different port). The setup command adds the four approved pilot email addresses to your local allowlist, creates a unique encryption key if absent, and enables local-only email verification skipping for new setups. Existing configuration and encryption keys are preserved. Sign up with your own approved email and a new password; accounts and leads from other installations are not copied.

Complete Company context, then Email setup. Enter SMTP credentials only in the app; never send them in chat or commit `.env`. A Gmail app password is needed where supported by your provider. Setup alone does not connect a real mailbox or send email. AI is offline by default. Campaign SMTP sending still needs public HTTPS for unsubscribe links; local connection testing sends a test to your configured sender.

This is not a public deployment. Do not use this setup command in production. Production requires its own secrets, database, verification-email service, HTTPS and explicit allowlist.

---

# Outbound campaign studio

An email-first outbound workspace. You import prospects, qualify them against a campaign with evidence, review and approve exact email revisions, send them yourself, and run follow-up sequences timed from each recipient's own first email.

This builds the backend described in `BACKEND_HANDOFF.md` and connects the existing frontend to it. These decisions were made for this first release:

| Decision | Choice |
|---|---|
| Stack | Node.js (≥ 24), no framework. Dependencies: `pg`, `nodemailer`, and the optional Gemini and Anthropic SDKs. |
| Database | **Supabase (PostgreSQL)** when `DATABASE_URL` is set; otherwise a local SQLite file. The same code and SQL run on both. |
| Delivery | **Manual send tasks**, or **Send via SMTP** through the workspace's connected mailbox (credentials encrypted with `MAILBOX_KEY`; every campaign email carries an unsubscribe link). |
| Sourcing | **Curated lead pool.** Pilot operators (`OPERATOR_EMAILS`) import leads by CSV; each workspace gets one batch of at most 30 leads per UTC day, across all campaigns, for up to five days. |
| AI | **Gemini** (`GEMINI_API_KEY`, default model `gemini-flash-latest`) or **Claude** (`ANTHROPIC_API_KEY`, `claude-opus-5-5`). Otherwise a deterministic, evidence-only template provider is used. |
| Approval mode | Daily review only. Pre-approved rules mode is disabled until a policy is agreed. |
| Sign-in | **Private pilot.** Only addresses in `ALLOWED_EMAILS` can sign up or sign in, with email + password confirmed by email. Google sign-in is disabled (the code is kept for a later release). Sign-up creates a workspace; owners invite approved teammates. |

## Run locally

```sh
npm install
cp .env.example .env # fill in ALLOWED_EMAILS, and optionally Supabase, SMTP, and AI settings
npm start            # http://127.0.0.1:4173
```

`npm start` loads `.env` automatically. With no `DATABASE_URL`, data is kept in a local SQLite file.

Open the URL and create an account with an address listed in `ALLOWED_EMAILS`. Without SMTP settings, the confirmation link is printed in the server console; open it to finish signing up. With SQLite, data lives in `data/outreach.db`; delete `data/` to start over.

If you used an earlier version, your existing Northstar workspace is kept, but its owner (`maya@northstar.example`) has no password. Choose **Forgot password?** on the sign-in screen, enter that address, and open the reset link from the console.

To try the whole flow quickly, sign in with an address in `OPERATOR_EMAILS` and go to **Contacts → Load fictional sample contacts**. This adds 38 fictional people with `.example` addresses and recent signal dates. Then create a campaign from Home.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `4173`, `127.0.0.1` | Listen address. Dev sign-in refuses to bind beyond localhost. |
| `DB_FILE` | `data/outreach.db` | SQLite database path. |
| `AI_PROVIDER` | `auto` | `auto` (Claude if `ANTHROPIC_API_KEY` is set, else Gemini if `GEMINI_API_KEY` is set, else templates), or `claude`, `gemini`, `offline`. |
| `GEMINI_API_KEY` | — | Enables Gemini. Get a key at aistudio.google.com/apikey. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model override. |
| `GEMINI_FALLBACK_MODEL` | `gemini-flash-lite-latest` | Used when the main Gemini model stays overloaded; `none` disables it. |
| `AI_FALLBACK` | on | If the AI provider is temporarily unavailable after retries, steps use templates or rules and say so. `off` makes them fail instead. |
| `ANTHROPIC_API_KEY` | — | Enables Claude. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Claude model override. |
| `MAX_CANDIDATES_PER_RUN` | `300` | Contacts checked per discovery batch. |
| `MAX_AI_ASSESSMENTS_PER_RUN` | `40` | Cost cap on AI fit assessments per batch. |
| `SCHEDULER_INTERVAL_MS` | `30000` | How often the daily scheduler checks. |
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | Address users reach. Used in email links and the Google redirect; `https://` turns on secure cookies. Required when binding beyond localhost. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | — | SMTP server for confirmation, reset, and invite emails (port 465 implies TLS). Required when binding beyond localhost. |
| `MAIL_FROM` | `Outbound <no-reply@localhost>` | Sender for those emails. |
| `SUPER_ADMIN_EMAILS` | khushi.sharma.2201@gmail.com, paroksh05@gmail.com, siddharth.m2703@gmail.com | Who gets the **Super admin** portal. Super admins are always approved and are operators. Setting this replaces the default list. |
| `ALLOWED_EMAILS` | empty | Extra approved addresses set in the deployment (read-only in the portal). Most people are added from the Super admin portal instead. |
| `OPERATOR_EMAILS` | empty | Extra operators set in the deployment. Operators can also be toggled in the Super admin portal. |
| `MAILBOX_KEY` | — | 32 random bytes (base64) used to encrypt connected-mailbox credentials. Keep it stable and secret. |
| `SMTP_ALLOWED_HOSTS` | `smtp.gmail.com,smtp.office365.com` | SMTP hosts a workspace may connect for campaign sending. |
| `LOCAL_SKIP_EMAIL_VERIFICATION` | `false` | Local development only: skip email confirmation. Ignored in production and on Vercel. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Ignored during the pilot: Google sign-in is disabled. |
| `AUTH_MODE` | `accounts` | `dev` also seeds a demo workspace and writes an API bearer token to `data/.dev-token` for scripts. |

### Sign-in

During the private pilot, only addresses in `ALLOWED_EMAILS` can use the app, with **email and password**:

- **Sign-up** is refused for any other address. An approved sign-up creates a new workspace the person owns, and new users are taken through onboarding: company context, then email setup. They must confirm their email before the first password sign-in; the link expires in 24 hours.
- **Teammates** are invited from **Team & account**. The invite email links to a page where they create an account or sign in, and they join the inviting workspace as a member or owner. Signing up through an invite skips email confirmation, because the invite link itself proved the address. People who belong to several workspaces can switch from the sidebar.
- **Google** sign-in is disabled for the pilot. The implementation is kept for a later release.
- **Super admins** (`SUPER_ADMIN_EMAILS`) see a **Super admin** toggle in the sidebar. The portal approves people (one or many, optionally emailing them an invitation), turns operator access on or off, removes access (signing that person out everywhere, keeping their data), and logs every action. Changes apply immediately, with no redeploy. Super admins can't be added or removed from inside the app.
- **Forgot password** sends a one-hour, single-use reset link. Completing a reset or changing a password signs out other sessions.

For SMTP you can use any provider: Google Workspace with an app password (`smtp.gmail.com`, port 465), Amazon SES, Postmark, SendGrid, or Mailgun. These settings are only for account emails. Outreach is still sent by you from your own mailbox.

How it's protected:

- Passwords are hashed with scrypt.
- Sessions are random tokens stored hashed, in HttpOnly SameSite=Lax cookies, with a 30-day sliding expiry.
- Sign-in, sign-up, reset, and invite requests are rate-limited.
- Sign-up and reset responses don't reveal whether an account exists.
- Every write, including sign-in forms, requires the app's CSRF header.
- Sessions of people removed from `ALLOWED_EMAILS` stop working immediately.

## How it works

**Company context** is versioned. Each campaign pins the version it was created with, so later edits never change approved emails silently. You can move a campaign to the latest version explicitly.

**Campaign brief.** The assistant turns your request into proposed filters (roles, industries, locations, sizes, seniority, exclusions, signals) and lists anything ambiguous. Your original prompt is stored verbatim. Filters apply only once you confirm them. Campaign configuration is versioned, and stale edits return a conflict.

**Discovery** runs as a durable background job over imported contacts the campaign hasn't seen before. Deterministic checks are authoritative:

- Missing role, industry, size, or location data sends a contact to *review*. It never counts as a match.
- Invalid, bounced, or suppressed emails, exclusion matches, and stale or missing signals are *excluded*.
- Unverified or catch-all emails need review when "require verified email" is on.

The AI provider, if configured, then assesses contextual fit. If the provider is busy or rate limited, requests are retried. Gemini then tries a lighter model, and if AI is still unavailable, that step falls back to rules or templates with a visible note, so a provider outage never blocks discovery or drafting. It can only make a decision stricter. Every batch is kept. A batch below 25 qualified shows a shortfall with its most common blockers rather than padding the list. Re-running never re-adds the same person.

**Drafts** have immutable revisions. Each one records its generator (AI model or template), the evidence it cites, and the context and config versions it was written with. A post-generation guard rejects AI drafts that:

- mention hiring, funding, leadership, or expansion without cited evidence of that signal
- contain unresolved placeholders
- are missing the signature

A rejected draft is replaced with a safe template and flagged for review. Research text is passed to the model as untrusted data.

**Approvals** bind to an exact revision and its hash, including the recipient address. Editing, rewriting, or regenerating a draft clears its approval and cancels any queued send for it. Bulk approval names each draft revision and reports partial failures.

**Launch** re-validates everything on the server and creates one send task per approved email. It is idempotent, so repeating it does nothing extra.

**Send queue.** Open each email in your mail app or copy it, send it, then confirm with the actual send time. Confirmation is recorded as *user-confirmed*, never as provider-verified. Before accepting a confirmation the server rechecks:

- that the approval still matches the content
- suppression
- campaign and sequence pause state
- the recipient's enrollment
- the workspace-wide sending stop

**Sequences** keep a draft working copy with per-step approvals. Launching freezes an immutable version. Enrollment rules:

- Recipients enroll only once their initial email is confirmed sent.
- Each step is due on the recipient's send date plus the step's day offset, in the campaign's timezone. If that falls on a non-sending day it moves to the next sending day, and it is due at the campaign's daily time.
- Steps that are already overdue when created, or that became overdue during a pause, are **held for review** rather than released in a burst.
- Recording a reply, bounce, opt-out, or meeting stops remaining follow-ups, even ones already queued. Bounces and opt-outs also suppress the address across the workspace.
- Existing enrollments keep their pinned version when you edit and relaunch. Editing pauses follow-ups until the new version is approved.

**Scheduler.** Each active campaign gets at most one discovery batch per local scheduled day (enforced by a unique key). Missed days after downtime are not backfilled. New batches produce drafts that wait for your review.

**Metrics** come from stored records, with stated definitions: candidates, qualified, selected, approved, queued, sent (user-confirmed), and replies, bounces, opt-outs, and meetings (recorded manually). Opens and deliveries are not tracked.

**Security.** Every query is scoped to the signed-in session's workspace. Cookie-authenticated writes need a custom CSRF header. A strict CSP is set. Provider credentials stay on the server, and AI call logs record operation, model, latency, and tokens but no prompts or personal data.

## API

All routes are under `/api` and scoped to the signed-in workspace. Operations that create work accept an `Idempotency-Key` header. Edits, approvals, and launch take the expected `revision` and return `409` when stale. Errors look like `{ error: { code, message, fields } }`.

- `GET /auth/config`, `POST /auth/{signup,login,logout,logout-all,verify-email,resend-verification,forgot-password,reset-password,change-password,invite-preview,accept-invite,switch-workspace}`
- `GET /team`, `POST /team/invites`, `DELETE /team/invites/:id`, `DELETE /team/members/:id`
- Browser redirects (outside `/api`): `GET /auth/google/start`, `GET /auth/google/callback`
- `GET /session`, `GET /summary`, `GET|PATCH /account-context`
- `POST /campaign-briefs/interpret`
- `GET|POST /campaigns`, `GET|PATCH /campaigns/:id`, `POST /campaigns/:id/{launch,pause,resume,stop}`
- `POST /campaigns/:id/discovery-runs`, `GET /campaigns/:id/batches`, `GET /runs/:id`
- `GET /campaigns/:id/leads`, `POST /campaigns/:id/lead-selection`, `PATCH /campaign-leads/:id`
- `POST /campaigns/:id/draft-runs`, `GET /campaigns/:id/drafts`, `GET|PATCH /drafts/:id`, `POST /drafts/:id/rewrites`, `POST /approvals`
- `GET /campaigns/:id/sequence`, `PATCH /sequences/:id`, `POST /sequences/:id/{approvals,launch,pause,resume,edit}`
- `GET /send-tasks`, `POST /send-tasks/:id/{confirm-sent,skip,release}`
- `POST /contacts/:id/outcomes`, `GET /contacts`, `GET|POST /imports`, `GET|POST /suppressions`, `DELETE /suppressions/:id`
- `GET /campaigns/:id/metrics`, `GET /campaigns/:id/events`, `GET /events`, `POST /workspace/sending`

## Files

- `server/app.mjs`: HTTP server, routing, idempotency, static files
- `server/auth.mjs`: accounts, pilot allowlist, sessions, email verification, password reset, invites (Google sign-in disabled for the pilot)
- `server/mailer.mjs`: SMTP delivery of account emails (console fallback in development)
- `server/db.mjs`: schema, plus PostgreSQL and SQLite drivers behind one async API (transactions follow the async call chain)
- `scripts/sqlite-to-postgres.mjs`: one-time copy of local data into Supabase
- `server/campaigns.mjs`: company context and campaign configuration versions
- `server/sourcing.mjs`: CSV import, identity resolution, deterministic checks, discovery runs
- `server/drafts.mjs`: leads, draft revisions, approvals
- `server/delivery.mjs`: launch, send tasks, outcomes, suppression
- `server/sequences.mjs`: sequence versions, enrollment, follow-up planning
- `server/jobs.mjs`: durable job queue and daily scheduler
- `server/reporting.mjs`: metrics, activity, contacts
- `server/ai.mjs`: Gemini, Claude, and offline providers (shared prompts and schemas), draft guard
- `server/sample.mjs`: fictional sample CSV
- `dist/`: frontend (`index.html`, `api.js` client, `app.js`, `style.css`)
- `tests/`: backend acceptance tests, sign-in tests under the pilot allowlist, pilot allocation and mailbox tests, SMTP test against a local fake server, Gemini and Claude adapter tests against local mocks, frontend integration test

## Hosting on Vercel

`api/index.mjs` serves every request that isn't a static file; `vercel.json` rewrites them to it, and `dist/` is served as static files.

- **Background work:** jobs queued by a request run after the response via Vercel's `waitUntil`. Jobs cut off by the function time limit are requeued after `JOB_STALE_MS` (15 minutes).
- **Scheduler:** it runs at most once a minute while the app is in use, and daily through `api/cron.mjs`, which requires `CRON_SECRET`.
- **Database:** Postgres is required on Vercel. Use Supabase's transaction pooler URL (port 6543), and pass the CA certificate's text in `DATABASE_CA_CERT_PEM`.
- **Rate limits:** sign-in rate limits are stored in the database, so they hold across instances.

Step-by-step deployment is in `SETUP_HANDOFF.md`, section 4. `npm start` still runs the app as a normal Node server for local use or any host that runs Node processes.

## Database: Supabase

The app uses Supabase as a plain PostgreSQL database. Sign-in stays in this app; Supabase Auth and the Data API aren't used.

1. **Create a Supabase project.** Note the database password you set.
2. **Get the connection string.** Open **Connect** in the dashboard and copy the **Session pooler** string, which uses port 5432 and works over IPv4. Replace `[YOUR-PASSWORD]` and set it as `DATABASE_URL` in `.env`. The direct connection string also works if your host has IPv6. The transaction pooler (port 6543) works too, but session mode suits a long-running server.
3. **Recommended: verify the server's certificate.** Download it from **Project Settings → Database → SSL configuration** and set `DATABASE_CA_CERT` to its path. Without it, the connection is still encrypted, but the server's identity isn't checked, and a warning is logged at startup.
4. **Start the app.** On first start it creates every table in the `public` schema. Each table then gets row-level security with no policies, and Supabase's `anon` and `authenticated` roles lose access. That way the project's public API keys can't read anything; only this server, which owns the tables, can.
5. **Optional: copy existing local data.** Stop the server, then run `npm run db:copy-sqlite -- data/outreach.db`. The copy runs in one transaction and skips rows that already exist, so it's safe to re-run.

Schema creation is additive and idempotent, and an advisory lock prevents two instances from creating it at the same time. Background jobs are claimed atomically and daily batches are unique per campaign and day, so more than one app instance can share the database.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string; unset means SQLite. |
| `DATABASE_CA_CERT` | — | Path to the server's CA certificate for verified TLS. |
| `DATABASE_CA_CERT_PEM` | — | The certificate's text instead of a path (for Vercel). |
| `CRON_SECRET` | — | Required by `/api/cron` on Vercel. |
| `JOB_STALE_MS` | `900000` | A running job older than this is treated as cut off and requeued. |
| `TRUST_PROXY` | on for Vercel | Set to `true` behind another proxy so rate limits use the client's `X-Forwarded-For` address. |
| `DATABASE_SSL` | on, except localhost | Set to `false` to turn off TLS, e.g. for a local Postgres. |
| `DATABASE_POOL_SIZE` | `10` | Maximum connections from this instance. |

## Checks

```sh
npm run check
npm test             # SQLite, in memory
npm run db:local-pg  # once: starts Postgres 17 in Docker on port 54329
npm run test:pg      # same suite against Postgres; each test file gets a fresh database
npm run test:browser # sign-up, confirm, reset, and sign-in through the real forms in headless Chrome
```

Tests never use `DATABASE_URL`, so they can't touch your Supabase project. Set `DEBUG_ERRORS=1` to print server errors and job failures while tests run.

## Not done yet

These items from the handoff remain open:

- **Account management.** There's no self-service account deletion, email change, or two-factor sign-in yet.
- **Connected-mailbox sending** (OAuth, provider message IDs, reply and bounce sync). Until it exists, outcomes are recorded manually.
- **An AI web-research or enrichment provider**, plus a live email-verification provider. Verification status currently comes from your import.
- **Pre-approved rules mode.**
- **First production deployment.** The Vercel setup is in the code (`api/`, `vercel.json`) and tested locally, but it hasn't been deployed yet. See `SETUP_HANDOFF.md`, section 4.
- **Data retention and deletion policies.**

`.openai/hosting.json` refers to the old static-only hosting. The app now needs the Node server, so a static deployment of `dist/` will show a connection error.
