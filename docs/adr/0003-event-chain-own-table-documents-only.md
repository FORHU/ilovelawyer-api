# 0003: The Event Chain is stored in its own table and built from documents alone

## Status

Accepted

## Context

Scenes live in a column on `CaseReconstruction`, a row that only exists once a narrative has been generated. The first Event Chain followed that pattern. The chain never reads the narrative, but storing it there meant it could not be built until a narrative existed, and the endpoint refused with "generate the narrative first" — a requirement created by where the data happened to be stored, not by anything the feature needs.

## Decision

The chain lives in its own table, `CaseReconstructionEvents`, one row per case. Building it requires only that the case has at least one processed document. It reaches the app as `snapshot.reconstructionEvents` — not `events`, which is the case's calendar. Regenerating replaces the whole chain.

## Considered options

- **A column on `CaseReconstruction`** (what scenes do). Rejected: ties the chain's existence to the narrative's.
- **Make `CaseReconstruction.narrative` nullable, or insert a placeholder row with an empty narrative.** Rejected: every reader of the narrative would have to cope with the empty case, and the panel already treats a non-empty narrative as "a reconstruction exists".

## Consequences

- One more single-row lookup in every case snapshot.
- The chain no longer goes stale when the narrative is edited or regenerated: they are separate generations, and a case that has one may not have the other.
- A refusal can only name documents to upload or wait for, never a narrative to generate.
