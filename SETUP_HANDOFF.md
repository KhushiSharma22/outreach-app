# Setup handoff: Supabase, SMTP, Google sign-in, Vercel

The app is built and on `main`: backend, sign-in, invites, and Supabase support. Three setup tasks are left: **SMTP**, **Google sign-in**, and **deploying to Vercel**. This page gives exact steps for each, plus how to create and connect Supabase.

For architecture and API details, see `README.md`. For the product background, see `BACKEND_HANDOFF.md`.

## Before you start

- Node.js 24 or newer (`node --version`).
- Get the project's `.env` values from Siddharth over a private channel. `.env` is git-ignored; never commit it.
- To set up locally:
  ```sh
  git clone https://github.com/KhushiSharma22/outreach-app.git
  cd outreach-app
  npm install
  cp .env.example .env    # then fill in the values below
  npm start               # http://127.0.0.1:4173
  ```
- On startup the server prints which database it's using, whether SMTP is configured, and whether Google sign-in is enabled. Check those lines after each step below.

## 1. Supabase: create and connect

**Status: done for the current project** (`outreach`, ref `qsvxevvwidfvwctdynbx`, us-east-1). Follow these steps only for a new project, or to connect your own machine to the existing one.

1. Go to supabase.com and click **New project**. Choose a region and set a database password. Save the password.
2. **Connection string.** Click **Connect** at the top of the dashboard and choose **Session pooler**. If the panel shows a `psql` command instead of a URI, build the URI from the parameters it lists:
   ```
   DATABASE_URL=postgresql://postgres.<project-ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   URL-encode special characters in the password (for example `@` becomes `%40`), or use a password that's only letters and numbers.
3. **SSL certificate.** Go to **Database** (left icon bar) → **Settings** → **SSL Configuration** → **Download certificate**. If you can't find it, press ⌘K and search for "SSL". Save the file as `certs/prod-ca-2021.crt` (`certs/` is git-ignored) and set:
   ```
   DATABASE_CA_CERT=certs/prod-ca-2021.crt
   ```
4. Run `npm start`. The startup log should say `Database: PostgreSQL (...pooler.supabase.com:5432)`. The first start creates all tables, turns on row-level security, and revokes Supabase's `anon` and `authenticated` roles, so the project's public API keys can't read any data.
5. **Optional:** copy an existing local SQLite database in. Stop the server first, then run:
   ```sh
   npm run db:copy-sqlite -- data/outreach.db
   ```
   It's safe to re-run: existing rows are skipped.
6. **Check it worked.** In the Supabase dashboard, **Table Editor** should list tables such as `campaigns`, `users`, and `sessions`.

If `DATABASE_URL` is empty, the app uses a local SQLite file in `data/` instead. Tests always use SQLite or a local Docker Postgres; they never touch Supabase.

## 2. SMTP (account emails): left to do

The server sends only sign-in emails: email confirmation, password reset, and team invites. Outreach emails are never sent by the server. Until SMTP is set, those emails are printed in the terminal.

Pick one provider.

**Option A: Gmail, the fastest way to test.** It's limited to roughly 500 emails a day, and emails come from that Gmail address.
1. Turn on 2-Step Verification for the Google account (myaccount.google.com → Security).
2. Go to https://myaccount.google.com/apppasswords, create an app password named "Outbound", and copy the 16 characters without spaces.
3. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=<the gmail address>
   SMTP_PASS=<16-character app password>
   MAIL_FROM=Outbound <the same gmail address>
   ```

**Option B: Resend, better for real users.** It needs a domain you control.
1. In Resend, go to **Domains** → **Add domain**, add the DNS records it shows at your DNS provider, and wait until the domain shows **Verified**.
2. Go to **API Keys** → **Create API key** with sending access.
3. In `.env`:
   ```
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=465
   SMTP_USER=resend
   SMTP_PASS=<the API key>
   MAIL_FROM=Outbound <no-reply@your-domain.com>
   ```

Brevo works the same way: host `smtp-relay.brevo.com`, port 587, and the login and SMTP key from **SMTP & API** in Brevo. You verify a single sender address, so no domain is needed.

**Check it works:**
1. Restart with `npm start`. The log should say `account emails sent via SMTP`.
2. On the sign-in page, click **Forgot password?** and enter a real address you can read. The email should arrive within a minute; check spam. Its link must start with your `PUBLIC_URL`.

`npm test` includes a test that delivers through a fake local SMTP server, so the code path is covered. What hasn't been tried yet is a real provider.

## 3. Google sign-in: left to do

1. Go to https://console.cloud.google.com and create a project (or select one).
2. Go to **APIs & Services** → **OAuth consent screen** (shown as "Google Auth Platform" in newer consoles).
   - **Branding:** set the app name ("Outbound"), support email, and developer contact email.
   - **Audience:** choose **External**. While the app is in **Testing**, add each Google account that should be able to sign in under **Test users**.
   - **Data access:** the app only uses `openid`, `email`, and `profile`. These are non-sensitive, so no Google verification review is needed.
3. Go to **Clients** (or **Credentials**) → **Create client** → **Web application**.
   - **Authorized JavaScript origins:** `http://127.0.0.1:4173` and, once deployed, `https://<your-domain>`.
   - **Authorized redirect URIs:** `http://127.0.0.1:4173/auth/google/callback` and, once deployed, `https://<your-domain>/auth/google/callback`.
   - These must match `PUBLIC_URL` exactly. `localhost` and `127.0.0.1` count as different addresses.
4. Copy the client ID and secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<...>
   ```
5. Restart. The log should say `Sign-in: email + password and Google`, and the sign-in page now shows **Continue with Google**.
6. **Check:** sign in with a test-user account. You should land on Home with a new workspace. A Google account whose email matches an existing account is linked to that account.
7. **Before launch:** on the consent screen's **Audience** page, click **Publish app** so any Google account can sign in.

The Google flow is covered by tests against a mock of Google's token endpoint, but it hasn't been run against real Google yet. If you see `redirect_uri_mismatch`, step 3 or `PUBLIC_URL` is wrong.

## 4. Vercel: left to do, and it needs code changes first

**Read this before creating the Vercel project.** The app currently runs as one long-lived Node server. It runs a background job queue (discovery and drafting jobs) and a 30-second scheduler loop inside that process. Vercel runs code as serverless functions that only exist while a request is being handled, so as-is:

- background jobs would stop when the response is sent;
- the daily scheduler would never run;
- SQLite data would be lost, so Supabase is required;
- sign-in rate limits, which are kept in memory, would reset per instance.

**Simpler alternative:** Render, Railway, and Fly.io run the app unchanged as a Node web service. Use `npm start` as the start command, Node 24, and the same environment variables. If Vercel isn't a hard requirement, this is about an hour of work instead of a day.

**Code changes required for Vercel:**
1. **Add `api/index.mjs`.** Create the app once per instance with `workers: false` and pass each request to it:
   `export default async (req, res) => { (await appPromise).server.emit('request', req, res); }`
2. **Run jobs after the response.** Wrap job execution in `waitUntil(...)` from `@vercel/functions`, so jobs started by a request finish after the response is sent. In `server/jobs.mjs`, `enqueue` currently starts jobs with `setImmediate`.
3. **Add `api/cron.mjs`.** It should check `Authorization: Bearer ${CRON_SECRET}`, then call `jobs.drain()` and `runScheduler(...)`. Register it in `vercel.json` under `crons`. Vercel's Hobby plan only allows daily crons, so the Pro plan is needed for a frequent schedule such as `*/5 * * * *`.
4. **Add `vercel.json`.** Serve `dist/` as static files, and rewrite `/api/(.*)`, `/auth/(.*)`, and `/sample-contacts.csv` to the function.
5. **Make schema creation pooler-safe.** In `server/db.mjs` (`openPostgres`), schema creation uses `pg_advisory_lock`, which is session-level. Supabase's transaction pooler can leave that lock held. Wrap schema creation in a transaction and use `pg_advisory_xact_lock` instead, then use the **Transaction pooler** (port 6543) URL with `DATABASE_POOL_SIZE=1` on Vercel.
6. **Optional:** move sign-in rate limits from memory into a Postgres table.

**Then create the Vercel project:**
1. vercel.com → **Add New** → **Project** → import `KhushiSharma22/outreach-app`.
2. **Framework preset:** Other. Leave **Build command** empty. **Output directory:** `dist`.
3. **Settings → General → Node.js Version:** 24.x.
4. **Settings → Environment Variables (Production):**
   - `DATABASE_URL`: the transaction pooler URL
   - `DATABASE_CA_CERT`: the certificate's path. Commit the Supabase CA certificate somewhere public-safe for this, since it isn't a secret, or change the code to accept the certificate's contents in an env var.
   - `DATABASE_POOL_SIZE=1`
   - `PUBLIC_URL=https://<project>.vercel.app`, or your custom domain
   - `SMTP_*` and `MAIL_FROM`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `ANTHROPIC_API_KEY` (optional)
   - `CRON_SECRET`: any long random string
5. Deploy. Then add `https://<domain>` and `https://<domain>/auth/google/callback` to the Google client (section 3, step 3).
6. **Check:** sign up and receive the confirmation email; sign in with Google; import the sample contacts and run discovery. The batch must complete, which proves that background jobs run on Vercel.

## 5. What's left from BACKEND_HANDOFF.md

Most of `BACKEND_HANDOFF.md` is built:

- persistence
- CSV sourcing with evidence and shortfall reporting
- AI qualification and drafting with guards
- approvals tied to exact draft revisions
- manual send tasks
- follow-up sequences with per-recipient enrollment
- metrics from stored records
- workspace isolation and accounts

The rest is below.

### Integrations not built (handoff §6–8)

1. **A real sourcing provider.** Only CSV import works.
   - There's no automated people or company search, no email enrichment, and no email-verification provider.
   - Verification status comes from the imported CSV.
   - Sales Navigator is supported only as a CSV export.
2. **Sending through a connected mailbox.** Sending is manual only: users send from their own mail app and confirm here.
   - There's no Gmail or Outlook OAuth and no provider message IDs.
   - Replies and bounces aren't detected automatically; users record outcomes by hand.
3. **Pre-approved rules mode.** Disabled in the UI and API until there's an agreed, versioned approval policy.

### Partly done

4. **Duplicate-person detection.** Imports merge people by email, LinkedIn URL, or name plus company. The handoff also asks for uncertain matches to be flagged for review rather than merged; that isn't built (`server/sourcing.mjs`, `importCsv`).
5. **Sequence edits.** People already in a sequence keep the version they started with. Moving them onto an edited version, which the handoff calls "explicit migration", isn't supported.
6. **Operations monitoring (§12).**
   - Done: failed background jobs show on Home.
   - Missing: detecting jobs stuck mid-run (they're only retried when the server restarts).
   - Missing: a view of AI spend or budget. Token usage is logged in the `ai_calls` table but not shown anywhere.
   - Missing: per-campaign error alerts.
7. **Security and data handling (§12).**
   - Done: workspace isolation, the audit log, and the workspace-wide sending stop.
   - Missing: data retention and deletion policies, account or workspace deletion, and data export.
   - Missing: sign-in rate limits are kept in memory, so they reset on restart and aren't shared across servers.
8. **Acceptance tests (§14).** Most scenarios are covered. Two aren't:
   - Concurrent edits to the same draft. On Postgres, one save can fail with a raw error instead of the friendly "changed since you loaded it" message (`saveRevision` in `server/drafts.mjs`).
   - Provider failures and uncertain send outcomes. These only apply once mailbox sending exists.

### Setup and deployment

9. SMTP: see section 2.
10. Google OAuth: see section 3.
11. Hosting: see section 4. Vercel needs the code changes listed there first.

### Decisions still open with the product owner (handoff §15)

- **Mailbox sending:** whether to add it, which provider comes first, and what counts as proof a message was sent. Currently it's manual, confirmed by the user.
- **Sourcing:** which provider to use, and the data and enrichment budget.
- **Rules mode:** whether to build it.
- **Defaults to confirm.** These are already in place but the owner should confirm them:
  - the daily target is set per campaign;
  - the sending window is the campaign's daily time on its chosen weekdays;
  - suppression applies across the whole workspace;
  - existing enrollments keep their sequence version.

**Suggested order:** items 4–8 can be done now with no decisions needed. Items 1 and 2 are the biggest product gains, but each needs its decision above first.

## Commands

```sh
npm start              # run the app (loads .env)
npm test               # full test suite on in-memory SQLite (~7 s)
npm run db:local-pg    # once: Postgres 17 in Docker on port 54329
npm run test:pg        # same suite against that local Postgres
npm run test:browser   # sign-up, confirm, reset, and sign-in through real forms in headless Chrome
```

## Known state

- The existing Northstar workspace owner, `maya@northstar.example`, is demo data from an earlier version. Use **Forgot password?** to set a password for it, or ignore it.
- AI features use Claude when `ANTHROPIC_API_KEY` is set; otherwise they fall back to templates. Outreach sending is always manual (send queue).
