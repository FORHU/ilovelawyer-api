import type { BundleFact } from "./bundle-facts";

const MAX_ANCHORS = 150;

/**
 * The case's dated moments as a chronological list the model builds events from, so the chain
 * rests on every date in the bundle rather than on whatever a sampled excerpt pack happened to
 * include. Deterministic (bundle-facts.ts, no AI). One line per date per document; when there are
 * more than MAX_ANCHORS, dates that several documents share come first, since those are the ones a
 * chain can corroborate.
 */
export function buildDateAnchorPack(facts: BundleFact[], docName: Map<string, string>, max = MAX_ANCHORS): string {
  const perDoc = new Map<string, BundleFact>();
  for (const f of facts) {
    if (f.kind !== "date") continue;
    const key = `${f.value}|${f.documentId}`;
    if (!perDoc.has(key)) perDoc.set(key, f);
  }
  const docsPerDate = new Map<string, number>();
  for (const f of perDoc.values()) docsPerDate.set(f.value, (docsPerDate.get(f.value) ?? 0) + 1);

  const chosen = [...perDoc.values()]
    .sort((a, b) => (docsPerDate.get(b.value) ?? 0) - (docsPerDate.get(a.value) ?? 0) || a.value.localeCompare(b.value))
    .slice(0, max)
    .sort((a, b) => a.value.localeCompare(b.value) || a.documentId.localeCompare(b.documentId));

  return chosen
    .map((f) => {
      const where = [f.locator, docName.get(f.documentId)].filter(Boolean).join(", ");
      const inferred = f.yearInferred ? " (year inferred)" : "";
      return `- ${f.value}${inferred} [docId ${f.documentId}${where ? `; ${where}` : ""}]: ${f.sentence}`;
    })
    .join("\n");
}

export interface EventsPromptInput {
  docs: { id: string; name: string }[];
  anchors: string;
  excerpts: string;
}

/** Asks for the case as dated events stated as facts, each with one verbatim source quote. The
 * proposition rule is load-bearing: benchmarks/reconstruction case E11 shows an "alleged to begin"
 * event cannot be checked against payroll, while the same event stated as a fact is contradicted
 * by it at 94-100%. */
export function buildCaseReconstructionEventsPrompt(input: EventsPromptInput): string {
  const docsBlock = input.docs.map((d) => `- \`${d.id}\` — ${d.name}`).join("\n");
  return `[legal ai]

## ROLE
You assemble the dated event chain of this case from its documents. Each event is later checked against its source by a separate verifier, so precision matters more than coverage.

## TASK
List the events that matter to the case in date order. For each event give:
- "date": the date it happened, as YYYY-MM-DD, or null if the documents give no usable date.
- "proposition": what happened, written as a plain statement of fact about the world — "Doe was absent without leave from 4 August", not "abandonment is alleged to begin on 4 August". Do not use "alleged", "claims", "asserts" or "purportedly": the source's claim goes in "assertedBy". Keep it to one checkable statement; split compound events.
- "assertedBy": who says so, as the source presents it (e.g. "Acme HR, termination letter", "Doe, sworn statement"), or null if the document just records it (a docket stamp, a payroll line).
- "docId", "page" and "quote": the ONE document that best states the event, and a quote copied character-for-character from EXTRACTED TEXT below. The quote is required: an event with no quote cannot be checked and cannot be verified. If you cannot copy a verbatim quote for an event, leave that event out — do not paraphrase one and do not omit the field.

Give each fact once. If several documents record it, cite the best one as its source — other documents are checked against your event separately, so do not repeat it. Merge routine day-by-day records (payroll rows, clock-in times, receipts) into one event covering the whole run, dated at its start; only split them if one day differs from the rest.

Do not merge two documents' accounts into one event and do not resolve a disagreement between them: when they disagree, give each side's version as its own event, with its own source.

## DATED FACTS FOUND IN THE DOCUMENTS
Every date in the bundle, with the sentence around it. Build events from these; a date not on this list needs a quote that supports it.
${input.anchors || "(none found)"}

## DOCUMENTS
${docsBlock}

## EXTRACTED TEXT
${input.excerpts || "(no indexed text)"}

## OUTPUT
Reply with exactly this block and nothing else:

[EVENTS]
[{"date": "2026-08-06", "proposition": "...", "assertedBy": "...", "docId": "...", "page": 3, "quote": "a verbatim substring of EXTRACTED TEXT"}]
[/EVENTS]

Cap at 40 events. Order by date, undated last.`;
}
