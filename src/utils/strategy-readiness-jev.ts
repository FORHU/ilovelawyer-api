import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

export type StrategyReadinessValue = "READY" | "DRAFTING" | "BLOCKED";

/** Below this the suggestion isn't worth a lawyer's attention — mirrors AUTHORITY_JEV_MIN_CONFIDENCE.
 * The app mirrors this value for the row chip. */
export const STRATEGY_READINESS_JEV_MIN_CONFIDENCE = 0.7;

/** Jev calls run in parallel alongside AI finding generation, so one slow call must not hold up
 * the others or the overall regeneration for long. */
const JEV_TIMEOUT_MS = 8000;

export interface StrategyReadinessJevInput {
  label: string;
  sourceLabel?: string | null;
  /** The model's own reason, if any — Jev reads it but forms its own view of `readiness`. */
  readinessNote?: string | null;
}

/** Off unless USE_JEV_STRATEGY_READINESS=true — see .env.example. Read per call so a test can flip it. */
export function isStrategyReadinessJevEnabled() {
  return process.env.USE_JEV_STRATEGY_READINESS === "true";
}

function buildStrategyReadinessState(input: StrategyReadinessJevInput): Record<string, string> {
  const state: Record<string, string> = { move: input.label.trim() };
  const optional: [string, string | null | undefined][] = [
    ["groundedIn", input.sourceLabel],
    ["modelReason", input.readinessNote],
  ];
  for (const [key, value] of optional) {
    if (value?.trim()) state[key] = value.trim();
  }
  return state;
}

/** Second opinion on how ready an attack/defense strategy move is. Returns null when the flag is
 * off, Jev errors or times out — the caller saves the row either way. */
export async function suggestStrategyReadiness(
  input: StrategyReadinessJevInput,
): Promise<{ readiness: StrategyReadinessValue; confidence: number } | null> {
  if (!isStrategyReadinessJevEnabled()) return null;

  try {
    const state = buildStrategyReadinessState(input);
    logger.info("Jev request", { feature: "strategy-readiness", question: "readiness", state });
    const call = getTypeSafeClient().systemOne({
      state,
      questions: {
        readiness: choice(
          "A lawyer's `move` is a concrete attack/defense strategy step for their case. Classify whether it's actually usable right now: READY if it can be used as-is with what's already available; DRAFTING if it's a sound direction but still needs work (a document to write, an argument to flesh out) with no specific document or certification shown as missing; BLOCKED only if `move` or `modelReason` points to a specific missing prerequisite (a certification, exhibit, affidavit, or similar) that has to be obtained first.",
          { READY: null, DRAFTING: null, BLOCKED: null },
        ),
      },
    });
    const response = await Promise.race([
      call,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Jev timeout")), JEV_TIMEOUT_MS)),
    ]);
    const answer = response.answers.readiness;
    logger.info("Jev response", {
      feature: "strategy-readiness",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    });
    return { readiness: answer.choice as StrategyReadinessValue, confidence: answer.confidence };
  } catch (err) {
    logger.warn("Jev error", { feature: "strategy-readiness", err });
    return null;
  }
}
