# ilovelawyer-api

Standalone backend API providing authentication (and, eventually, other domain services) for ilovelawyer — decoupled from the `law-ph` monolith it's replacing.

## Language

**Session**:
A single issued refresh token, created at login and tied to one device/client. A User can have multiple concurrent Sessions (one per device they're logged in on).
_Avoid_: "login record", "auth session" (as a synonym for "all of a user's logins" — that's not what one Session represents here)

**Logout**:
Revoking exactly one Session — the one tied to the refresh token presented in the request — by deleting its row. Does not affect a User's other active Sessions on other devices.
_Avoid_: "sign out everywhere" (a distinct, broader action — not yet built)

**Access Token**:
Short-lived JWT proving identity on a per-request basis. Verified statelessly (signature check only, no DB lookup) by `valid-session.middleware.ts`.
_Avoid_: "auth token" (ambiguous between this and Refresh Token)

**Refresh Token**:
Longer-lived JWT used only to mint a new Access Token once it expires. Persisted in a Session row (unlike the Access Token) so it can be revoked before its natural expiry — that's what makes Logout possible. Rotated on every use: refreshing deletes the old Session/token and creates a new one, rather than reusing the same Refresh Token until its original expiry.

**Tenant**:
A deployment-region boundary (`code`: "PH", "UK", ...), resolved from the request's subdomain. An Organization belongs to exactly one Tenant (required, not optional); a User has an optional direct Tenant link, used only for a solo practitioner not yet in an Organization. See `docs/adr/0002-tenant-region-boundary.md`. There is no separate `Jurisdiction` enum anymore — it was collapsed into Tenant, since the two were always set from the same value and never allowed to diverge; see `docs/adr/0004-collapse-jurisdiction-into-tenant.md`. The `TenantCode` TypeScript type (`types/tenant-code.ts`, `"PH" | "UK"`) is what `Jurisdiction` used to be — still threaded through the legal-domain registries (`legal/prompt-registry.ts`, `legal/deadline-engine.registry.ts`, `legal/legal-knowledge-provider.ts`) to select PH/UK behavior, just sourced from `Tenant.code` now.
_Avoid_: confusing with **TenantContext** (`utils/tenant-context.ts`) — a per-request value (userId + organizationId + role + tenantCode) resolved from organization membership. It carries a `tenantCode` field, but it is not itself a Tenant.
_Avoid_: "jurisdiction" for anything Tenant-related — that word is still legitimately used elsewhere for three unrelated concepts: `Case.jurisdiction` (a free-text court/venue field), `Case.ukJurisdiction` (a constrained England and Wales / Scotland / Northern Ireland selector, UK-tenant-only, feeding `CaseSvc.formatForAiContext`), and `JurisdictionModule` (a dormant, admin-toggleable legal-ruleset feature flag). None were touched by the Tenant/Jurisdiction collapse.
_Status: assigned from the request's Origin host at both signup (`User.tenantId` — password signup and first-time Google signup, via `TenantRepo.findIdByCode`) and Organization creation (`Organization.tenantId`). A client-app (`USER`) signup ignores the origin and always gets `CLIENT_TENANT_CODE` (UK). A lawyer signup leaves `tenantId` null if the origin doesn't resolve to a known Tenant (e.g. local dev, direct API calls) rather than rejecting the request; Organization creation still hard-rejects an unresolved origin, unchanged from before._

**Pending Deletion (Organization)**:
What an Organization becomes when its last member leaves it — by leaving, or by accepting an invite to another organization. Only a sole-member Owner can get there: an Owner with teammates must make another member an Owner first. It's archived in the same transaction as the leave (`Organization.status = PENDING_DELETION`, `archivedAt`, `archivedById`, `deletionScheduledAt` = 30 days later): nobody can open, join or be invited to it, and its outstanding invites stop working (accepting one returns 410; they don't hold the invitee's one-invite slot). `OrganizationDeletionQueue` deletes it, with its cases, consultations and documents, once `deletionScheduledAt` passes. Restoring one is a customer-support action (set it back to `ACTIVE`); the app has no restore. A personal workspace with no member is never Pending Deletion — it's just parked as a portfolio.
_Avoid_: "deleted" for an organization still in its grace period

**Client App** / **Account Role**:
ilovelawyer-app (lawyers) and the client app share this API and its `User` table; `User.role` says which one an account belongs to — `LAWYER` for ilovelawyer-app, `USER` for the client app, `ADMIN` for ilovelawyer-admin. The client app sends `X-Client-App: user`; no header means the lawyer app (`utils/client-app.ts`). The header only picks a new account's role at signup (password and Google; a trial guest is always `LAWYER`). After that, every path that issues a session refuses an account in the other app: 409 `WRONG_APP` on sign-in, a quiet 401 on refresh. `ADMIN` is exempt. A password reset is refused the same way before its token is spent. Signing up in the client app with an email a lawyer account already has answers 409 `EMAIL_REGISTERED_AS_LAWYER`; the reverse keeps the generic 409. The client app is served from one domain for every region (ilovelawyer.com, app.ilovelawyer.com for staging), so its host names no Tenant: every `USER` account is created in `CLIENT_TENANT_CODE` (UK). Emails to a `USER` account link to a `USER_APP_URL` origin. A `USER` account agrees to the client app's own Terms, recorded as `CLIENT_TERMS_VERSION`. A `USER` account is ACTIVE as soon as its email is verified (`autoApproveIfEnabled`); only `LAWYER` accounts wait for admin approval. Existing accounts were moved from `USER` to `LAWYER` once, by `scripts/backfill-lawyer-role.ts`, before the client app launched.
_Avoid_: confusing with `OrganizationRole` (OWNER/ADMIN/MANAGER/MEMBER inside a firm), or with `MessageRole`; "user" for a lawyer's account in new writing — say lawyer or client.

**Client Case**:
A case a client made in the client app. It is an ordinary `Case` in the client's personal workspace on the client tenant, made the first time they need it (`ClientCaseSvc.workspaceFor`). It has one Consultation, which the client's AI chat runs in. The client app reaches it only through `/api/client` (`client.route.ts`), which answers `USER` accounts only (403 `CLIENT_ACCOUNT_ONLY`) and takes no `X-Organization-Id`. The AI, document extraction and access rules are the lawyer app's. The client's choice of problem type is stored on `Case.practiceArea` (`CLIENT_CASE_AREAS`), and a case outside the UK has no `ukJurisdiction`.

**Client Payment** / **Chat Credit**:
The client app is pay per case. A client pays first (`ClientPayment`, kind `CASE`), then creates the case with that payment. `usedAt` makes one payment create one case, and a failed creation gives it back. The case gets its chat credits (`Case.clientCredits`), each message to the AI takes one (402 `OUT_OF_CREDITS` at 0), and a `TOP_UP` payment adds more. Prices and packs are placeholders in `client-pricing.constants.ts`. Every payment goes through `clientPaymentProvider()`, which is a dummy for now: it charges nothing, and `provider = "DUMMY"` is stored on each row so a dummy payment is never taken for a real one. Stripe replaces it there later. The account-wide free credit (`User.freeCreditUsd`) doesn't apply under `/api/client`, since chat credits replace it.
_Avoid_: "credits" for the free AI credit or the lawyer's case allowance; "subscription" (the client app has none).

**Lawyer Readiness**:
Whether a Client Case has enough in it for the client app to suggest a lawyer. After each AI answer Jev is asked five yes/no questions against the case details and the chat: the problem, where in the UK, the other side, what happened and when, and what the client wants (`lawyer-readiness-jev.ts`). Each answer has a confidence, and a yes under `READINESS_MIN_CONFIDENCE` counts as no. Jev also gives the kind of lawyer the case needs. Ready means all five are met, the case is in the UK, and it isn't personal injury. The result is stored on `Case.lawyerReadiness` with the AI message it read up to. Once ready, Jev's practice area is written to `Case.practiceArea` for matching. Behind `USE_JEV_LAWYER_READINESS`. When it's off, or Jev can't be reached, nothing is claimed.

**Client Request**:
A client's ask for a lawyer on one of their own UK cases (the UK client-to-lawyer hand-off). It carries the anonymised brief that matching lawyers see, then one lawyer's claim, quote, the per-case fee charged to that lawyer's organization, and the engagement. Statuses: `REQUESTED → ROUTED → CLAIMED → QUOTED → CONFIRMED → ENGAGED → CLOSED`, or `EXPIRED` / `WITHDRAWN` (`types/client-handoff.ts`). The client app calls it a lawyer request (`/lawyer-requests`). The lawyer app calls it a client request (`/client-requests`). Both are the same row. See `docs/adr/0016-client-app-shares-the-uk-api.md`.
_Status: designed, not yet implemented (ilovelawyer-api#503–#520)._
_Avoid_: "claim" alone in code for a lawyer's 24h hold on a request: name it `ClientRequestClaim`, since **Case Claim** is a cause of action. "Declined" as a request status: a declined quote ends the claim (`ClaimOutcome.DECLINED`) and the request goes back to `ROUTED`.

**Lawyer Client Profile**:
A lawyer's settings for receiving client requests from the client app (UK only): their regulator and registration number, the UK jurisdictions they're qualified in, the practice areas they take on (never personal injury), bio, languages, first-consultation fee in GBP, and whether they're accepting requests (with a pause date and a capacity limit). `LawyerClientProfile`, one per lawyer, at `/api/users/me/client-request-profile`. Verification moves on its own: `UNSUBMITTED` while a required field is missing, then `PENDING` for an admin's register check (#506), and back to `PENDING` whenever what was checked (regulator, number, jurisdictions) changes. Accepting requests needs a complete and `VERIFIED` profile; a lawyer who loses either is switched off rather than refused the edit.

**Engagement**:
A Client Request once the client has confirmed the lawyer and the fee is paid (`ENGAGED`). The assigned lawyer gets a `VIEW` `CaseAccess` grant on the client's case, the same read-only share `CaseShareSvc` makes. Ending the engagement removes the grant. Either side can end it: the lawyer closes it, or the client ends it from the client app. The lawyer keeps any workspace copy they made. The engagement has its own AI budget, which the lawyer sees and tops up. It is separate from the internal case allowance in `CaseLimitsSvc`, which is never shown.
_Status: designed, not yet implemented._

**Email Verification**:
A blocking gate on password-based Signup: a User's `isEmailVerified` flag starts `false` and Login is refused until it's flipped `true` by successfully completing OTP verification. Not required for Google signups — Google has already verified the email, so `isEmailVerified` is set `true` at account creation. An admin can also mark a User verified in place of the OTP (`POST /api/admin/users/:id/verify-email`, `AdminSvc.verifyEmail`) — one-way, audited as `users.email_verified`, and it auto-approves a PENDING User on an auto-approve Tenant exactly as OTP verification does.
_Avoid_: "OTP" alone as the name of the gate (OTP is the mechanism — the one-time code — not the gate itself; the gate is Email Verification)

_Emails are canonical_: every `User.email` is stored and matched trimmed + lowercased (`normalizeEmail`), so a password account and a Google sign-in for the same address are the same account. A Google sign-in whose email belongs to an existing, verified password account is never linked silently: the API answers `GOOGLE_LINK_REQUIRED` and the link happens only through `/auth/google/link`, which requires that account's password. An unverified, still-PENDING password signup for the address is treated as abandoned and replaced by the Google account._
_Status: designed, not yet implemented — see Pending._

**Case Claim**:
A legal cause of action a lawyer is pursuing or defending against in a Case (e.g. "Breach of Contract") — `title` / `causeOfAction` / `description` on the `CaseClaim` model.
_Avoid_: "Claim" for the unrelated per-sentence attribution tags the AI attaches to generated prose (`ReconstructionClaim`, `RedTeamClaim`: `text` / `category: GROUNDED|INFERENCE|UNSUPPORTED` / `sourceLabel`) — those are called **Attribution** everywhere user-facing (e.g. the Case Brief export's Attribution tables), specifically to avoid a lawyer reading "Claims" in a document and thinking of pleaded causes of action instead of AI provenance. The underlying `ReconstructionClaim`/`RedTeamClaim` type names are legacy and unchanged by this distinction — only rendered/document-facing text and new writing should say "Attribution."

**Exhibit**:
A `Document` a lawyer has explicitly marked for inclusion in the Case Brief export, via a new `isExhibit` boolean on the `Document` model (default `false` — a document is not an Exhibit just by being uploaded to the case). Marked/unmarked through the existing `PATCH /api/documents/:id` endpoint.
_Avoid_: confusing with `ilovelawyer-app`'s unrelated, non-persisted "No verified exhibits for this scene" UI label (a reconstruction scene's source-document references) — that's a different, read-only concept with no `isExhibit`-style field behind it. Also avoid assuming every uploaded case `Document` is an Exhibit — the app's own glossary describes uploaded documents generically as "evidentiary," but that's broader than this flag; only explicitly-marked ones appear in the Case Brief's Exhibit list.
**Benchmark**:
A fictional litigation bundle plus an assessment paper, under `benchmarks/<slug>/` (`docs/*.pdf`, `questions.json` incl. tenant/case fields, `rubric.json`, `answers/<date>/`). Seeded into a real org's case with `scripts/seed-benchmark.ts`, asked through the production chat path with `scripts/run-benchmark.ts`, scored by `scripts/grade-benchmark.ts` (AI grader over the full bundle text + a solicitor moderation sheet), history in `benchmarks/scores.md`. First one: `brackenmoor` (UK). Every architecture change to the legal pipeline is expected to be measured against it.
_Avoid_: "eval" for this (that word is used for the PH prompt eval set in chat-wonder); grading from the answer alone without the bundle text

**Whole-Case Inline**:
When a case's READY documents total at most `CASE_FULL_TEXT_INLINE_CHARS` (200k chars in prod / official scorecards; local cheap profile uses 40k), `streamChatWonderMessage` sends every document's full text as `case_document_texts` alongside the ranked chunks and manifest; chat-wonder holds them in full for the turn. Larger cases keep the ranked-chunks + on-demand fetch behaviour. `OMIT_EMBEDDING_RANKING` is benchmark-only and must stay unset for everyday chat.
_Avoid_: raising the threshold without raising chat-wonder's `CASE_DOCUMENT_TOKEN_BUDGET` to match; enabling `OMIT_EMBEDDING_RANKING` outside a BM25 A/B run

**Decision Record**:
The "Why?" behind one conclusion in a legal chat answer — rule applied, evidence for/against, the alternative considered and rejected, weighting, confidence, and what fact would change it. Generated and self-audited by chat-wonder-v2-api per turn (every `rule[].url` checked against that turn's retrieved pool, every `evidence*[].docId`/quote against the case's attached exhibits — this app never re-derives `verified`), persisted on `MessageDecisionRecord`, and promoted into a standalone `DecisionRecord` row per record (`DecisionRecordSvc.promote`, always `authorUserId: null`, mirroring `CaseTimelineSvc.promoteFromAi`) plus DECISION/DOCUMENT nodes and SUPPORTS/CONTRADICTS edges in the Case Graph. Surfaced as the "Decisions" Terminal panel, populated automatically — never generated on demand.
_Avoid_: editing or reassigning authorship when a lawyer disagrees — that's expressed as `status: DISPUTED` + `disputeNote` via the dispute/reactivate endpoints, the row itself is left as the AI produced it.
_Status: Phase 1 of `docs/plans/differentiation-program.md` Workstream A — complete. Generation/verification, persistence, case-graph promotion, list/dispute/reactivate API, snapshot wiring, the case-level Decisions panel, and an inline "Why?" affordance: each `anchor` is highlighted (whitespace-tolerant match, `components/shared/decision-anchor-match.ts`) directly in the chat bubble that produced it, opening a read-only detail drawer (`components/chat/decision-drawer.tsx`) — no dispute action there, since a non-case-linked consultation has no promoted `DecisionRecord` row to dispute against; dispute/reactivate stays a Decisions-panel-only action._

**Change Summary**:
What one analysis refresh (`CaseRefreshSvc`) changed in the panes it rewrote, compared with what they said before it — one `CaseChangeSummary` row per run, written once at the end by `CaseChangeRun` (its id is the run's id). Tracks every pane the refresh rewrites (`types/case-change.ts`): outlook, contradictions, findings, Red Team, Case Reconstruction, Case Strategy (with key dates), witnesses, damages, the AI draft theory, the case map and the Audio Overview; a pane's own Regenerate writes a one-pane summary (`reason: "regenerate"`); each pane is changed, unchanged, skipped or failed. `documentsAdded`/`documentsRemoved` compare the run's READY unarchived documents with the previous summary's; `firstAnalysis` marks a case's first run, where there was nothing to change. Read by the app's Terminal "What changed" modal through the snapshot's `latestChangeSummary`, and listed by `GET /:caseId/change-summaries`.
_Avoid_: storing it in the `case.refresh` AuditEvent payload — audit rows outlive the case (`onDelete: SetNull`) and these hold case content; the audit row only carries `changeSummaryId` and `totalChanges`.

**Security Audit Log**:
The record a firm's security questionnaire asks about: sign-ins (including failed ones), membership and permission changes, platform admin actions, exports, file downloads and deletions. Stored as `SecurityAuditEvent` and written only through `SecurityAuditSvc.record`. The database keeps it append-only: a row can't be edited, and can't be deleted until it is past the 365-day floor and the retention period (`SECURITY_AUDIT_RETENTION_DAYS`, 7 years by default). Each row belongs to one organization, whose Owners and Admins read and export it (`GET /api/organizations/:id/audit-log`). Every mutating route must be listed in `test/support/security-audit-coverage.ts`, with either the actions it writes or why it writes none. See `docs/adr/0006-security-audit-log.md`.
_Avoid_: "audit log" for `AuditEvent`, which is the **case activity feed**: one case's edits and AI runs, readable by anyone with access to the case, and the input to mind map and Case Strategy staleness. Never write security events there, because they would mark panes stale. Never put case content in either log, because rows outlive the case.

**Manual edit**:
One change a lawyer made by hand in a Terminal pane, recorded by the pane's edit method right after its write (`ManualEditLog.record` → `CaseManualEdit`): the pane (an app PanelId), what was edited, the action, the item's name, and the fields it changed. Repeat edits of the same item by the same person within 5 minutes fold into one row. Grouped when read into **editing sessions** (one person, no gap over 30 minutes, no run in between — `utils/manual-edit-sessions.ts`), served by `GET /:caseId/manual-edits?day=&tz=`; `GET /:caseId/change-summaries/:id/edits-before` gives a run's "edits since the previous run".
_Avoid_: the audit log for this — it misses deletes and to-do edits, holds only ids, and outlives the case.

**Case Theory**:
One lawyer's account of the case — title, thesis, claims (each ASSERTS or DENIES, optionally linked to an existing CaseGraphNode), assumptions, open questions (differentiation program, Phase 2 — Workstream B). Several lawyers can hold different Case Theories of the same case side by side; the system never merges them into one. `authorUserId: null` marks an AI-proposed starting point (`CaseTheorySvc.propose`, seeded from the case's own findings, not fresh document reading) — adopted by forking (`forkedFromId`) into an editable, authored copy, never by editing the AI's draft in place. `TheoryDiffSvc.diff` reconciles two theories without picking a winner: it names what they share, what they genuinely disagree on, and for each disagreement the evidence that would decide it and what's missing — cached per unordered pair on `TheoryDiff`.
_Avoid_: "resolving" a diff by merging the two theories — the product's stance is that lawyers author, the AI only reconciles by naming deciding evidence.
_Status: built — CRUD, publish/retire lifecycle, fork, the reconciler (a crafted prompt + `[THEORY_DIFF]`/`[THEORY_PROPOSAL]` tagged-JSON parse in `theory-parse.ts`, not new chat-wonder-v2-api code — see the plan's "reuse what exists" principle), the "Theories" Terminal panel. Not built: realtime presence/live cursors (explicitly deferred in the plan until a transport is chosen), a dedicated "what changed since you last looked" strip for theories (the case-wide Change Summary modal now covers what each analysis run changed; theory-level changes still rely on the snapshot-invalidates-on-mutation pattern)._

**Annotation**:
A comment, dispute, or alternative reading attached to any case element (a decision, a graph node, an edge, a document chunk) — differentiation program, Phase 2. `authorUserId: null` marks one the system wrote itself: `DecisionRecordSvc.dispute` always writes one alongside flipping a decision to DISPUTED, so the disagreement has a durable, commentable home even for a lawyer who never opens a general annotation UI (`components/shared/annotation-thread.tsx`).
_Status: built — data model, CRUD API (VIEW can read, EDIT can author), wired into the Decisions panel and the Theories panel. Not wired into the Evidence detail drawer or Mind Map nodes yet, despite being named in the plan — flagged as deferred, same as Phase 1's inline chat-bubble affordance was before it shipped._

**Scene** (Grounded Reconstruction, Rung 1):
One beat of the case's most consequential episode — time, location, actors, action, any recorded dialogue, and `sourceRefs` (docId + page + an optional verbatim quote). Stored as `CaseReconstruction.scenes`, generated by a dedicated action (`CaseReconstructionSvc.generateScenes`, not folded into the main narrative generate) from the case's timeline + evidence, not by re-reading the narrative. Every `sourceRef` is verified before being kept (docId resolves to a real case document; a given quote actually appears in that document's sampled text — `case-reconstruction-scenes-parse.ts`'s `auditScenes`); an unverifiable ref is dropped, and a scene left with none gets a note in `unresolved` instead of shipping ungrounded. Each `unresolved` item is also promoted into a Weakness `CaseFinding` (deduped, additive-only) so the gap becomes investigation work, not just a UI footnote — differentiation program, Phase 3, Workstream C.
_Avoid_: `chunkId` as a sourceRef field — the plan's own sketch used one, but the case's excerpt-sampling pipeline (`buildFactExcerptPack`) only labels text by document + page, not by chunk id, so `docId`/`page`/`quote` is what's actually verifiable here.

**Table Read** (Grounded Reconstruction, Rung 2):
Multi-voice audio rendered from a case's `scenes` — one Polly voice per actor (deterministic per case, `table-read-voices.ts`'s `castForCase`), a narrator voice for action lines — reusing Audio Overview's synthesize-many-short-turns-then-ffmpeg-concat pipeline (`mergeCastTurnsToMp3`) rather than case reconstruction narration's single-voice async Polly task, for the same reason Audio Overview needed it: many short clips beat one call's length limits. `CaseReconstruction.tableReadStaleAt` is set whenever `scenes` is regenerated underneath it.
_Status: Rungs 1-2 built (scene script, table read audio) plus a Storyboard tab. Storyboard is a scope adaptation of Rung 3, not literal page-image rendering: this codebase has no PDF-to-image pipeline (only `pdf-parse` for text), so each scene's storyboard card shows its verified sourceRefs as text (document name, page, verbatim quote) rather than a rendered/cropped page image. True image rendering is a separate, deliberate infra decision (a new dependency, likely with native build tooling) — not attempted blind. Rung 4 (video) stays out of scope per the plan itself._

### Event Chain (Grounded Reconstruction)

**Event Chain**:
The case's dated events in order, each written as a fact, resting on one quote from a case document, and marked Verified, Disputed or Unverified. It is built from the case's documents alone and does not depend on the narrative or the scenes.
_Avoid_: Timeline (the lawyer-curated list of dated entries is a separate thing), Event on its own (already a calendar entry), narrative

**Proposition**:
An event written as a plain statement of what happened ("the employee was absent without leave from 4 August"), never as a report that someone said it ("abandonment is alleged to begin on 4 August"). Who asserts it is recorded next to it, so the statement itself can be tested against the rest of the case.
_Avoid_: Allegation, and Claim for the event text (Case Claim already means something else)

**Source Quote**:
The one passage, copied word for word from a case document, that an event rests on. An event whose quote cannot be found in that document has no source and can never be Verified.
_Avoid_: Citation (that means a legal authority), excerpt

**Verified**:
An event a document shows, or that is admitted or established, or that a party or witness asserts and an independent document confirms — and that nothing in the record contradicts.

**Disputed** (Event Chain):
An event that something in the case record contradicts: its own source, or another document. Only a conflict makes an event Disputed — never "only one side says so", and never "could not be checked"; those are Unverified.
_Avoid_: reading it as a lawyer disagreeing with an AI conclusion — that is a Decision Record's disputed status, a different thing that shares the word

**Unverified**:
An event the record neither confirms nor contradicts: a claim only one party makes, a witness account nothing else backs, an event with no findable source, or one that could not be checked. It is silence, not doubt.

**Corroboration**:
An independent case document that shows the same event a party or witness asserts. It is what moves such an account from Unverified to Verified. A record's silence (no entry for someone) is never corroboration.

## Example dialogue

> **Dev:** "Should logout delete the User's row in the DB?"
> **Domain expert:** "No — logout only ever touches a Session, never the User. It deletes the one Session tied to the refresh token the client sent."
> **Dev:** "So if I'm logged in on my phone and laptop, logging out on my phone kills both?"
> **Domain expert:** "No — each device gets its own Session when it logs in. Logging out on your phone deletes only your phone's Session row; your laptop's Session is untouched."

> **Dev:** "The employee's affidavit gives her start date and nothing else in the case mentions it. Is that Disputed?"
> **Domain expert:** "No — Unverified. Disputed needs something that contradicts it. Nobody contests the start date; nothing confirms it either."
> **Dev:** "And the termination letter says she was absent from 4 August, but payroll shows she worked every day that week?"
> **Domain expert:** "That one is Disputed, even though the letter really does say it. The letter shows the employer's claim, and the payroll contradicts the claim."
