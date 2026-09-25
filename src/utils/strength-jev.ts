import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, isUncertain, normalizeScore, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";

/**
 * Jev as the check behind the Strengths panel, which shows each strength beside the document it
 * rests on. Chat Wonder still finds the strengths; Jev then reads each one against the passages
 * of its cited document that best match it (see FindingJevSvc's sourcePassages) and the case data:
 *
 *   - support    Choice — do the cited document's passages bear the strength out?
 *   - weight     Score  — how much of the user's theory it carries (0..3)
 *   - rebuttal   Choice — does the case data give the other side an answer to it?
 *
 * The pill (STRONG/MODERATE), the ▲ impact number and the row order are computed from those
 * instead of being the drafting model's self-rating. A strength its source doesn't bear out is
 * flagged and can't be STRONG. Off unless USE_JEV_STRENGTHS=true — run
 * scripts/jev-strengths-benchmark.ts against lawyer-labelled strengths before turning it on.
 */

export function isStrengthJevEnabled(): boolean {
  return process.env.USE_JEV_STRENGTHS === "true";
}

export const SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];
export const REBUTTAL_VERDICTS = ["UNREBUTTED", "REBUTTABLE", "ALREADY_REBUTTED"] as const;
export type RebuttalVerdict = (typeof REBUTTAL_VERDICTS)[number];

/** CONTRADICTED tells a lawyer their own document says the opposite, and ALREADY_REBUTTED talks
 * them out of a strength, so both need this much confidence; below it they're recorded as
 * UNSUPPORTED / REBUTTABLE. Provisional — re-set from the benchmark. */
export const CONTRADICTION_MIN_CONFIDENCE = 0.7;
export const REBUTTED_MIN_CONFIDENCE = 0.7;
/** Weight at or above this (normalized) can be STRONG. */
export const STRONG_MIN_WEIGHT = 2 / 3;

// Ordered lowest → highest, as Score requires. Concrete situations, no numbers (see the Score docs).
export const WEIGHT_LEVELS = [
  "It touches a side point — a witness's credibility or a detail — without advancing any claim or remedy.",
  "It supports the remedies or the amount the user can recover, but not whether the user wins.",
  "It helps establish one element of a claim, alongside other evidence the claim still needs.",
  "On its own it establishes a claim or defeats the other side's main defence.",
] as const;

export type StrengthFlag = "NOT_BORNE_OUT";

export interface StrengthJevCheck {
  support: SupportVerdict;
  supportConfidence: number;
  /** False when no text of the cited document could be found — support was then judged against
   * the case data alone, and the panel says so. */
  sourceRead: boolean;
  /** 0..1 — Score position normalized by the top level. */
  weight: number;
  weightConfidence: number;
  rebuttal: RebuttalVerdict;
  rebuttalConfidence: number;
  flags: StrengthFlag[];
  /** True when the weight Score's confidence is under UNCERTAIN_SCORE_CONFIDENCE. */
  uncertain: boolean;
}

export interface StrengthJevInput {
  label: string;
  detail: string | null;
  sourceLabel: string | null;
  /** The cited document's passages that best match the strength; [] when none could be found. */
  passages: string[];
}

/** STRONG needs the source to bear it out, real weight, and no answer already on the record. */
export function tagFromCheck(check: Pick<StrengthJevCheck, "support" | "weight" | "rebuttal">): "STRONG" | "MODERATE" {
  return check.support === "SUPPORTED" && check.weight >= STRONG_MIN_WEIGHT && check.rebuttal !== "ALREADY_REBUTTED"
    ? "STRONG"
    : "MODERATE";
}

/** Impact on the panel's 0..10 scale (a strength only ever helps): weight, and 0 when its source
 * doesn't bear it out. */
export function impactFromCheck(check: Pick<StrengthJevCheck, "support" | "weight">): number {
  return check.support === "SUPPORTED" ? Math.round(10 * check.weight) : 0;
}

/** The strengths doing the most work first. */
export function compareByWeight(a: Pick<StrengthJevCheck, "support" | "weight">, b: Pick<StrengthJevCheck, "support" | "weight">): number {
  return impactFromCheck(b) - impactFromCheck(a) || b.weight - a.weight;
}

/** Throws on a Jev failure — the caller keeps the model's rating rather than a guess. */
export async function checkStrengthWithJev(strength: StrengthJevInput, context: CaseJevContext): Promise<StrengthJevCheck> {
  const client = getTypeSafeClient();
  const sourceRead = strength.passages.length > 0;
  logger.info("Jev request", { feature: "strength", label: strength.label, sourceRead });

  const response = await client.systemOne({
    state: {
      strength: { point: strength.label, reference: strength.detail ?? "", source: strength.sourceLabel ?? "" },
      sourcePassages: strength.passages,
      caseData: caseDataState(context),
    },
    questions: {
      support: choice(
        sourceRead
          ? "`strength.point` was listed as a strength of the user's case, resting on the document `strength.source`. `sourcePassages` are the passages of that document that best match it. Classify: SUPPORTED if `sourcePassages` bear it out, even if worded differently; UNSUPPORTED if they do not address or do not establish it; CONTRADICTED if they say the opposite."
          : "`strength.point` was listed as a strength of the user's case. No text of its source document is available, so judge only from `caseData`: SUPPORTED if `caseData` bears it out, even if worded differently; UNSUPPORTED if `caseData` does not address or does not establish it; CONTRADICTED if `caseData` shows the opposite.",
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
      ),
      weight: score("Taking `strength.point` as true, how much of the user's case does it carry, given the claims and issues in `caseData`?", [
        ...WEIGHT_LEVELS,
      ]),
      rebuttal: choice(
        "Does `caseData` give the other side an answer to `strength.point`? UNREBUTTED if nothing in `caseData` answers it; REBUTTABLE if `caseData` gives the other side a plausible answer the user would have to meet; ALREADY_REBUTTED if `caseData` already defeats it — for example a contradiction or a later document that undoes it.",
        { UNREBUTTED: null, REBUTTABLE: null, ALREADY_REBUTTED: null },
      ),
    },
  });

  const answers = response.answers;
  const rawSupport = readChoice<SupportVerdict>(answers.support.choice, SUPPORT_VERDICTS, "UNSUPPORTED");
  const support = applyFloor(rawSupport, answers.support.confidence, "CONTRADICTED", CONTRADICTION_MIN_CONFIDENCE, "UNSUPPORTED");
  const rawRebuttal = readChoice<RebuttalVerdict>(answers.rebuttal.choice, REBUTTAL_VERDICTS, "REBUTTABLE");
  const rebuttal = applyFloor(rawRebuttal, answers.rebuttal.confidence, "ALREADY_REBUTTED", REBUTTED_MIN_CONFIDENCE, "REBUTTABLE");
  const check: StrengthJevCheck = {
    support: support.value,
    supportConfidence: answers.support.confidence,
    sourceRead,
    weight: normalizeScore(answers.weight.score, WEIGHT_LEVELS),
    weightConfidence: answers.weight.confidence,
    rebuttal: rebuttal.value,
    rebuttalConfidence: answers.rebuttal.confidence,
    flags: support.value === "SUPPORTED" ? [] : ["NOT_BORNE_OUT"],
    uncertain: isUncertain(answers.weight.confidence),
  };

  logger.info("Jev response", {
    feature: "strength",
    label: strength.label,
    ...check,
    // Logged so a floor-triggered downgrade is visible in the trace, not mistaken for a clean one.
    rawSupport,
    rawRebuttal,
    downgraded: support.downgraded || rebuttal.downgraded,
  });
  return check;
}
