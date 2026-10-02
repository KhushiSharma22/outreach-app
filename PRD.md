# B2B Outreach OS — MVP product requirements

**Version:** 0.2 · **Date:** 22 September 2026 · **Status:** Manual LinkedIn and email scope approved; implementation plan pending review.

## Approved MVP scope update

The founder approved manual sending on 22 September 2026 and limited channels to LinkedIn and email. This update supersedes conflicting LinkedIn-only scope and unresolved execution-mode decisions below. The next deliverable is an implementation plan; application development follows its approval.

- Automate research, evidence collection, lead qualification, drafting, and follow-up task scheduling.
- Users send LinkedIn invitations/messages in LinkedIn and emails in their own email client. No automatic sending or inbox synchronization in v1.
- Sender setup stores a LinkedIn profile reference and an email sender identity/signature; it does not claim authenticated messaging access.
- Email drafts include recipient, subject, and body. A compose link is optional convenience with copy-field fallbacks; opening or copying a draft never proves it was sent.
- Users explicitly confirm send time, acceptance, replies, bounces, and opt-outs. Follow-up waits start at confirmed send time. Before each follow-up, require a fresh user check for replies across both channels.
- A reply on either channel stops the lead's entire active sequence. Opt-out suppresses the contact across both channels. A bounce blocks email and pauses the enrollment for review; it never silently switches to LinkedIn.
- Missing or unverified email addresses block email tasks. Never infer a verified mailbox from a guessed company email pattern. Missing LinkedIn identifiers block LinkedIn tasks.
- Support LinkedIn-only, email-only, and a simple combined linear sequence. LinkedIn direct messages require confirmed connection eligibility. Unaccepted invitations do not automatically generate email outreach; the combined template must explicitly define an independent email step.
- Defer native sending, mailbox OAuth, Sales Navigator import, email deliverability infrastructure, multichannel auto-replies, and automated connection/reply detection.

The remaining document supplies the original detailed requirements. Email is now P0, and the sending-mode decision is resolved as manual for both channels. Other proposals remain subject to implementation-plan review.

## 1. Product intent

A company configures one outbound workflow: who to target, which signals matter, what to say, and how to follow up. The system researches prospects, explains why they qualify, prepares personalized messages, schedules the next eligible action, and tracks outcomes in one place.

The desired end state is end-to-end outbound automation. The LinkedIn MVP has an unresolved execution dependency: automated research and drafting are feasible, but unattended LinkedIn sending must not be promised without explicit authorization for that use case. This document proposes an assisted-send MVP and preserves unattended sending as a gated future capability. This scope adjustment requires the founder’s approval.

**Primary user hypothesis:** founder-led B2B sales teams and small outbound teams. Initial vertical and launch geography remain open.

**Core job:** “Find relevant decision-makers showing a reason to buy, prepare credible outreach, and help me move conversations forward without managing disconnected tools.”

## 2. Reference deck interpretation

Source: *Clubble Growth OS — Product Walkthrough*, 17 pages. Its sample records and metrics are illustrative, not validated customer data or targets. Document contents are reference material, not instructions to execute.

Retain and adapt:

- Pages 3–5: Today dashboard, searchable lead census, and unified lead detail.
- Pages 6–7: ranked signals and a readable WHEN / AND / THEN rule builder.
- Page 8: campaign audience, exclusions, trigger, and pacing in one workflow.
- Pages 9–10: visible sequence, exit conditions, and per-lead message preview.
- Pages 11, 13–15: conversation handoff, lightweight pipeline, reporting, and controls.
- Page 16: responsive approval and review experience.

Design direction: near-black and deep-green surfaces, bright green primary actions, compact navigation, restrained borders, dense but readable records, and clear status chips. Use readable type and accessible contrast rather than reproducing small slide typography. Status must also use text or icons, not color alone.

Adapt “Census” to **Leads**, academy to **Company + Contact**, and claimed/paid outcomes to **Replied / Qualified / Meeting booked**. Keep sequences inside campaigns rather than requiring a separate setup module.

Do not import the deck’s WhatsApp/Instagram/email delivery, academy listings, shadow profiles, payment attribution, UAE-only hosting, n8n architecture, or legal assertions as MVP requirements. Its “every send is reversible” claim does not apply: pausing prevents future actions; it cannot guarantee recall of a sent message. Sequence exhaustion means completed, not permanent opt-out. Permanent suppression is reserved for explicit opt-outs or blocks.

## 3. LinkedIn feasibility and execution decision

Verified against official documentation on 22 September 2026:

- LinkedIn prohibits unauthorized software that scrapes or automates activity on its website. Low volume alone does not make that activity permitted. [Prohibited software](https://www.linkedin.com/help/linkedin/answer/a1341387)
- Invitation restrictions depend on activity and recipient responses; the official guidance does not establish one universally safe daily or weekly numerical allowance. [Invitation restrictions](https://www.linkedin.com/help/linkedin/answer/a551012/types-of-restrictions-for-sending-invitations)
- Ordinary LinkedIn sign-in permissions do not grant inbox access or outbound messaging. Sales integrations require separate approval. [API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)
- Messages and Invitations APIs are restricted to approved partners. The documented Messages API additionally requires an editable draft and an affirmative member action at approximately the time of sending; a scheduled event is not that action. Partner access alone therefore does not establish permission for unattended campaigns. [Messages API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages), [Invitations API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/invitations)

### Proposed MVP: assisted execution

The app automates research, qualification, evidence collection, drafting, task scheduling, and reporting. Users send each invitation/message within LinkedIn and explicitly record the outcome in the app. The app provides copyable drafts and recipient identifiers. Copying a draft is not recorded as sending it.

Account setup records the intended sender and timezone. Official OAuth may verify identity if available, but the UI distinguishes **sender configured**, **identity verified**, and **sending capability available**. Without approved access, do not label the sender “connected for messaging.” Never collect LinkedIn passwords or session cookies.

If approved API access is obtained, add only the operations and interaction patterns the agreement permits. Keep per-message sending actions where required. Do not assume reply synchronization, connection lookup, or acceptance events exist until independently verified.

If unattended LinkedIn sending is essential to the MVP, pause delivery planning for that capability until an authorized integration and its permitted behavior are demonstrated. A vendor’s claim that it supports LinkedIn is insufficient evidence. Do not advertise ban-proof automation.

## 4. Scope

### P0 — required MVP

- Workspace, owner/operator roles, one sender per workspace initially.
- Company offering, proof points, tone, and campaign objective setup.
- Sender configuration with explicit capability status.
- Target segment definition and AI research from permitted public or licensed sources.
- Evidence-backed leads, deduplication, filters, and exclusions.
- Signals and simple rules with freshness, preview, and explanation.
- Personalized drafts and one linear LinkedIn sequence with eligibility branches.
- Review, launch, pause, resume, and stop controls.
- Assisted action queue, manual connection/reply updates, and conversation handoff.
- Workspace-wide suppression, action ledger, and basic funnel reporting.

### Conditional / deferred

- Sales Navigator sourcing: disabled until an approved source and access contract are validated; pasting a Sales Navigator URL does not authorize extraction.
- Native sending and reply sync: depend on verified capabilities and permitted use.
- Unattended sending: separate approval gate, not implied by native API access.
- Multi-sender routing, CRM integrations, email/WhatsApp, InMail, open-profile exceptions, AI auto-replies, billing, arbitrary workflow graphs, advanced revenue attribution, and continuous market-wide monitoring: later releases.

## 5. Main user journey

1. **Set up the company.** Enter website, offering, target pain, value proposition, approved proof points, language, and call to action. AI may suggest content; user confirms it.
2. **Configure sender.** Identify the LinkedIn account, timezone, working days/hours, and execution mode. Show exactly which capabilities are available.
3. **Describe target customers.** Use natural language plus editable filters: industries, company size, geography, roles/seniority, exclusions, and maximum lead count.
4. **Choose signals and triggers.** Select evidence such as a relevant job opening, funding announcement, expansion, or product launch. Configure recency, required versus optional signals, and match logic.
5. **Research leads.** Review progress and partial results. Inspect company/contact identity, fit reasons, signal evidence, source dates, confidence, and missing fields. Approve or exclude leads.
6. **Build the sequence.** Review invitation, post-acceptance introduction, follow-ups, waiting periods, and exits. Existing connections skip the invitation.
7. **Review personalization.** Preview each lead’s messages and the facts used. Edit, regenerate, approve, or reject. Approval applies to an exact content version.
8. **Launch.** Review audience size, exclusions, execution mode, schedule, research budget, and stopping rules. In assisted mode, launch activates the work queue; it does not send LinkedIn messages.
9. **Operate.** Complete due tasks, record sends/acceptances/replies, and move interested conversations to human handling. Pause or suppress from any lead or campaign view.

## 6. Functional requirements and acceptance criteria

### FR-01 — workspace and sender

Owner manages settings, membership, exports, deletion, and suppression. Operator manages assigned campaigns and conversations. All records and jobs are workspace-scoped. One sender can have multiple campaigns, but pacing and deduplication apply across all of them.

**Acceptance:** one workspace cannot access another’s leads, drafts, audit events, or credentials. Disconnecting a supported integration disables dependent operations and pauses affected jobs. Manual setup never implies verified inbox access.

### FR-02 — segment definition

Persist both the user’s original description and the structured filter version. Display hard filters separately from ranking preferences. Exclude existing customers, competitors, blocked companies, and already-active contacts when supplied.

**Acceptance:** user confirms interpreted filters before research. Missing evidence for a hard filter produces a review-needed record, not an automatic match. No results produces actionable filter suggestions without silently widening the segment.

### FR-03 — research and lead identity

Use configured, permitted research sources such as company sites, job pages, announcements, and licensed providers. Public availability does not automatically grant reuse rights. Do not scrape LinkedIn or use an intermediary to bypass source restrictions.

Every lead has a company, contact name, role, source provenance, retrieval time, and identity confidence. A LinkedIn identifier, if lawfully supplied or obtained, must be validated before an outreach task is eligible. Never invent a profile URL, person, role, funding event, or private email.

Deduplicate within the workspace using reliable external identifiers where available; otherwise use conservative company/contact matching and flag ambiguity for review. A contact may appear in historical campaigns but have only one active outreach enrollment per workspace.

**Acceptance:** repeated research does not duplicate confirmed contacts; uncertain matches remain separate pending review. Jobs can be canceled and preserve completed results. A proposed pilot batch is up to 50 contacts, with a visible research budget and no promise to fill the batch with unverified leads.

### FR-04 — signals and triggers

A **signal** is a sourced fact about a prospect. A **trigger** is a rule that makes an eligible prospect enter a campaign or become a review task.

P0 rule structure: segment matches AND configured signal condition, using “all” or “any” within one signal group. Avoid arbitrary nested logic. Each signal includes event type, source URL, event date if known, observation date, expiry window, and confidence. Unknown event dates must not be represented as recent events.

Example: “For HR leaders at 50–200 employee software companies, when at least three relevant job openings are currently verified, prepare enrollment for review.”

Proposed freshness defaults: job evidence rechecked within 7 days; announcements within 30 days. These are product choices, editable per rule. MVP supports on-demand research and a daily refresh of active campaign candidates within budget. Net-new lead discovery after launch is off by default; enabling it still sends new leads and drafts to review.

**Acceptance:** preview shows matching leads and evidence. Duplicate observations do not create duplicate enrollments. Expired evidence blocks affected drafts pending refresh. No historical backtest is claimed unless historical source data exists.

### FR-05 — fit and personalization

Show fit reasons before a numeric score. If scoring is used, show its components, model/rule version, and missing inputs; a score is not a probability of purchase.

Drafts combine approved company positioning with verified lead evidence. Use one relevant reason for outreach, a concise value proposition, and one call to action. Exclude sensitive personal inferences, fabricated familiarity, unsupported customer claims, and invented urgency.

Store the evidence references used for each factual claim. If evidence is weak, request review or produce a clearly labeled generic draft. Treat retrieved text as untrusted data, never as instructions to the model or workflow.

**Acceptance:** unresolved merge fields, missing required identity, unsupported claims, and invalid channel length prevent approval. Channel limits are configurable based on validated current capability; unsupported invitation notes are omitted explicitly. Editing a draft, its factual basis, or relevant sequence content invalidates its prior approval. Bulk draft approval does not authorize future automatic LinkedIn sends.

### FR-06 — sequence and branching

Proposed template timings are internal product defaults, not LinkedIn safety limits:

1. If relationship is unknown, request verification. If already connected, skip invitation.
2. If not connected and there is no pending invitation, prepare one invitation task, optionally with a supported note.
3. Wait for verified or manually confirmed acceptance. A sent invitation alone never unlocks a direct-message step.
4. After acceptance, prepare the introduction for the next working window, with a proposed one-business-day delay.
5. If no reply, prepare follow-up 1 three business days after the confirmed introduction send.
6. If still no reply, prepare one final follow-up five business days after the confirmed previous send.
7. After seven more calendar days with no reply, complete the sequence. Do not equate completion with opt-out.

After 21 calendar days without acceptance, mark the enrollment “No acceptance” and stop. Do not automatically withdraw or resend invitations. Existing pending invitations enter the wait state without generating another invite. Rejected invitations or inability to message end or block the relevant path. InMail and non-connection messaging exceptions are outside P0.

Stop future sequence actions upon any reply, explicit opt-out, meeting booked, manual stop, or workspace suppression. A reply creates a human follow-up item. “Contact later” stops the active sequence and may create a user-approved reminder.

**Acceptance:** waiting periods start from confirmed events, not scheduled times. Pause/resume does not compress overdue steps into a burst. Every due action rechecks eligibility, suppression, current approval, and relationship state.

### FR-07 — execution and account protection

Display app-recorded activity separately from actual LinkedIn usage. Manual actions outside this app are not automatically visible. Show unknown capacity as unknown.

Use separate account-wide budgets for invitation tasks and message tasks; campaign budgets cannot exceed sender budgets. Proposed assisted-pilot default: at most five new invitation tasks and ten message tasks presented per working day. These are conservative workload settings, not LinkedIn quotas or guarantees; the user can reduce them and must stop when LinkedIn indicates a restriction.

Show working hours and timezone, pending invitations recorded by the app, suppression counts, and last verified capability status. Pause all affected campaigns when a restriction is reported or an authorized integration returns a restriction/authentication failure. Resume requires the issue to be resolved and an explicit operator action; never repeatedly probe a restricted account.

**Acceptance:** a limit blocks the next eligible task/action across campaigns; concurrent workers cannot reserve the same capacity twice. A queued action is not a sent message. Unknown send outcomes enter reconciliation and are never blindly retried. There are no proxy rotation, account cycling, CAPTCHA bypass, or “human-like delay” safety claims.

### FR-08 — launch, pause, and versioning

Launch requires a valid sender mode, confirmed segment, at least one approved eligible lead/draft, valid sequence, defined schedule, and visible blockers. Display counts for approved, excluded, awaiting review, and blocked leads. Launch can proceed with the eligible subset only after the user sees that subset.

Freeze an enrollment’s sequence version. Changes to active campaigns apply to new enrollments by default; migrating existing enrollments requires an explicit reviewed change and must never resend completed steps.

**Acceptance:** pause cancels or blocks unstarted actions. In-flight outcomes remain visible. Resume recomputes due times and checks guards. Stop closes the campaign and cancels remaining work without deleting history. Send recall is never promised.

### FR-09 — replies and pipeline

Without verified inbox access, provide a **Conversation log** with manual reply recording, not a misleading synced inbox. Before every assisted follow-up, ask the operator to confirm that no reply has arrived. Automated immediate reply detection is unavailable in this mode; this limitation must be visible.

With separately authorized event access, record replies idempotently and stop pending work when the event is received. Draft suggested responses for review only. Suggested classes: interested, not interested, later, opt-out, unclear. Explicit opt-out language always suppresses; uncertain classifications require review.

Pipeline: Researched → Approved → Invitation pending / Connected → Contacted → Replied → Qualified → Meeting booked. Also support Completed, Not interested, Suppressed, and Blocked outcomes. Keep sequence state separate from pipeline stage.

**Acceptance:** recording any reply cancels future sequence tasks. Manual events show actor and timestamp; provider events show provenance. “Sent,” “delivered,” and “read” are separate statuses, and unavailable delivery/read information is never inferred.

### FR-10 — suppression, privacy, and audit

Maintain workspace-wide contact and company exclusions. Explicit opt-outs block current and future enrollments unless a separately documented, valid repermission process exists. A pause or no-response outcome does not erase suppression history.

Log configuration changes, evidence versions, approvals, launch/pause/stop events, task outcomes, capability errors, suppression, and data exports. Restrict access and redact secrets. Establish retention, deletion, data-source rights, vendor processing terms, and applicable geography before production; the reference deck’s UAE settings are not assumed.

**Acceptance:** deletion cancels pending work and removes personal content from operational stores according to the approved policy. Any minimum suppression identifier retained to prevent recontact must be justified by that policy. Audit design avoids retaining deleted message bodies indefinitely. Raw credentials and tokens never appear in logs or model prompts.

## 7. Screens and UX states

Primary navigation: **Today · Leads · Signals · Campaigns · Conversations · Reports**, with Settings for sender, members, schedule, suppression, and data controls.

- **Today:** research progress, drafts awaiting approval, due tasks, blocked campaigns, replies needing attention, and recent activity.
- **Setup:** company context and sender configuration, clearly showing assisted/native capability.
- **Campaign wizard:** Audience → Signals → Research & review → Sequence & messages → Launch review. Save drafts and return to earlier steps.
- **Leads:** saved segments, filters, match explanation, source freshness, selection, and bulk exclusion.
- **Lead detail:** company/contact facts, evidence, signals, messages, sequence position, timeline, and suppression controls.
- **Signals:** rule list, builder, current match preview, refresh status, and error explanations.
- **Message studio:** variables and sources beside editable per-lead preview, with approval version and character validation.
- **Campaign detail:** funnel, enrolled leads, sequence, queue, settings, pause/stop, and a visible execution-mode banner.
- **Conversations:** manual log for P0, human owner, classification suggestion, and next action.
- **Reports:** observed funnel, signal/source comparisons, research spend, and data completeness.

Every screen needs loading, empty, partial-result, retryable-error, disconnected, and permission-denied states where relevant. On mobile, prioritize review, copy draft, record action, pause, and suppress. Use accessible labels, keyboard navigation, and explicit confirmation for destructive actions.

## 8. Metrics and launch criteria

North-star hypothesis: **qualified conversations per active workspace per week**. Define a qualified conversation as a human-confirmed response from an ICP-matching contact with relevant need or agreed next step. Do not equate any reply with qualification.

Activation: sender configured + segment confirmed + at least one verified lead and approved sequence + campaign launched. Track time to first approved campaign separately from research latency and time spent awaiting human input.

Funnel definitions:

- Invitation acceptance: confirmed acceptances / confirmed invitations sent in a stated cohort.
- Reply rate: unique contacts replying / unique contacts with at least one confirmed message send in that cohort.
- Positive reply and meeting rates use explicit human-confirmed labels.
- Draft acceptance: approved drafts / reviewed drafts, with edits measured separately.
- Quality: reviewed leads meeting ICP, unsupported-claim rate, duplicate rate, and evidence freshness.
- Reliability: duplicate sends/tasks, blocked suppression attempts, stale approvals, unknown outcomes, and restriction reports.
- Cost: research and model spend per verified lead and per qualified conversation.

Always show cohort dates, denominators, and whether events are manual or synchronized. Signal attribution uses the enrollment-trigger snapshot; it does not establish causation. No revenue claims without recorded deal outcomes.

Proposed pilot: 3–5 design partners, each reviewing up to 50 researched leads. Targets to approve before the pilot: at least 80% of reviewed leads meet the confirmed ICP; at least 70% of reviewed drafts need only minor edits; every personalized factual claim has traceable evidence. Zero cross-workspace leaks, duplicate executions, or actions after known suppression are release requirements. Conversion and latency targets should be set after a measured baseline.

## 9. Engineering planning inputs — not a committed architecture

Likely building blocks: web UI, authenticated application API, relational database, durable job queue, scheduled research workers, model/provider adapters, and an append-only action ledger with a defined personal-data retention strategy. Select the stack after product scope approval.

Core entities: Workspace, User, SenderCapability, Company, Contact, SegmentVersion, Evidence, SignalObservation, RuleVersion, Campaign, SequenceVersion, Enrollment, DraftVersion, Approval, ActionTask, ConversationEvent, Suppression, AuditEvent, and ResearchRun.

Jobs must be resumable and idempotent. Enforce unique active enrollment and step execution keys; use transactional reservations for account-wide budgets. External delivery failures with uncertain outcomes require reconciliation. Recheck suppression immediately before any supported dispatch. A reply received after an external send is already in flight cannot retroactively prevent that send; record the timing honestly.

Store timestamps in UTC and render schedules in sender timezone, including daylight-saving transitions. Bound research/model spending, retry transient failures with limits, and route exhausted jobs to visible recovery. Encrypt credentials, verify provider events if used, enforce server-side role checks, and test tenant isolation. Retrieved content must not trigger tools, reveal secrets, or alter campaign policy.

## 10. End-to-end acceptance scenarios

1. Configure an assisted sender, research a segment, review evidence and drafts, and launch; only tasks are created and no message is marked sent automatically.
2. A non-connection remains invitation-pending until acceptance is confirmed; an existing connection skips that step.
3. Re-running research or a failed job does not create duplicate active enrollments or completed-step actions.
4. A reply or opt-out entered while a follow-up is queued cancels the follow-up; opt-out blocks future campaigns.
5. Changing approved copy invalidates approval and prevents the changed version from becoming an executable action.
6. Missing identity, stale signal evidence, exhausted budget, or restricted sender yields a clear blocked reason.
7. Pausing overnight and resuming next day preserves waiting periods and daily workload limits.
8. Copying a message, marking a task done, confirming a send, and observing delivery remain distinct events.
9. Unknown provider outcomes are held for reconciliation, never resent automatically.
10. Unauthorized workspace access, role violations, and secret exposure fail security checks before pilot launch.

## 11. Proposed delivery plan and approval gates

**Gate A — product approval:** agree execution mode, initial buyer/vertical, data source, and P0 scope. This PRD is the review artifact. No application build starts before approval.

**Phase 1 — feasibility and UX planning:** validate research-provider quality/cost, document actual LinkedIn permissions, produce detailed screen flows and technical plan. Use synthetic records for prototypes. Exit: approved plan, evidenced provider capabilities, and explicit unresolved limitations.

**Gate B — implementation approval:** approve screen flow, integration contracts, data model, budget, and milestone estimates. Exact dates follow this feasibility work rather than assuming access that may not exist.

**Phase 2 — core workflow:** workspace/sender configuration, company context, segments, research, evidence, lead review, and signals. Exit: reviewed leads with reliable provenance and deduplication.

**Phase 3 — campaign operation:** personalization, approval versions, sequence state machine, launch review, assisted queue, and suppression. Exit: end-to-end acceptance scenarios pass without live outreach.

**Phase 4 — conversation handling and pilot:** manual outcomes, funnel reporting, monitoring, privacy controls, and operational recovery. Exit: approved pilot settings and acceptance criteria verified.

**Gate C — live pilot approval:** approve participants, source rights, operating limits, privacy settings, and execution mode before any live outreach. Shipping an authorized native integration later requires its own capability validation and acceptance tests.

## 12. Decisions for the founder

1. **Execution mode — blocking:** approve assisted sending for the first release, or require unattended LinkedIn sending and resolve authorized integration feasibility first? Recommendation: assisted MVP to validate research and personalization, while investigating the full-automation requirement separately.
2. **Initial customer:** which B2B vertical, seller persona, and prospect geography should the first segment target? Proposed working assumption: founder-led B2B teams; the Clubble academy vertical is a visual reference only.
3. **Sourcing:** approve AI research from permitted public/licensed sources first, with Sales Navigator deferred pending access? Recommendation: yes.
4. **Control:** approve all leads and drafts before enrollment, including new matches after launch? Recommendation: yes for the pilot; this is distinct from permission to send.
5. **Operational constraints:** what monthly research/model budget and deployment/data-residency requirements apply? Do not assume UAE hosting from the deck.

Approval of this document establishes product scope; it does not by itself approve the subsequent technical plan or authorize live campaigns.
