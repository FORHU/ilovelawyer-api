# 0018: The client app's chat and Overview gather and organise information; they don't assess the case

## Status

Accepted (docs/plans/client-side-compressed-meteor.md).

## Context

The client app (ilovelawyer-client) is meant to be a digital secretary: it should help someone
explain their situation, organise what they've said and uploaded, and hand a lawyer a clear
intake package. It should never act as the client's lawyer.

Two things in the current build cut against that:

1. **Chat.** `ClientCaseSvc.sendMessage` sends every client message through the same pipeline a
   lawyer's research chat uses (`ChatSvc.enqueueChatGeneration`), tagged `[legal ai uk]`
   (`src/utils/chatWonder.ts`). That persona's prompt (chat-wonder-v2-api's
   `resources/prompts/legal_prompt_uk.txt`) opens with a direct, second-person answer and a
   recommendation, which reads as advice, not an interview.
2. **Overview.** `ClientOverviewSvc` runs the lawyer's own panels — `CaseStrategySvc` (plan, to-dos,
   computed key dates), `CaseFindingAiSvc` (STRENGTH/WEAKNESS findings, shown as "Points that
   help"/"Points that may hurt") and `MissingEvidenceAiSvc` — and shows their output to the
   client. A computed "last day to claim" and a STRENGTH/WEAKNESS verdict are case assessments; a
   secretary doesn't make either.

## Decision

**The client app's chat and its summary tab extract and organise what the client has said and
uploaded. Neither one assesses the case, proposes a strategy, predicts an outcome, or tells the
client what to do.**

1. **Chat persona.** Client chat moves to its own persona, tagged separately from
   `[legal ai uk]`/`[legal ai]` (`INTAKE_TAG_UK`, behind `CLIENT_INTAKE_PERSONA`), with
   `skip_legal_verify: true` and no mind map. The persona's own prompt is chat-wonder-v2-api's to
   write (docs/plans/intake-persona-contract.md is its contract); this API only tags the request
   and supplies `intake_context`. Until that persona ships, the flag stays off and today's
   behaviour is unchanged.
2. **Overview replacement.** A new `ClientIntakeSvc` extracts one `CaseIntake`
   (`src/types/client-intake.ts`) from the case details, the chat transcript and READY documents:
   people, a timeline, facts, goals, concerns, questions for a lawyer, deadlines **exactly as
   stated** (never computed), missing information, and conflicting accounts. Every item carries
   its source — a case-form field, a chat message, or a document and page — so nothing is shown
   as settled fact that the client didn't say or a document doesn't actually contain.
   `ClientOverviewSvc`'s `helps`/`mayHurt`/computed `keyDates` have no equivalent here: they stay
   lawyer-only, in the Terminal. `ClientOverviewSvc` keeps running unchanged until the client app
   has moved onto the Intake tab (Phase 6 of the plan above), then is retired.
3. **Lawyer handover.** The same `CaseIntake`, redacted, folds into the lawyer's pre-claim brief
   (`CaseBrief.intake`) and — once engaged — into a new `GET /client-requests/:id/intake-package`,
   audited the same way `ClientRequestLawyerSvc.parties` is. The lawyer's Terminal pipeline is
   untouched; this is additional read access to the client's intake, not a replacement for it.

### What this doesn't change

- `CaseStrategySvc`, `CaseFindingAiSvc`, `MissingEvidenceAiSvc` and the rest of the Terminal
  pipeline keep running exactly as they do today, for lawyer cases.
- Lawyer chat keeps the `[legal ai uk]`/`[legal ai]` tag and the mind map, unconditionally.
- `CaseAccess`/engagement access (ADR 0016) is unchanged; the intake package is read through the
  same grant, not a new one.

## Consequences

- A client case now runs two AI summarisation jobs side by side for a time (`clientOverview` and
  `clientIntake`), with separate budgets and daily caps, until the overview is retired.
- The client-facing consent and Terms copy (`ilovelawyer-client/src/lib/auth/terms.ts`) and the
  lawyer-request consent text describe an AI that "explains how the law may apply" and lawyers who
  see "an anonymised summary" — both need a solicitor-reviewed rewrite once the structured intake
  ships, since the client sees more structure and the lawyer sees more of it pre-claim than either
  implies today. Flagged in the plan, not resolved by this ADR.
