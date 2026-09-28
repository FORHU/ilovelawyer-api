import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { isUncertain, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";

/**
 * Jev as the check behind the Attack Strategies panel. Chat Wonder still finds each move and
 * notes why it's ready, drafting or blocked; Jev then reads it against the case data:
 *
 *   - readiness  Choice — is this move usable now, still being worked on, or blocked on a
 *                specific missing prerequisite?
 *
 * The row's pill (READY/DRAFTING/BLOCKED) comes from this instead of the drafting model's own
 * call. Off unless USE_JEV_ATTACK_STRATEGY=true — run scripts/jev-attack-strategy-benchmark.ts
 * against lawyer-labelled moves before turning it on.
 */

export function isAttackStrategyJevEnabled(): boolean {
  return process.env.USE_JEV_ATTACK_STRATEGY === "true";
}

export const READINESS_VERDICTS = ["READY", "DRAFTING", "BLOCKED"] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

export interface AttackStrategyJevCheck {
  readiness: ReadinessVerdict;
  readinessConfidence: number;
  uncertain: boolean;
}

export interface AttackStrategyJevInput {
  label: string;
  detail: string | null;
  sourceLabel: string | null;
}

export function tagFromCheck(check: Pick<AttackStrategyJevCheck, "readiness">): ReadinessVerdict {
  return check.readiness;
}

/** Throws on a Jev failure — the caller keeps the model's rating rather than a guess. */
export async function checkAttackStrategyWithJev(move: AttackStrategyJevInput, context: CaseJevContext): Promise<AttackStrategyJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "attack-strategy", label: move.label });

  const response = await client.systemOne({
    state: {
      move: { step: move.label, note: move.detail ?? "", source: move.sourceLabel ?? "" },
      caseData: caseDataState(context),
    },
    questions: {
      readiness: choice(
        "`move.step` is a concrete step to advance the user's own case; `move.note` is the drafting model's reason for its status. Judging from `move.note` and `caseData`, classify whether it's usable now: READY if it can be used as-is with what's already available; DRAFTING if it's a sound direction but still needs work, with nothing specific shown as missing; BLOCKED only if `move.note` or `caseData` points to a specific missing prerequisite (a certification, exhibit, affidavit, or similar) that has to be obtained first — never guess BLOCKED from silence.",
        { READY: null, DRAFTING: null, BLOCKED: null },
      ),
    },
  });

  const answer = response.answers.readiness;
  const check: AttackStrategyJevCheck = {
    readiness: readChoice<ReadinessVerdict>(answer.choice, READINESS_VERDICTS, "DRAFTING"),
    readinessConfidence: answer.confidence,
    uncertain: isUncertain(answer.confidence),
  };
  logger.info("Jev response", { feature: "attack-strategy", label: move.label, ...check });
  return check;
}
