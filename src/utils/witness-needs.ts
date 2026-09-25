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
    });
  }
  return needs;
}
