# Outreach app — frontend summary and backend handoff

Prepared 21 October 2026 from the current implementation. This document describes existing code separately from proposed backend work. `PRD.md` is an earlier product plan and predates several frontend changes; use this handoff and the current UI when reconciling scope.

## 1. Product and current status

The product is an email-first outbound campaign workspace. A customer supplies company context, describes or configures their ideal customer, discovers relevant prospects, reviews personalized email drafts, approves a campaign, and tracks its progress. After launching an initial campaign, they can create and approve a separate follow-up sequence.

The frontend prototype is implemented. It is a runnable, interactive demonstration, not a functioning outreach service. No actual research, email verification, LLM calls, mailbox connection, scheduling, or delivery happens. Data is held in browser memory and disappears on refresh. Sample contacts and `.example` addresses are fictional.

Earlier discussions included LinkedIn messaging, but the implemented journey is email-first. Sales Navigator appears as a potential sourcing option, not a working integration. Automated LinkedIn outreach is not part of this backend MVP.

**Important scope decision:** the user previously chose manual sending. The current UI subsequently introduced schedules and launch controls, but these only simulate execution. Confirm whether the first real backend should produce manual send tasks or send through a connected mailbox. Until decided, implement manual delivery as the default and keep automatic sending disabled. Approving content and authorizing delivery are separate actions.

## 2. Run and understand the code

Repository: https://github.com/KhushiSharma22/outreach-app

From the repository directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Preview: http://127.0.0.1:4173

The app uses vanilla JavaScript, HTML, and CSS. There is no framework build step or package manifest. Despite its name, `dist/` currently contains editable application source.

- `dist/index.html`: application entry point.
- `dist/style.css`: styling and responsive layouts.
- `dist/app.js`: screens, navigation, event handlers, and mutable UI state.
- `dist/model.js`: fictional records, template-based email generation, and client-side validation.
- `tests/flow.test.cjs`: Node-based model and screen-render checks with a stubbed browser environment.
- `README.md`: local setup and scope.
- `PRD.md`: historical product requirements.

The existing checks passed during this handoff: screen rendering, quality shortfall handling, draft approval and schedule gates, sequence approval/launch, sequence day ordering, and structured filter context. These are prototype checks; they do not establish production delivery or integration correctness.

## 3. What the frontend already supports

### Company context

The Company Context screen captures company name, website, offering, ideal customer profile, proof points, default tone, sender name/email, signature, and exclusions. This is a form backed by in-memory state. Entering an email address does not connect or verify a mailbox.

### Home assistant and campaign creation

The home page accepts a campaign description and offers a path into campaign creation. The assistant response is fixed UI behavior; it does not interpret intent with an LLM. Manual campaign creation is also available.

The campaign wizard has six stages: Campaign Brief, Lead Discovery, Review Leads, Email Studio, Schedule, and Launch.

### Structured campaign brief

Users can edit the campaign name and offering and choose targeting filters for roles, industries, locations, company sizes, seniority, and exclusions. Custom options and notes are supported. The UI describes OR matching within a filter group and AND matching across groups. Today these choices generate a readable audience summary; they do not run a real search.

Backend implementation should preserve the original assistant request and explicit filters separately. Do not silently replace a customer's prompt with default filter values.

### Discovery configuration

Users choose AI research or Sales Navigator, provide a source reference, select signals such as hiring, funding, new leadership, or expansion, set signal freshness, select a daily target between 25 and 30, and adjust a quality threshold. The default target is 28 and default quality threshold is 80.

Discovery currently produces fixed sample records. A normal sample contains 30 candidates, of which 26 meet the default eligibility rules. A shortfall preview returns fewer candidates. Source choice, signals, and filters are not connected to a provider.

### Lead review

The review screen separates qualified, needs-review, and excluded records; supports search and pagination; shows sample qualification evidence; and lets users select or exclude prospects. Eligibility currently checks the sample status, score, and presence of an email. A displayed verification label is not evidence of a real email verification check.

### Email studio and approvals

Users can review each selected recipient, edit subject and body, choose tone, length, and personalization angle, use rewrite controls, approve individually, or approve in bulk through a confirmation flow. Editing a draft clears its approval. Changing shared writing settings invalidates drafts.

Messages are assembled from JavaScript templates, not generated by an LLM. The evidence panel is also sample data. The intended backend behavior is one personalized, reviewable draft per selected lead.

### Scheduling, launch, and tracking

The UI captures weekdays, local time, timezone, and daily-review versus pre-approved-rules preferences. Launch checks required campaign information, selected prospects, approved nonempty drafts, and schedule fields.

Campaign views include overview, current leads, activity, pause/resume, and demonstration controls for the next day, sends, and replies. Historical metrics are hardcoded; other counts come from browser state. No background jobs exist. The simulated reply action displays a follow-up-stop message but does not cancel an actual recipient enrollment.

### Follow-up sequences

The Sequences screen is available for launched campaigns. It starts with follow-ups on days 1, 3, 5, and 7, with day 0 representing the initial email. Users can edit content and day offsets, add or remove steps, change tone, preview personalization, approve steps, and launch or pause the sequence.

The current editor allows up to eight steps, with unique increasing integer offsets from day 1 to day 90. Supported merge fields are `{{first_name}}` and `{{company}}`. Editing an active sequence returns it to draft and clears approvals.

The UI describes recipient eligibility and stopping on replies, bounces, or opt-outs. Those are requirements for the backend, not implemented execution logic. A sequence is currently one shared template per step, with a recipient preview; it is not a store of individually generated follow-up messages.

## 4. Backend architecture proposal

Start with a modular monolith: one API service, a relational database, and background workers backed by a durable job queue. PostgreSQL is a reasonable database choice. The backend language/framework can follow the developer's experience; the frontend does not require a particular stack.

Use modules for workspace/company context, campaigns, sourcing, qualification, drafting/approvals, delivery, sequences, and reporting. Keep providers behind adapters so research, enrichment, LLM, and mailbox vendors can change without changing campaign semantics.

Browser → API → database is the normal read/write path. API → durable queue → workers handles research, email enrichment, qualification, drafting, scheduled runs, and delivery. Provider webhooks or reconciliation workers update message outcomes.

Keep all provider credentials server-side. For private development, a seeded workspace is sufficient; before deployment to real users, add authentication, authorization, and workspace isolation. The existing no-auth decision was for visualizing the frontend, not permission to expose customer data publicly.

## 5. Data model to implement

Use server-generated stable IDs and timestamps. Do not carry forward `Date.now()` identifiers or array position as identity.

- **Workspace and users:** ownership, roles, membership, access boundaries.
- **Company context versions:** offering, ICP, proof, tone, exclusions, sender preferences. Campaigns reference a snapshot so future account edits do not silently change approved messages.
- **Mailbox:** provider identity, connection status, granted permissions, encrypted token references, sender identity, last synchronization, and connection errors. A typed sender address is not a mailbox connection.
- **Campaign and configuration versions:** original prompt, normalized filters, offering, source configuration, signals/freshness, target, qualification policy, writing preferences, delivery mode, schedule, timezone, approval policy, and lifecycle state.
- **Discovery run and batch:** campaign/configuration version, scheduled occurrence, provider run IDs, progress, costs, candidate counts, qualified counts, shortfall reason, and failure state. Preserve all batches.
- **Company and contact:** normalized identity, provider IDs, profile URL, employer, role, and email records. Store email verification provider, status, and checked-at time separately.
- **Evidence:** source URL/reference, observed fact, collected-at date, event date where known, and provenance. Store only necessary data with an appropriate retention policy.
- **Campaign lead:** contact-to-campaign association, batch, qualification decision, score/explanation, evidence references, selection/exclusion, and reason. One contact can be associated with multiple campaigns without duplicating its canonical identity.
- **Message draft and revision:** recipient, campaign/batch, step, subject/body, context and evidence versions, generation metadata, and current revision.
- **Approval:** approving actor or rule, exact approved revision/hash, timestamp, and invalidation reason. A boolean on a mutable draft is insufficient.
- **Sequence version and steps:** offsets, templates, order, revision, approvals, and status.
- **Enrollment and step execution:** one recipient's progress, initial-send anchor, pinned sequence version, next due time, pause/stop reason, and execution state.
- **Message and conversation:** provider message/thread IDs, recipient, immutable sent content, accepted/sent/delivered timestamps when available, outcome, and attribution.
- **Suppression, audit, and event records:** opt-outs, bounces, manual exclusions, changes, launches, approvals, failures, and provider events.

Use database uniqueness constraints for scheduled occurrences, provider event IDs, campaign/contact membership where appropriate, and recipient/sequence-version/step executions. Store UTC instants alongside the relevant IANA timezone for scheduling.

## 6. Sourcing and qualification pipeline

This is the largest unresolved integration area. An LLM alone is not a reliable people database, email finder, or email verifier.

The intended pipeline is:

1. Convert campaign context into a validated structured search brief.
2. Retrieve candidate people and companies through an authorized data source or a supported import.
3. Resolve identities and deduplicate candidates against previous batches and existing contacts.
4. Retrieve supporting company/contact signals and retain their evidence.
5. Discover email addresses through an enrichment provider where necessary.
6. Verify email usability through a verification provider; represent unknown or catch-all results explicitly.
7. Apply deterministic exclusions and required filters.
8. Ask the LLM to assess contextual relevance using retrieved evidence, with a structured response and explicit uncertainty.
9. Save qualified, review-needed, and excluded outcomes with reasons.
10. Select up to the configured daily target and expose a shortfall if quality is insufficient.

Treat 25–30 as the desired daily qualified volume, not a license to invent or pad records. A batch below 25 should remain usable with a visible explanation. Clarify whether the target applies per campaign or across the workspace; the current UI configures it per campaign. Research may inspect more candidates than the final target, subject to cost limits.

For **AI research**, choose actual search/data and enrichment providers after evaluating coverage, usage rights, quotas, and cost. Do not promise that free tools can supply dependable production coverage.

For **Sales Navigator**, treat the saved-search/reference field as a product input until a supported integration is selected and verified. Do not assume a subscription provides an unrestricted API, export, or email addresses. People discovery and email enrichment are separate capabilities. A supported user-provided import is a practical initial path; reject unsupported formats with actionable feedback. Do not build session-cookie collection or scraping into this MVP by default.

## 7. AI responsibilities

AI can interpret the home-page brief, suggest targeting filters, assess lead fit, summarize evidence, generate recipient-specific messages, and rewrite drafts. Implement these as separate operations with structured outputs and traceable inputs.

Use a context precedence rule: explicit campaign choices override account defaults; existing approvals remain attached to their original revisions. Have the user confirm ambiguous assistant interpretations rather than silently selecting a different audience.

Qualification output should include decision, rationale, supporting evidence IDs, missing information, and confidence. A model-generated numerical score must be calibrated and explainable; it must not override hard exclusions or invalid email status.

Draft generation uses the account snapshot, campaign offering, lead facts, approved proof points, and requested writing preferences. Validate the response schema and content length. Do not invent funding events, hiring signals, relationships, customer claims, or missing recipient details. If evidence is weak, use a factual generic opening or request review.

Research text is untrusted input: instructions found on a website must not control prompts, tools, or delivery. Log model/prompt versions, latency, and cost without unnecessarily exposing personal data. Support retries, budget limits, and user-visible failures. An LLM error must never trigger a send.

## 8. Approvals and delivery

All important validation must run on the backend. The browser's launch gates are for usability and can be bypassed.

For daily approval, generate a batch and drafts, move it to awaiting review, record approvals against exact revisions, and release only eligible approved messages. Bulk approval must identify the exact drafts/revisions being approved; reject stale requests if content changed.

Pre-approved-rules mode needs an explicit, versioned policy defining eligible sources, evidence/quality requirements, writing constraints, and fallback-to-review conditions. The prototype simply sets approval booleans for the next batch; that is not sufficient for production. Consider shipping daily approval first and retaining rules mode as unavailable until its behavior is agreed and implemented.

**Manual delivery MVP:** create due send tasks with recipient, approved content, and a compose/copy action. Distinguish user-confirmed sending from provider-verified sending. Without mailbox synchronization, replies, bounces, and deliveries cannot be automatically known; provide manual updates and label metrics accordingly.

**Connected-mailbox delivery, if approved:** implement OAuth for one provider first, secure token refresh/revocation, send and conversation synchronization, and provider-specific error handling. Verify current provider requirements and quotas during integration. Use conservative configurable limits; there is no universal daily number that guarantees deliverability.

Create a durable delivery/outbox record before dispatch. Deduplicate attempts, reconcile uncertain provider outcomes, and never blindly retry a timeout that may already have sent a message. Recheck approval, suppression, campaign/sequence pause state, mailbox availability, and recipient eligibility immediately before delivery.

## 9. Scheduling and follow-up execution

Discovery, content approval, and sending are distinct stages. A scheduled run creates work; it must not imply that new drafts are approved. Persist each occurrence so worker retries do not create duplicate daily batches.

Honor weekdays, timezone, and daylight-saving changes. Define what happens after downtime and schedule edits. Avoid releasing a backlog in a burst. Pause should block future dispatch while preserving history; a message already accepted by a provider may not be retractable.

For sequences:

- Enroll a recipient only after the initial email is actually sent or explicitly confirmed sent in manual mode. Define that timestamp consistently.
- Day 1/3/5/7 offsets are relative to that recipient's initial send, not campaign creation or sequence launch.
- Calculate a due instant from the calendar-day offset and agreed sending window. Document weekend and timezone behavior before implementation.
- When a sequence is added late, hold overdue steps for review instead of immediately sending all missed messages.
- Support both existing eligible recipients and new daily batches according to an explicit enrollment policy.
- Stop future steps on reply, opt-out, hard bounce, manual exclusion, or another terminal state. Check again at dispatch to handle races.
- Pause and resume without duplicating completed steps or bypassing fresh eligibility checks.
- Pin enrollments to an immutable sequence version. Editing requires reapproval; decide whether existing enrollments keep the old version or are explicitly migrated.
- Validate supported placeholders and missing values before approval and again before dispatch. For per-recipient AI follow-ups, approval must cover the rendered/generated message rather than only a shared template.

Do not treat the UI's `sequence.status = active` as a scheduler. The backend needs recipient-level state and durable step executions.

## 10. Proposed API surface

These routes are a starting contract, not endpoints already present. Scope every request to the authenticated workspace or a protected development workspace.

- `GET/PATCH /account-context`: retrieve/save company context and return its version.
- `POST /campaign-briefs/interpret`: turn assistant input into an editable structured brief.
- `GET/POST /campaigns` and `GET/PATCH /campaigns/:id`: campaign CRUD with configuration versions.
- `POST /campaigns/:id/discovery-runs`: start asynchronous discovery; return run ID.
- `GET /runs/:id`: progress, status, errors, and result references.
- `GET /campaigns/:id/batches` and `GET /batches/:id/leads`: persistent batch history and filtered/paginated prospects.
- `PATCH /campaign-leads/:id`: select, exclude, or update an allowed review decision.
- `POST /batches/:id/draft-runs`: generate drafts for selected eligible leads.
- `GET/PATCH /drafts/:id` and `POST /drafts/:id/rewrites`: fetch/edit/version or request a rewrite.
- `POST /approvals`: approve explicit draft IDs and revisions, individually or in bulk.
- `POST /campaigns/:id/launch`, `/pause`, and `/resume`: validate transitions and create durable work.
- `GET/PUT /campaigns/:id/schedule`: read/update versioned scheduling preferences.
- `GET/POST /campaigns/:id/sequences`, `PATCH /sequences/:id`, and sequence approval/launch/pause/resume actions.
- `GET /campaigns/:id/metrics` and `/events`: real aggregates and paginated history.
- `GET /send-tasks` and `POST /send-tasks/:id/confirm-sent`: manual-mode workflow.
- Mailbox OAuth/connect/disconnect endpoints and verified provider event endpoints only when connected delivery is in scope.

Use idempotency keys on operations that can create work or dispatch messages. Use expected revisions for edits, approvals, and launch; return a conflict when stale. Return machine-readable error codes and helpful field messages. Long-running actions should return promptly and expose progress via polling or server-sent events. Bulk responses must make partial failures clear.

## 11. Where frontend integration happens

- `sendChat()` becomes brief interpretation, with loading, failure, and clarification states.
- `newCampaign()` and the model's `campaign()` become persisted draft creation/loading.
- `saveAccount()` saves a versioned company context; mailbox connection remains a separate flow.
- `syncAudience()` updates structured configuration. Replace its destructive clearing of leads/drafts with explicit revision handling and impact confirmation.
- `discoverBatch()` calls the discovery API and displays job progress instead of a timer and fixtures.
- `M.discover()` is removed from production paths; it can remain in a clearly separated demo mode.
- `M.draft()` and rewrite handlers call generation/revision endpoints instead of template substitution.
- Approval handlers save revision-bound approvals and display conflicts or partial failures.
- Launch, pause, and resume call server transitions and render returned state.
- `simulateDay()`, `simulateSend()`, and `simulateReply()` stay demo-only and disappear from the live workspace.
- `sequenceFor()` and `launchSequence()` use stored sequence versions, approvals, and enrollment state.
- Tracking views render API metrics and events; the current All Leads screen needs a proper contact/campaign-lead query if a unified directory is desired.

Introduce an API client and explicit loading/error/empty states before wiring each screen. Avoid a full frontend rewrite solely to connect APIs, but consolidate duplicate function definitions and global state handling. Current HTML string rendering assumes trusted fixtures in places; escape untrusted values consistently or move to safe DOM rendering before showing provider/LLM data.

## 12. Reporting, security, and operational requirements

Replace sample counters with persisted events and defined denominators. Distinguish candidates discovered, leads qualified, selected recipients, drafts approved, messages queued, provider-accepted sends, confirmed deliveries where available, replies, bounces, opt-outs, and meetings. Meetings need a manual action or calendar/CRM integration; do not infer them from replies. Avoid promising reliable opens or deliveries when the provider does not expose them.

Enforce workspace isolation on every endpoint and job. Encrypt mailbox credentials, keep secrets out of the browser and repository, validate provider webhook authenticity using provider-supported mechanisms, deduplicate events, and audit approvals and delivery actions. Apply retention/deletion policies to prospect evidence and contact data. Maintain suppression across campaigns in the appropriate workspace scope.

Provide structured logs, job tracing, retry limits, dead-letter handling, budget/usage monitoring, and a global sending stop control. Surface mailbox disconnection, provider quota exhaustion, research failure, and stuck jobs in the UI.

## 13. Recommended delivery order

1. **Foundation and persistence:** API, database, seeded development workspace, company context, campaign CRUD, filters, batch history, frontend API client. Refreshing the browser must preserve work.
2. **One real sourcing path:** supported import or chosen provider, identity resolution, enrichment/verification, deterministic filtering, evidence, and shortfall handling.
3. **AI and approvals:** brief interpretation, contextual qualification, personalized generation, edits/rewrites, immutable revisions, individual and bulk approvals.
4. **Initial delivery:** ship manual send tasks first unless connected delivery is explicitly selected; integrate one mailbox provider if selected. Implement idempotency and suppression before real sends.
5. **Daily scheduling and sequences:** durable occurrences, recipient enrollment, due steps, pause/resume, reply/bounce/opt-out stops, and overdue-step handling.
6. **Reporting and release readiness:** real events/metrics, authentication and tenancy for external users, recovery tests, monitoring, and data handling controls.

The first end-to-end backend milestone should be deliberately small: create one persistent campaign, load real authorized contacts, qualify them with evidence, generate personalized drafts, approve exact revisions, and complete manual sending tasks. This validates the core product before autonomous daily execution.

## 14. Acceptance scenarios

- A campaign, its context, selected leads, and edited drafts survive refresh and server restart.
- Two discovery runs do not repeatedly add the same prospect; earlier batches remain visible.
- Insufficient qualified leads produce a shortfall, not fabricated contacts or relaxed exclusions.
- Missing/invalid email or suppressed recipients cannot proceed to delivery.
- LLM output cannot create unsupported prospect facts or override hard exclusions.
- Editing a draft after approval prevents delivery until the new revision is approved.
- Repeated launch requests or worker retries do not create duplicate work or duplicate messages.
- Manual confirmation is distinguishable from a provider-confirmed send in the UI and metrics.
- A recipient's follow-ups use their own initial-send timestamp; unsent recipients are not enrolled.
- A reply or opt-out received before dispatch stops the next follow-up even if it was already queued.
- Paused campaigns/sequences do not dispatch; resuming does not burst overdue steps.
- Sequence edits preserve history and follow an explicit version/enrollment migration policy.
- Mailbox/token/provider failures leave recoverable states with clear user-facing errors.
- Timezone, daylight-saving, concurrent approval edits, and uncertain send outcomes are covered by integration tests.
- Users cannot read or mutate another workspace's contacts, campaigns, messages, or provider connections.

## 15. Decisions to resolve with the product owner

Before implementing delivery, agree manual versus connected-mailbox sending, the first mailbox provider if applicable, and what constitutes proof of a send. Before sourcing, select the first authorized provider/import flow and a realistic data/enrichment budget. Confirm daily target scope, rules-mode availability, sequence enrollment/version behavior, sending-window semantics, and suppression scope.

The frontend establishes the journey and interaction design. The backend must now make that journey persistent, evidence-based, correctly approved, and reliable at the recipient level.
