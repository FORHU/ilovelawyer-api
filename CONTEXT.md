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
_Avoid_: "jurisdiction" for anything Tenant-related — that word is still legitimately used elsewhere for two unrelated concepts: `Case.jurisdiction` (a free-text court/venue field) and `JurisdictionModule` (a dormant, admin-toggleable legal-ruleset feature flag). Neither was touched by the Tenant/Jurisdiction collapse.
_Status: assigned from the request's Origin host at both signup (`User.tenantId` — password signup and first-time Google signup, via `TenantRepo.findIdByCode`) and Organization creation (`Organization.tenantId`). Signup leaves `tenantId` null if the origin doesn't resolve to a known Tenant (e.g. local dev, direct API calls) rather than rejecting the request; Organization creation still hard-rejects an unresolved origin, unchanged from before._

**Email Verification**:
A blocking gate on password-based Signup: a User's `isEmailVerified` flag starts `false` and Login is refused until it's flipped `true` by successfully completing OTP verification. Not required for Google signups — Google has already verified the email, so `isEmailVerified` is set `true` at account creation.
_Avoid_: "OTP" alone as the name of the gate (OTP is the mechanism — the one-time code — not the gate itself; the gate is Email Verification)
_Status: designed, not yet implemented — see Pending._

**Benchmark**:
A fictional litigation bundle plus an assessment paper, under `benchmarks/<slug>/` (`docs/*.pdf`, `questions.json` incl. tenant/case fields, `rubric.json`, `answers/<date>/`). Seeded into a real org's case with `scripts/seed-benchmark.ts`, asked through the production chat path with `scripts/run-benchmark.ts`, scored by `scripts/grade-benchmark.ts` (AI grader over the full bundle text + a solicitor moderation sheet), history in `benchmarks/scores.md`. First one: `brackenmoor` (UK). Every architecture change to the legal pipeline is expected to be measured against it.
_Avoid_: "eval" for this (that word is used for the PH prompt eval set in chat-wonder); grading from the answer alone without the bundle text

**Whole-Case Inline**:
When a case's READY documents total at most `CASE_FULL_TEXT_INLINE_CHARS` (200k chars), `streamChatWonderMessage` sends every document's full text as `case_document_texts` alongside the ranked chunks and manifest; chat-wonder holds them in full for the turn. Larger cases keep the ranked-chunks + on-demand fetch behaviour.
_Avoid_: raising the threshold without raising chat-wonder's `CASE_DOCUMENT_TOKEN_BUDGET` to match

**Decision Record**:
The "Why?" behind one conclusion in a legal chat answer — rule applied, evidence for/against, the alternative considered and rejected, weighting, confidence, and what fact would change it. Generated and self-audited by chat-wonder-v2-api per turn (every `rule[].url` checked against that turn's retrieved pool, every `evidence*[].docId`/quote against the case's attached exhibits — this app never re-derives `verified`), persisted on `MessageDecisionRecord`, and promoted into a standalone `DecisionRecord` row per record (`DecisionRecordSvc.promote`, always `authorUserId: null`, mirroring `CaseTimelineSvc.promoteFromAi`) plus DECISION/DOCUMENT nodes and SUPPORTS/CONTRADICTS edges in the Case Graph. Surfaced as the "Decisions" Terminal panel, populated automatically — never generated on demand.
_Avoid_: editing or reassigning authorship when a lawyer disagrees — that's expressed as `status: DISPUTED` + `disputeNote` via the dispute/reactivate endpoints, the row itself is left as the AI produced it.
_Status: Phase 1 of `docs/plans/differentiation-program.md` Workstream A — complete. Generation/verification, persistence, case-graph promotion, list/dispute/reactivate API, snapshot wiring, the case-level Decisions panel, and an inline "Why?" affordance: each `anchor` is highlighted (whitespace-tolerant match, `components/shared/decision-anchor-match.ts`) directly in the chat bubble that produced it, opening a read-only detail drawer (`components/chat/decision-drawer.tsx`) — no dispute action there, since a non-case-linked consultation has no promoted `DecisionRecord` row to dispute against; dispute/reactivate stays a Decisions-panel-only action._

**Case Theory**:
One lawyer's account of the case — title, thesis, claims (each ASSERTS or DENIES, optionally linked to an existing CaseGraphNode), assumptions, open questions (differentiation program, Phase 2 — Workstream B). Several lawyers can hold different Case Theories of the same case side by side; the system never merges them into one. `authorUserId: null` marks an AI-proposed starting point (`CaseTheorySvc.propose`, seeded from the case's own findings, not fresh document reading) — adopted by forking (`forkedFromId`) into an editable, authored copy, never by editing the AI's draft in place. `TheoryDiffSvc.diff` reconciles two theories without picking a winner: it names what they share, what they genuinely disagree on, and for each disagreement the evidence that would decide it and what's missing — cached per unordered pair on `TheoryDiff`.
_Avoid_: "resolving" a diff by merging the two theories — the product's stance is that lawyers author, the AI only reconciles by naming deciding evidence.
_Status: built — CRUD, publish/retire lifecycle, fork, the reconciler (a crafted prompt + `[THEORY_DIFF]`/`[THEORY_PROPOSAL]` tagged-JSON parse in `theory-parse.ts`, not new chat-wonder-v2-api code — see the plan's "reuse what exists" principle), the "Theories" Terminal panel. Not built: realtime presence/live cursors (explicitly deferred in the plan until a transport is chosen), a dedicated "what changed since you last looked" strip (the existing snapshot-invalidates-on-mutation pattern covers the same need informally)._

**Annotation**:
A comment, dispute, or alternative reading attached to any case element (a decision, a graph node, an edge, a document chunk) — differentiation program, Phase 2. `authorUserId: null` marks one the system wrote itself: `DecisionRecordSvc.dispute` always writes one alongside flipping a decision to DISPUTED, so the disagreement has a durable, commentable home even for a lawyer who never opens a general annotation UI (`components/shared/annotation-thread.tsx`).
_Status: built — data model, CRUD API (VIEW can read, EDIT can author), wired into the Decisions panel and the Theories panel. Not wired into the Evidence detail drawer or Mind Map nodes yet, despite being named in the plan — flagged as deferred, same as Phase 1's inline chat-bubble affordance was before it shipped._

**Scene** (Grounded Reconstruction, Rung 1):
One beat of the case's most consequential episode — time, location, actors, action, any recorded dialogue, and `sourceRefs` (docId + page + an optional verbatim quote). Stored as `CaseReconstruction.scenes`, generated by a dedicated action (`CaseReconstructionSvc.generateScenes`, not folded into the main narrative generate) from the case's timeline + evidence, not by re-reading the narrative. Every `sourceRef` is verified before being kept (docId resolves to a real case document; a given quote actually appears in that document's sampled text — `case-reconstruction-scenes-parse.ts`'s `auditScenes`); an unverifiable ref is dropped, and a scene left with none gets a note in `unresolved` instead of shipping ungrounded. Each `unresolved` item is also promoted into a Weakness `CaseFinding` (deduped, additive-only) so the gap becomes investigation work, not just a UI footnote — differentiation program, Phase 3, Workstream C.
_Avoid_: `chunkId` as a sourceRef field — the plan's own sketch used one, but the case's excerpt-sampling pipeline (`buildFactExcerptPack`) only labels text by document + page, not by chunk id, so `docId`/`page`/`quote` is what's actually verifiable here.

**Table Read** (Grounded Reconstruction, Rung 2):
Multi-voice audio rendered from a case's `scenes` — one Polly voice per actor (deterministic per case, `table-read-voices.ts`'s `castForCase`), a narrator voice for action lines — reusing Audio Overview's synthesize-many-short-turns-then-ffmpeg-concat pipeline (`mergeCastTurnsToMp3`) rather than case reconstruction narration's single-voice async Polly task, for the same reason Audio Overview needed it: many short clips beat one call's length limits. `CaseReconstruction.tableReadStaleAt` is set whenever `scenes` is regenerated underneath it.
_Status: Rungs 1-2 built (scene script, table read audio) plus a Storyboard tab. Storyboard is a scope adaptation of Rung 3, not literal page-image rendering: this codebase has no PDF-to-image pipeline (only `pdf-parse` for text), so each scene's storyboard card shows its verified sourceRefs as text (document name, page, verbatim quote) rather than a rendered/cropped page image. True image rendering is a separate, deliberate infra decision (a new dependency, likely with native build tooling) — not attempted blind. Rung 4 (video) stays out of scope per the plan itself._

## Example dialogue

> **Dev:** "Should logout delete the User's row in the DB?"
> **Domain expert:** "No — logout only ever touches a Session, never the User. It deletes the one Session tied to the refresh token the client sent."
> **Dev:** "So if I'm logged in on my phone and laptop, logging out on my phone kills both?"
> **Domain expert:** "No — each device gets its own Session when it logs in. Logging out on your phone deletes only your phone's Session row; your laptop's Session is untouched."
