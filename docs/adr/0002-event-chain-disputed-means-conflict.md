# 0002: Disputed means the record contradicts an event, never that only one side says it

## Status

Accepted

## Context

The design for Case Reconstruction's Event Chain shows rows such as "04 Aug — abandonment alleged to begin · asserted in the termination letter only · Disputed". The first implementation read that as a rule: a claim only one party makes is Disputed. It was wrong. In the mock the row was disputed because payroll ran through 8 August; "asserted in the letter only" described the row, it wasn't the reason for the badge.

Judging every event only against the passage its own quote sits in went wrong in both directions on an end-to-end run against a fictional employment dispute: the employer's "absent without leave from 4 August" came out Verified at 100% because its termination letter does say that, while the payroll and attendance records contradict it; and the employee's own "I reported for work" came out Disputed while the attendance log confirmed it. Her uncontested start date also came out Disputed, and reading the code showed a claim whose cross-check simply failed would have too.

## Decision

**Disputed only ever follows from a conflict:** the event's own source contradicts it, or another document does. A party's claim nothing confirms, a witness account nothing else backs, an event with no findable source, and a check that could not run are all **Unverified** — silence is not doubt. An independent document that shows a party's or witness's account makes it **Verified**.

Events someone is answerable for (a party's or a witness's account, or anything the generator attributed to someone) are therefore also checked against what the case's other documents say on the same date. A contradiction there overturns even a claim its own source states outright.

## Considered options

- **Party-only means Disputed** (the literal reading of the design). Rejected: the badge tells a lawyer "contested" about facts nobody contests.
- **Judge each event only against its own source.** Rejected for the two failures above; a source cannot see a contradiction that lives in a different document.

## Consequences

- The cross-document check reads at most six documents that mention the event's date, ranked by how much of the event's wording they share. Word overlap is a weak ranker (a pleading calls the employee "petitioner" while payroll rows name her), so in a bundle with more than six documents on one date a real contradiction can be missed. The event then stays Unverified: the safe direction, but a limit.
- The confidence thresholds are provisional, set from a small hand-labelled benchmark (`scripts/jev-reconstruction-benchmark.ts`, whose cases and documents are kept out of the repository), not from lawyer-labelled data. Run it before enabling `USE_JEV_RECONSTRUCTION`.
- "Disputed" is also the status a lawyer gives an AI-written Decision Record when they disagree with it. The two share a word and nothing else; `CONTEXT.md` keeps them apart.
