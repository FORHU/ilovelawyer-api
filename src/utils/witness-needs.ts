import { FACTOR_DEFINITIONS, FACTOR_KEYS, type FactorAnswers, type FactorKey } from "./witness-rubric";

/**
 * "What's needed" for a witness whose account couldn't be fully assessed. One flat list: the
 * lawyer isn't told whether an item is done inside the app or out in the world. An item either
 * carries a `link` to the place in the app that settles it, or is instructions only (chase a bank,
 * interview the witness). Ticking one off is the lawyer's own record; the app can't verify it.
 */
export type NeedLink = "STATEMENT" | "EVIDENCE" | "FACTOR";

export interface WitnessNeed {
  /** Stable across rescores, so a ticked item stays ticked: STATEMENT, DOCUMENT or FACTOR_<letter>. */
  key: string;
  text: string;
  link: NeedLink | null;
  factor?: FactorKey;
  /** For a FACTOR item: what is being asked and the options a lawyer can pick, in plain words. */
  question?: string;
  options?: { value: string; label: string }[];
}

export interface NeedsInput {
  statementReceived: boolean;
  sponsoredDocumentCount: number;
  answers: FactorAnswers;
  /** Chat Wonder's suggested next step per factor it could not answer. */
  aiNeeds: Partial<Record<FactorKey, string>>;
}

export function buildNeeds({ statementReceived, sponsoredDocumentCount, answers, aiNeeds }: NeedsInput): WitnessNeed[] {
  const needs: WitnessNeed[] = [];
  if (!statementReceived) {
    needs.push({
      key: "STATEMENT",
      text: "Obtain the witness's signed statement, then mark it as received.",
      link: "STATEMENT",
    });
  }
  if (sponsoredDocumentCount === 0) {
    // With nothing linked every factor is unanswered; listing seven of them would bury the one fix.
    needs.push({
      key: "DOCUMENT",
      text: "Link the document this witness speaks to in the Evidence panel. Nothing can be assessed without one.",
      link: "EVIDENCE",
    });
    return needs;
  }
  for (const factor of FACTOR_KEYS) {
    if (answers[factor]) continue;
    needs.push({
      key: `FACTOR_${factor}`,
      text: aiNeeds[factor] ?? `Not shown in the papers: ${FACTOR_DEFINITIONS[factor].question} Add the detail to the case, or set it yourself.`,
      link: "FACTOR",
      factor,
      question: FACTOR_DEFINITIONS[factor].question,
      options: Object.entries(FACTOR_DEFINITIONS[factor].options).map(([value, label]) => ({ value, label })),
    });
  }
  return needs;
}

/** A ticked-off "what's needed" item. Proof is required: the id of a document or photo in this
 * case's Documents section. `by` and `at` are set by the server, never taken from the client. */
export interface NeedDone {
  key: string;
  documentId: string;
  note?: string;
  by: string;
  at: string;
  /** What Jev made of the fit between the document and the requirement, when it was checked. */
  match?: { verdict: "SATISFIES" | "PARTLY" | "CANNOT_TELL"; confidence: number };
}

export interface NeedDoneInput {
  key: string;
  documentId: string;
  note?: string;
}

function parseMatch(raw: unknown): NeedDone["match"] {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (m.verdict !== "SATISFIES" && m.verdict !== "PARTLY" && m.verdict !== "CANNOT_TELL") return undefined;
  return { verdict: m.verdict, confidence: typeof m.confidence === "number" ? m.confidence : 0 };
}

/** Reads the stored column. Old entries were bare key strings with no proof; they no longer count
 * as done, so a tick can't stand without evidence. */
export function parseNeedsDone(raw: unknown): NeedDone[] {
  if (!Array.isArray(raw)) return [];
  const out: NeedDone[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.documentId !== "string") continue;
    out.push({
      key: o.key,
      documentId: o.documentId,
      note: typeof o.note === "string" && o.note ? o.note : undefined,
      by: typeof o.by === "string" ? o.by : "",
      at: typeof o.at === "string" ? o.at : "",
      match: parseMatch(o.match),
    });
  }
  return out;
}

/**
 * Turns the client's desired list into what gets stored. An entry that is unchanged (same key and
 * same proof document) keeps its recorded who/when; a new or re-proved one is stamped now. Any
 * entry whose document is not in this case's Documents is returned in `rejected` so the caller can
 * refuse the whole change instead of storing a tick with no valid proof.
 */
export function mergeNeedsDone(
  existing: unknown,
  incoming: NeedDoneInput[],
  caseDocumentIds: Set<string>,
  userId: string,
  now: Date,
  matches: Map<string, NonNullable<NeedDone["match"]>> = new Map(),
): { done: NeedDone[]; rejected: string[] } {
  const current = new Map(parseNeedsDone(existing).map((d) => [d.key, d]));
  const done: NeedDone[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const item of incoming) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (!caseDocumentIds.has(item.documentId)) {
      rejected.push(item.key);
      continue;
    }
    const prior = current.get(item.key);
    const note = item.note?.trim() || undefined;
    if (prior && prior.documentId === item.documentId && prior.note === note) {
      done.push(prior);
    } else {
      const match = matches.get(item.key);
      done.push({
        key: item.key,
        documentId: item.documentId,
        ...(note ? { note } : {}),
        by: userId,
        at: now.toISOString(),
        ...(match ? { match } : {}),
      });
    }
  }
  return { done, rejected };
}
