# Outbound QA checklist

Updated: 6 November 2026. Scope: private access, onboarding, campaign creation, prepared research, customer CSV imports, personalised drafts, approval, SMTP/manual delivery, follow-ups, reporting and super-admin workflows.

Use a separate QA workspace and inboxes you control. Do not send test outreach to real prospects. Unchecked boxes are manual tests to perform, not claims of validation. Record environment, commit, tester, date and evidence for each failure. Run the production gate on the deployed PostgreSQL environment as well as locally.

## 1. Test setup and release gate

- [ ] Record the commit under test and the local or deployed URL. Confirm the updated frontend and backend are from the same release.
- [ ] Prepare one super-admin, two allowed customer accounts in different workspaces, and one non-allowed email address.
- [ ] Prepare a campaign with explicit roles, location and size, and no optional signals. Prepare another campaign requiring a dated signal.
- [ ] Use controlled email addresses and sourced test facts; mark email_status=valid only when verification is genuine.
- [ ] Prepare CSVs containing: valid matching contacts; wrong role/country/size; missing targeting fields; invalid email; unverified email; duplicates; existing opt-outs; blank last names; research facts/URLs; quoted commas and Unicode.
- [ ] Run `npm run check` and `npm test` using Node 24 or newer. Record totals and failures.
- [ ] Run `npm run test:pg` against a disposable PostgreSQL database; never point the test database at customer production data.
- [ ] Restart against an existing database. Confirm new tables are created without losing accounts, contacts, campaigns, approvals or mailbox connections.
- [ ] Confirm `.env`, credentials, local databases and logs are not tracked in Git. `.env.example` contains placeholders only.
- [ ] Vercel: configure backend variables in the intended environment and redeploy. Confirm the deployed API works, including after a cold start.

## 2. Access and company onboarding

- [ ] An allowed email can sign up and log in using email/password; a non-allowed email cannot.
- [ ] Google sign-in is unavailable. Wrong-password errors do not expose account details.
- [ ] Local verification bypass works only in the intended local configuration. Production requires its configured verification flow.
- [ ] Sign out, sign in, password reset and session expiry work.
- [ ] Revoking access blocks existing sessions as well as new logins.
- [ ] Customer A cannot read or change customer B's campaign, contacts, drafts, sources, imports or mailbox through URL/API changes.
- [ ] Onboarding follows Company context → Email setup. Saved context survives refresh.
- [ ] Context includes offering, ICP, proof points and complete signature. A campaign pins its context version; changing company context does not silently rewrite approved emails.

## 3. SMTP setup

- [ ] Approved SMTP hostname/port with valid provider credentials connects. Unapproved host/port is rejected.
- [ ] Invalid credentials return a useful error and preserve the previous working connection.
- [ ] Connection test reaches only the configured, controlled test inbox.
- [ ] Reloading email settings does not return the password to the browser. Inspect network responses and logs for accidental secret exposure.
- [ ] Credentials are encrypted in storage; a missing encryption key produces an operator configuration error.
- [ ] Missing sender identity/postal address or other required fields blocks completion with clear guidance.
- [ ] A working public HTTPS unsubscribe URL is configured before any real SMTP campaign test.

## 4. Campaign creation and configuration

- [ ] Create a campaign manually and from the home-page assistant. Both reach the same editable flow.
- [ ] Assistant interpretation preserves the request, proposes relevant filters and asks for clarification instead of silently inventing restrictions.
- [ ] Empty or overly long assistant requests fail clearly; no leads are discovered or messages sent just by submitting a brief.
- [ ] Verify roles, industries, locations, size, seniority, exclusions and optional signals save and survive reload.
- [ ] Alternatives within a group match with OR; different groups match with AND. Missing required data never counts as a match.
- [ ] Target is bounded to 1–30. Notes guide writing but cannot override exclusions or filters.
- [ ] Concurrent edits return a conflict/reload instead of silently overwriting changes.

## 5. Super-admin weekly research upload

- [ ] Only a super-admin sees and can call the research management endpoints. Ordinary customer and operator accounts receive access denied.
- [ ] Super admin → Weekly research leads lists customers by workspace and owner email.
- [ ] Choosing a customer restricts the campaign selector to that workspace. Changing customer clears the previous campaign/file preview.
- [ ] An empty campaign list gives clear instructions to create a customer campaign first.
- [ ] Download and open the research template; replace its example row. General company observations use research_fact and research_url; event evidence uses signal/date fields.
- [ ] Select the campaign and UTC availability date, then choose a CSV. Preview displays filename, sample rows, valid count, duplicates and errors.
- [ ] Preview alone does not import contacts or consume customer quota.
- [ ] Missing headers, malformed rows, invalid addresses, files over 5 MB and files over 150 rows receive clear errors. Direct POST requests enforce validation too.
- [ ] Confirm shows the exact customer, campaign and availability date. The date/file/selection survive normal UI rendering.
- [ ] Final upload reports matching contacts, qualification rejections and import issues. No emails are sent.
- [ ] Uploaded contacts belong to the intended customer's workspace and campaign, not the admin's workspace or a different customer's campaign.
- [ ] Unverified contacts do not become ready research. Wrong targeting, exclusions and suppression remain authoritative.
- [ ] Future-dated supply remains unavailable until its UTC date. Invalid dates and stopped campaigns are rejected.
- [ ] Re-uploading contacts does not create duplicates or make previously claimed contacts eligible again.

## 6. Customer Research Leads journey and limits

- [ ] New campaign sourcing offers Research Leads and Import your own contacts. No internal seeding/upload mechanics appear in the customer sourcing screen.
- [ ] Research availability reflects the selected campaign's prepared list and current filters.
- [ ] Requesting leads returns up to the target, never more than 30. Fewer available contacts produces an honest shortfall.
- [ ] A request with no matching supply consumes no research allowance.
- [ ] Allocate two contacts against target 30, replenish, and request again: only the remaining 28 can be allocated that day.
- [ ] Once research is allocated for one campaign, a second campaign in that workspace cannot allocate research that UTC day. A separate workspace remains independent.
- [ ] Simultaneous requests and repeated clicks cannot double-allocate contacts or exceed the daily cap. Test with separate clients against PostgreSQL.
- [ ] Five research days in a Monday–Sunday UTC week exhaust that week's allowance; the next UTC week renews it. Test using an isolated fixture/clock, not by editing production quota rows.
- [ ] Already claimed contacts do not return across campaigns or source changes.
- [ ] Changed filters and new unsubscribes are rechecked; previously prepared leads are not automatically trusted.
- [ ] Discovery makes no LLM assessment requests. Decisions and scores are rules-based, even with Claude enabled.
- [ ] Refresh or job retry preserves the batch without duplicate leads. Errors surface clearly and do not silently show an old result as a new batch.

## 7. Customer CSV import

- [ ] Import your own contacts shows one file chooser and a downloadable customer template.
- [ ] Required headers: first_name, last_name, email, company; header order can vary and last-name values may be blank.
- [ ] Preview supports quoted commas, Unicode and a BOM. It reports invalid rows and duplicate email rows.
- [ ] Invalid rows block confirmation. A valid file imports only after explicit confirmation.
- [ ] The filename remains visible after preview. Choosing a new file replaces the old preview.
- [ ] New contacts link only to the selected campaign. Re-importing the same email updates rather than duplicates it.
- [ ] Customer-supplied verification/evidence fields cannot turn an unverified contact into trusted research.
- [ ] Customer imports do not consume the research allowance. Each review run processes up to the campaign target.
- [ ] Review my contacts is disabled when no new uploaded contacts are available; Create emails is disabled until qualified leads are selected and discovery has finished.
- [ ] Qualified, Needs review, Excluded and All leads tabs show correct counts and explanations. Invalid/suppressed contacts cannot be manually promoted past hard checks.

## 8. Claude campaign interpretation and email writing

- [ ] Configure Claude credentials and an available model in server environment settings, restart/redeploy, and make a controlled live draft request. Mocked provider tests alone do not validate real account/model access.
- [ ] The interface identifies the live provider correctly. Offline mode/fallback is labelled rather than presented as live generation.
- [ ] An initial email uses the actual first name, company, offering, campaign notes, ICP and selected writing preferences.
- [ ] A company research fact with no event signal reaches drafting and can inform the opening. Inspect saved evidence references.
- [ ] Each email uses at most one relevant supported observation and connects it naturally to the offering, with one low-pressure CTA.
- [ ] Missing research yields restrained company/role copy and a review note, not invented website observations or claims about absent staff, poor performance or pain points.
- [ ] Old/undated events are not described as recent. A source URL alone is not presented as a visited or audited website.
- [ ] No fake familiarity, generic praise, deceptive Re:/Fwd: subject, fabricated numbers, guarantees or invented booking links.
- [ ] Body is under 140 words excluding the exact complete signature. No unresolved placeholders remain.
- [ ] Humanise, Shorten and More direct preserve supported personalisation and the signature; they do not replace a specific draft with an unrelated pitch.
- [ ] Research containing instructions or closing-tag text remains untrusted data and cannot alter system behavior.
- [ ] Malformed output, unsupported signal claims, excessive length or incomplete signature are handled without a broken draft screen; fallback/review status is visible.
- [ ] Wrong API key produces a clear configuration error. Temporary provider failures follow the configured retry/fallback behavior.
- [ ] AI call logs record provider/model/operation metadata without API keys or raw prompts. Inspect error logging too.

## 9. Draft review, approval and launch

- [ ] Generate drafts for selected qualified leads only. Review recipient, subject, body, evidence and limitations.
- [ ] Edit one draft and confirm the exact saved version is displayed after reload.
- [ ] Approve individually and in bulk. Bulk approval requires explicit review confirmation and reports partial failures.
- [ ] Editing/rewriting an approved draft clears approval and cancels stale queued sending. Recipient changes also invalidate approval.
- [ ] Missing approvals block launch. Repeated launch requests do not create duplicate tasks.
- [ ] Schedule timezone, days and times save correctly. Verify a boundary around midnight and a daylight-saving transition where applicable.
- [ ] Launch creates the expected tasks and tracking view; discovery/drafting/upload alone never sends outreach.

## 10. Sending, opt-outs and follow-ups

- [ ] Manual copy/open-in-mail actions use the approved recipient and exact draft. I sent this records user-confirmed delivery, not SMTP proof.
- [ ] Send via SMTP sends once to a controlled inbox, includes sender information and a working HTTPS unsubscribe link, and records the result.
- [ ] Double-click/retry after success does not send a second copy. Test provider failure and ambiguous timeout handling before relying on retries.
- [ ] Missing public HTTPS configuration blocks SMTP sending with an actionable message.
- [ ] Open the unsubscribe link without logging in. Confirm suppression persists and cancels pending initial/follow-up tasks for the address.
- [ ] Re-importing, switching campaigns or re-running discovery cannot restore an opted-out address. Repeat unsubscribe is harmless.
- [ ] Stop all sending blocks further sends. Pausing/stopping a campaign prevents its scheduled work as intended.
- [ ] Create/edit day 1/3/5/7 follow-ups, approve exact wording and launch. Follow-ups remain templates, not AI-generated sequences in this release.
- [ ] Follow-ups are scheduled relative to the recorded initial send and respect suppression, stop/reply status and approval.
- [ ] Without inbox sync, required inbox-check confirmation is enforced. SMTP alone must not claim automatic reply or bounce detection.

## 11. Tracking, compatibility and usability

- [ ] Campaign counts reconcile with lead decisions, approved drafts, pending tasks and recorded sends. Re-running discovery does not inflate counts.
- [ ] Historical campaigns remain usable; old import-source campaigns retain compatibility until their source is changed. Test switching to either new source explicitly.
- [ ] Reload, browser back/forward and direct campaign/admin URLs work after sign-in.
- [ ] Customer pages do not reveal super-admin controls or other customer data.
- [ ] Test desktop and narrow/mobile layouts, keyboard navigation, upload controls, disabled actions and error messages.
- [ ] On Vercel, confirm static CSV template downloads, authenticated API routing and queued-job completion after the HTTP response.

## Sign-off

- [ ] Automated checks passed for the release commit.
- [ ] SQLite and PostgreSQL results recorded; concurrent quota behavior verified on PostgreSQL.
- [ ] Live Claude draft and controlled SMTP send verified independently.
- [ ] Unsubscribe and tenant isolation verified on the deployed environment.
- [ ] All blocking defects resolved; remaining limitations recorded with owners.

Known boundaries: no live web discovery, no automatic research-URL fetching, no LLM lead-fit scoring, no AI follow-up generation, and no automatic reply/bounce detection through SMTP alone. Supplying an API key is separate from deploying code. Manual/live checklist items remain unverified until a tester records their results.
