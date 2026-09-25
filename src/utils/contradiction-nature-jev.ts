import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, readChoice } from "./jev-common";

/**
 * Jev as a second reader of each scanned contradiction: given the two passages the scan paired,
 * is the conflict stated outright, does it only follow by inference, or is it not a conflict at
 * all (e.g. two different events that share a fact key)? Replaces the Contradictions panel's
 * banded scan confidence with a classification someone can check against the two quotes shown
 * under it. Off unless USE_JEV_CONTRADICTIONS=true — run scripts/jev-contradiction-benchmark.ts
 * against lawyer-labelled contradictions before turning it on.
 */

export function isContradictionJevEnabled(): boolean {
  return process.env.USE_JEV_CONTRADICTIONS === "true";
}

export const CONTRADICTION_NATURES = ["DIRECT", "INFERENTIAL", "NOT_A_CONFLICT"] as const;
export type ContradictionNatureValue = (typeof CONTRADICTION_NATURES)[number];

const NATURE_DEFINITIONS: Record<ContradictionNatureValue, string> = {
  DIRECT:
    "the two passages expressly state incompatible values for the same fact about the same event or thing — both cannot be true as written",
  INFERENTIAL:
    "neither passage states the opposite of the other, but what one says implies something the other rules out (e.g. payroll running through 8 August implies employment continued past an abandonment said to start on 4 August)",
  NOT_A_CONFLICT:
    "the passages are about different events, periods, people or amounts, or can both be true together — the scan paired them only because they share a kind of fact",
};

/** NOT_A_CONFLICT is the verdict that would talk a lawyer out of a real contradiction, so like
 * CONTRADICTED in assertion-check.ts it needs this much confidence; below it the row is recorded
 * as INFERENTIAL — still shown as a conflict, just not an express one. Provisional: re-set from
 * the benchmark. */
export const NOT_A_CONFLICT_MIN_CONFIDENCE = 0.7;

export interface ContradictionNatureInput {
  factKey: string;
  left: { document: string; excerpt: string; value: string };
  right: { document: string; excerpt: string; value: string };
}

export interface ContradictionNatureResult {
  /** After the NOT_A_CONFLICT floor — what to show for a contradiction a scan already claimed. */
  nature: ContradictionNatureValue;
  confidence: number;
  /** Jev's own answer, before the floor. The full-bundle scan uses this instead: there the pair
   * was proposed by code, not claimed by a scan, so an unsure NOT_A_CONFLICT means "drop it". */
  rawNature: ContradictionNatureValue;
}

/** Throws on a Jev failure — the caller stores null rather than a guess. */
export async function classifyContradictionWithJev(input: ContradictionNatureInput): Promise<ContradictionNatureResult> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "contradiction-nature", factKey: input.factKey });
  const response = await client.systemOne({
    state: {
      fact: input.factKey.replace(/_/g, " "),
      passageA: { document: input.left.document, text: input.left.excerpt, valueFound: input.left.value },
      passageB: { document: input.right.document, text: input.right.excerpt, valueFound: input.right.value },
    },
    questions: {
      nature: choice(
        "A document scan flagged `passageA` and `passageB` as conflicting on `fact` (`passageA.valueFound` vs `passageB.valueFound`). Reading only the two texts, classify the conflict:\n" +
          CONTRADICTION_NATURES.map((n) => `${n} — ${NATURE_DEFINITIONS[n]}`).join("\n"),
        Object.fromEntries(CONTRADICTION_NATURES.map((n) => [n, null])) as Record<ContradictionNatureValue, null>,
      ),
    },
  });

  const answer = response.answers.nature;
  const raw = readChoice<ContradictionNatureValue>(answer.choice, CONTRADICTION_NATURES, "INFERENTIAL");
  const { value: nature, downgraded } = applyFloor(raw, answer.confidence, "NOT_A_CONFLICT", NOT_A_CONFLICT_MIN_CONFIDENCE, "INFERENTIAL");
  logger.info("Jev response", { feature: "contradiction-nature", nature, rawNature: raw, downgraded, confidence: answer.confidence });
  return { nature, confidence: answer.confidence, rawNature: raw };
}
