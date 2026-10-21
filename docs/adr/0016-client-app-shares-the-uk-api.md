# 0016: The client app shares this API and the UK database; an engaged lawyer reaches the client's case through a read-only grant

## Status

Accepted (FORHU/ilovelawyer-app#845). One change from the first draft: the client can also end an engagement, not only the lawyer.

## Context

The UK client-to-lawyer hand-off (FORHU/ilovelawyer-app#862) connects two apps. Clients use the client app (ilovelawyer-client, ilovelawyer.com). Lawyers receive and take on clients in ilovelawyer-app (uk.ilovelawyer.com). After a client confirms a lawyer, the lawyer needs the client's case. How that works depends on where the client app's data lives. There are two choices: a permission grant in one database, or a sync between two systems.

Part of this is already built. Since #501 the client app signs in against this API. Clients and lawyers share the `User` table, and `User.role` says which app an account belongs to (`USER` or `LAWYER`, see CONTEXT.md, **Client App**). Every `USER` account is created in the UK tenant. What isn't built yet is the client's data: cases, documents and AI chat are still mocked in the client app's `localStorage`.

These existing pieces already do most of what the hand-off needs:

- `CaseAccess` grants with `VIEW`/`EDIT`/`ADMIN`, checked on every case route (`utils/case-access.ts`).
- `CaseShareSvc`, which shares a case from someone's personal workspace with another user on the same tenant, read-only. Every write is refused with `SHARE_READ_ONLY`. Revoking the share removes the recipient's sockets from the case room (`removeUserFromCase`).
- `CaseCopySvc`, which copies a case into another workspace and records where it came from (`copiedFromCaseId`).
- Per-case AI usage in `LlmUsage.caseId`, and per-user and per-case socket rooms (`lib/socket.ts`).
- The UK stack runs in London (eu-west-2), and its documents stay in eu-west-2 (#319).

## Decision

**The client app uses this API and the UK stack's database. It has no backend of its own.**

1. A client's case is an ordinary `Case` in the client's personal workspace (`Organization.isPersonal`) on the UK tenant. The case's documents and consultations sit beside it, as they do for a lawyer. Moving the client app's cases, documents and chat from `localStorage` into the API is a prerequisite of the hand-off. No sub-issue of #862 covers it yet.
2. A **Client Request** is a new table that points at the client's case. It records the request's status, the anonymised brief, the claim, the quote, the per-case charge and the engagement. It is the only part of a client's data that a lawyer sees before engagement.
3. When the client confirms the lawyer and the per-case fee is paid, the lawyer gets a `VIEW` `CaseAccess` grant on the client's case. This is the same read-only share `CaseShareSvc` makes, except the system makes it, because the client's confirmation is the owner's consent. Closing the engagement removes the grant the same way a share is revoked.
4. Production is the London stack. The client app must point at the UK API in production. The shared Singapore host only serves staging.

### Engagement access model

| | Before engagement (ROUTED) | Claimed (CLAIMED / QUOTED) | Engaged (ENGAGED) | Closed (CLOSED) |
| --- | --- | --- | --- | --- |
| **Who** | Every matching lawyer | The claiming lawyer only | The assigned lawyer only | Nobody, live |
| **What they see** | The anonymised brief: AI summary, practice area, UK jurisdiction, urgency, client's note. No names, no documents. | The brief, plus the names of the case's parties, for the conflict check | The client's live case, read-only: documents, the client's AI chat and analysis, parties. The engagement thread. | Their workspace copy, if they made one. The thread, read-only. |
| **How** | `ClientRequest` row | `ClientRequest` + claim-scoped party lookup (audited) | `CaseAccess` `VIEW` grant on the client's case | Grant removed. The copy is the lawyer's own case. |

- **Live, not a snapshot.** The grant reads the client's case itself, so documents the client adds later appear for the lawyer. They're pushed as an `engagement:document-added` event. The existing `document:*` events only reach the uploader.
- **Copy to my workspace** uses `CaseCopySvc`. The copy is a snapshot at the moment it's made. It stays in the lawyer's organization after close, however the engagement ended: UK solicitors are expected to keep their client files after a matter ends, so it is never deleted on close. It records its source case (`copiedFromCaseId`) and the Client Request it came from, so AI use on the copy counts against that engagement's budget.
- **Read-only means no AI on the client's case.** AI work writes analysis into the case, and that would change what the client sees. The lawyer uses AI on their workspace copy, metered against the engagement's AI budget. A lawyer who hasn't copied the case can still read everything.
- **Access ends** when either side ends the engagement: the lawyer closes it, or the client ends it from the client app. It's the client's data, so they never have to ask the lawyer to let go. It also ends when the client deletes the case or their account. Nothing the client adds after that reaches the lawyer. If the request is reassigned to another member of the firm, the grant moves to the new lawyer. The firm's OWNER/ADMIN see the request and its charges, but not the case, unless they are the assigned lawyer. This follows the existing rule that only the assigned person gets a per-case grant (decisions D1–D8, #331).
- **Every access step is audited.** That covers claim, the party-name lookup, release, grant, reassign and close. They are written to `AuditEvent` on the client's case and `SecurityAuditEvent` (`SecurityAuditSvc`), like other access changes.

## Considered options

- **A: Shared API and database (chosen).**
  - *Data residency:* everything (accounts, cases, documents in S3, AI logs) stays in one London stack.
  - *Privilege and confidentiality:* the client's documents stay in one place, behind one access layer (`CaseAccess`) that is already tested and audited. Nothing has to be copied between systems to engage a lawyer, and nothing has to be deleted from a second system when access ends or a client asks for their data to be erased. The risk is that a bug in an access check exposes a client's case to a lawyer. The role split (`WRONG_APP`), read-only grants and the per-route tests limit that.
  - *Effort:* lowest. Auth is done, and grants, read-only sharing, copying, socket rooms and AI metering already exist.
- **B: A separate backend for the client app, synced to the lawyer platform.** This gives a smaller blast radius per system. But engaging a lawyer would mean copying privileged documents into a second database, keeping two copies in step (new documents, withdrawals, close), deleting from both on request, and running a second London stack to keep data in the UK. It also means building a second auth system, a sync API with its own failure handling, and cross-system events. Rejected: more effort and more copies of privileged material, for isolation the role split already gives.
- **C: Shared API, separate database or schema for client data.** This keeps one auth system but brings back B's cross-database grants and copies, and gives up foreign keys between `ClientRequest`, `Case` and `CaseAccess`. Rejected for the same reasons as B, with less benefit.

## Consequences

- Moving client cases, documents and chat into the API has to be planned and built before the brief generator (#508) and the engagement grant (#514). It also needs the client app's own case payment (the per-case fee and top-ups the client pays). Today that is mocked, and it isn't part of #862.
- Every client account and case is stored in London, including PH and US clients, who see "Not available yet" for a lawyer. This is consistent with every `USER` account already being on the UK tenant.
- Lawyers' Stripe billing (#505) should be built on the payment-provider module that the PH subscriptions plan describes (`src/payments/`, `BillingWebhookEvent` idempotency, raw-body webhook mount). There should be one Stripe integration, not two.
- The engagement's AI budget is shown to the lawyer: a meter, a warning at 80%, top-ups. The internal case allowance in `CaseLimitsSvc` is never shown. The two stay separate. An engaged case's usage counts against the engagement budget, not the hidden allowance.
- The client's consent text has to say that the claiming lawyer sees party names for the conflict check, and that the lawyer may keep a copy of the case after the engagement ends. This goes to the solicitor review in FORHU/ilovelawyer-app#846, together with the referral-fee disclosure.
