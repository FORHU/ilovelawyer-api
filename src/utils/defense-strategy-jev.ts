import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { isUncertain, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";

/**
 * Jev as the check behind the Defense Strategies panel. Chat Wonder still finds each anticipated
 * defense and drafts this case's answer to it; Jev then reads the answer against the case data:
 *
 *   - defenseStatus  Choice — does the answer fully rebut the defense, only partly, or not at all?
 *
 * The row's pill (ANSWERED/PARTIAL/UNANSWERED) comes from this instead of the drafting model's
 * own call. Off unless USE_JEV_DEFENSE_STRATEGY=true — run
 * scripts/jev-defense-strategy-benchmark.ts against lawyer-labelled defenses before turning it on.
 */

export function isDefenseStrategyJevEnabled(): boolean {
  return process.env.USE_JEV_DEFENSE_STRATEGY === "true";
}

export const DEFENSE_STATUS_VERDICTS = ["ANSWERED", "PARTIAL", "UNANSWERED"] as const;
export type DefenseStatusVerdict = (typeof DEFENSE_STATUS_VERDICTS)[number];

export interface DefenseStrategyJevCheck {
  defenseStatus: DefenseStatusVerdict;
  defenseStatusConfidence: number;
  uncertain: boolean;
}

export interface DefenseStrategyJevInput {
  /** The anticipated defense. */
  label: string;
  /** This case's answer to it, if any. */
  detail: string | null;
  sourceLabel: string | null;
}

export function tagFromCheck(check: Pick<DefenseStrategyJevCheck, "defenseStatus">): DefenseStatusVerdict {
  return check.defenseStatus;
}

/** Throws on a Jev failure — the caller keeps the model's rating rather than a guess. */
export async function checkDefenseStrategyWithJev(
  defense: DefenseStrategyJevInput,
  context: CaseJevContext,
): Promise<DefenseStrategyJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "defense-strategy", label: defense.label });

  const response = await client.systemOne({
    state: {
      defense: { claim: defense.label, answer: defense.detail ?? "", source: defense.sourceLabel ?? "" },
      caseData: caseDataState(context),
    },
    questions: {
      defenseStatus: choice(
        "`defense.claim` is a defense the opposing party is expected to raise against the user's case; `defense.answer` is this case's rebuttal to it, if drafted. Judging from `defense.answer` and `caseData`, classify how complete the rebuttal is: ANSWERED if `defense.answer` fully addresses `defense.claim` with what `caseData` shows; PARTIAL if it addresses part of it but something material is still open or unaddressed; UNANSWERED if there is no real rebuttal yet.",
        { ANSWERED: null, PARTIAL: null, UNANSWERED: null },
      ),
    },
  });

  const answer = response.answers.defenseStatus;
  const check: DefenseStrategyJevCheck = {
    defenseStatus: readChoice<DefenseStatusVerdict>(answer.choice, DEFENSE_STATUS_VERDICTS, "UNANSWERED"),
    defenseStatusConfidence: answer.confidence,
    uncertain: isUncertain(answer.confidence),
  };
  logger.info("Jev response", { feature: "defense-strategy", label: defense.label, ...check });
  return check;
}
