import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { FACTOR_DEFINITIONS, FACTOR_KEYS, RUBRIC, type FactorKey } from "./witness-rubric";

/**
 * Jev as the classifier behind the witness rubric. Chat Wonder still writes the quotes and reasons;
 * Jev answers the seven fixed questions from the same case data, so each factor is one choice among
 * defined options with a confidence rather than the author model's impression. The score itself is
 * computed by witness-rubric.ts from those answers. One request per witness, all factors together.
 * Off unless USE_JEV_WITNESS=true — run scripts/jev-witness-benchmark.ts against lawyer-labelled
 * witnesses to set the floor below before relying on it.
 */

export function isWitnessJevEnabled(): boolean {
  return process.env.USE_JEV_WITNESS === "true";
}

/** Below this an answer is treated as not assessable rather than counted. Not assessable lowers the
 * coverage shown next to the score; a low-confidence guess would move the score itself, so the
 * cautious side is to leave it out. Provisional — re-set from the witness benchmark. */
export const FACTOR_MIN_CONFIDENCE = 0.6;

/** The extra option every question carries, so "the papers don't say" is an answer, not a guess. */
export const NOT_SHOWN = "NOT_SHOWN";

export type WitnessJevInput = {
  witness: { name: string; role: string | null; summary: string | null; statementReceived: boolean };
  /** The documents this witness sponsors, with the text sent to the model already capped. */
  sponsoredDocuments: { name: string; hearsay: string; text: string | null; contradictions: string[] }[];
  /** What the other witnesses' documents say, for corroboration and conflict. */
  otherWitnesses: { name: string; documents: { name: string; text: string | null }[] }[];
  timeline: { date: string; title: string }[];
};

export interface JevFactorAnswer {
  /** Null when Jev said NOT_SHOWN, or was below the confidence floor, or gave an unknown option. */
  answer: string | null;
  confidence: number;
  /** Jev's own answer before the floor, kept so a floor-triggered drop is visible in the audit. */
  rawAnswer: string | null;
}

export type JevFactors = Record<FactorKey, JevFactorAnswer>;

function questionText(key: FactorKey): string {
  const def = FACTOR_DEFINITIONS[key];
  const options = Object.keys(RUBRIC[key].options)
    .map((o) => `${o} — ${def.options[o]}`)
    .concat(`${NOT_SHOWN} — the papers in \`state\` do not let you tell`)
    .join("\n");
  return `Reading only \`state\`, about \`witness\`: ${def.question} Answer from what the documents actually say, not from an impression of the witness.\n${options}`;
}

/** Applies the floor and maps NOT_SHOWN / unknown options to null. Exported for testing. */
export function normalizeJevAnswer(key: FactorKey, raw: unknown, confidence: number): JevFactorAnswer {
  const value = typeof raw === "string" ? raw : null;
  const known = value !== null && Object.prototype.hasOwnProperty.call(RUBRIC[key].options, value);
  return {
    answer: known && confidence >= FACTOR_MIN_CONFIDENCE ? value : null,
    confidence,
    rawAnswer: value,
  };
}

/** Throws on a Jev failure — the caller falls back to Chat Wonder's answers and says so. */
export async function classifyWitnessWithJev(input: WitnessJevInput): Promise<JevFactors> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "witness-rubric", witness: input.witness.name });

  const questions = Object.fromEntries(
    FACTOR_KEYS.map((k) => [
      k,
      choice(
        questionText(k),
        Object.fromEntries([...Object.keys(RUBRIC[k].options), NOT_SHOWN].map((o) => [o, null])) as Record<string, null>,
      ),
    ]),
  );

  const response = await client.systemOne({ state: input, questions });

  const answers = {} as JevFactors;
  for (const key of FACTOR_KEYS) {
    const a = (response.answers as Record<string, { choice: unknown; confidence: number }>)[key];
    answers[key] = normalizeJevAnswer(key, a?.choice, a?.confidence ?? 0);
  }
  logger.info("Jev response", {
    feature: "witness-rubric",
    witness: input.witness.name,
    answers: Object.fromEntries(FACTOR_KEYS.map((k) => [k, `${answers[k].rawAnswer}@${answers[k].confidence.toFixed(2)}`])),
  });
  return answers;
}
