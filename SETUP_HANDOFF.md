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

## 3. Google sign-in: disabled for the private pilot

Skip this section for now. During the pilot, Google sign-in is turned off in the code (`googleEnabled()` returns false), whatever the settings. The steps below apply when it's re-enabled after the pilot.


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

## 4. Vercel: code is ready, deployment left to do

The code for Vercel is in place. On Vercel the app runs like this:

- **Requests:** `api/index.mjs` handles every request that isn't a static file. `vercel.json` rewrites them to it, and it reuses the same request handler as `npm start`. `dist/` is served as static files.
- **Background work:** discovery and drafting run after the response is sent, using Vercel's `waitUntil`, within the function's 300-second limit. If a function is cut off mid-job, the job is requeued after 15 minutes.
- **Scheduler:** it's checked at most once a minute when the app is in use. `api/cron.mjs` also runs it daily at 13:00 UTC, protected by `CRON_SECRET`.
- **Supabase:** database setup only runs when the schema changes, under a lock that's safe with Supabase's transaction pooler. The CA certificate can be passed as text in `DATABASE_CA_CERT_PEM`.
- **Sign-in rate limits:** stored in the database, so they apply across instances.

`npm test` covers this locally: rewritten paths, background work after the response, a request body Vercel has already read, cron authorization, and requeuing a job that was cut off. These haven't been tried on Vercel itself yet.

**Steps:**
1. **Transaction pooler URL.** In Supabase, open **Connect → Transaction pooler**. It's the same as the session pooler string but on port **6543**:
   `postgresql://postgres.<project-ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres`
2. **Cron secret.** Run `openssl rand -hex 32` and keep the output.
3. **Import the repository.** vercel.com → **Add New → Project** → import `KhushiSharma22/outreach-app`. If it isn't listed, click **Adjust GitHub App Permissions** and grant access to the repository.
4. **Build settings.** Framework Preset: **Other**. Leave Build Command empty. Output Directory: `dist` (already set in `vercel.json`).
5. **Environment variables (Production):**
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the port-6543 URL from step 1 |
   | `DATABASE_CA_CERT_PEM` | the full text of the Supabase certificate file, from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----` |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | as in section 2 |
   | `ALLOWED_EMAILS` | the approved pilot addresses, comma-separated (empty means nobody can sign in) |
   | `OPERATOR_EMAILS` | the addresses allowed to import leads |
   | `MAILBOX_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`); keep it stable, or saved mailbox connections stop working |
   | `GEMINI_API_KEY` | your Gemini key (optional; enables AI drafting and qualification) |
   | `CRON_SECRET` | the value from step 2 |
   | `PUBLIC_URL` | optional. If unset, the app uses the project's production domain. Set it if you add a custom domain. |
6. Click **Deploy**.
7. **Node version.** Go to **Settings → General → Node.js Version**, choose **24.x**, and redeploy if it was different.
8. **Google.** Add the production address to the Google OAuth client (section 3, step 3):
   - JavaScript origin: `https://<your-domain>`
   - Redirect URI: `https://<your-domain>/auth/google/callback`
9. **Check:**
   - Open the site and sign up. The confirmation email must arrive.
   - Sign in with Google.
   - Load the sample contacts, create a campaign, and run discovery. The batch must finish within a minute or two, which shows background work runs on Vercel.
   - Open **Settings → Cron Jobs** in the Vercel project, run `/api/cron` once by hand, and check that it returns `{"ok":true,...}`.
10. **If something fails,** check **Deployments → (latest) → Logs**:
    - "The service could not start" means a missing or wrong `DATABASE_URL` or certificate.
    - `redirect_uri_mismatch` from Google means step 8 doesn't match the domain.

**Plan limits:**
- Vercel's free Hobby plan allows only a daily cron, which is what `vercel.json` uses.
- Background work after each request doesn't depend on the plan.
- With the Pro plan you can change the cron in `vercel.json` to `*/10 * * * *` for more regular scheduling.
- Check Vercel's current limits for function duration on your plan. `vercel.json` asks for 300 seconds.

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
   - Done: jobs cut off mid-run are requeued after 15 minutes (`JOB_STALE_MS`).
   - Missing: a view of AI spend or budget. Token usage is logged in the `ai_calls` table but not shown anywhere.
   - Missing: per-campaign error alerts.
7. **Security and data handling (§12).**
   - Done: workspace isolation, the audit log, and the workspace-wide sending stop.
   - Missing: data retention and deletion policies, account or workspace deletion, and data export.
   - Done: sign-in rate limits are stored in the database, so they hold across restarts and servers.
8. **Acceptance tests (§14).** Most scenarios are covered. Two aren't:
   - Concurrent edits to the same draft. On Postgres, one save can fail with a raw error instead of the friendly "changed since you loaded it" message (`saveRevision` in `server/drafts.mjs`).
   - Provider failures and uncertain send outcomes. These only apply once mailbox sending exists.

### Setup and deployment

9. SMTP: see section 2.
10. Google OAuth: see section 3.
11. Hosting: see section 4. The code is ready; the Vercel project still needs to be created.

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
- AI features use Gemini when `GEMINI_API_KEY` is set (or Claude with `ANTHROPIC_API_KEY`); otherwise they fall back to templates. Outreach sending is always manual (send queue).
