import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, isUncertain, normalizeScore, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";

/**
 * Jev as the check behind the Weaknesses panel. Chat Wonder still finds each weakness and the work
 * that would close it; Jev then reads it against the case data:
 *
 *   - support    Choice — does the case data bear the weakness out?
 *   - severity   Score  — how much of the user's case it costs if the other side uses it (0..3)
 *   - surfacing  Score  — how early the other side can use it (0..3, top = soonest)
 *   - curable    Choice — can it be closed with evidence, by argument, or not at all?
 *
 * The pill (MATERIAL/MINOR), the ▲ impact number and the row order are computed from those
 * instead of being the drafting model's self-rating. CLOSED stays the lawyer's call. Off unless
 * USE_JEV_WEAKNESSES=true — run scripts/jev-weaknesses-benchmark.ts against lawyer-labelled
 * weaknesses before turning it on.
 */

export function isWeaknessJevEnabled(): boolean {
  return process.env.USE_JEV_WEAKNESSES === "true";
}

export const SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];
export const CURABLE_VERDICTS = ["BY_EVIDENCE", "BY_ARGUMENT", "NOT_CURABLE"] as const;
export type CurableVerdict = (typeof CURABLE_VERDICTS)[number];

/** CONTRADICTED tells a lawyer their own weakness list is wrong about the case, so like the other
 * pilots it needs this much confidence; below it the weakness is recorded as UNSUPPORTED.
 * Provisional — re-set from the benchmark. */
export const CONTRADICTION_MIN_CONFIDENCE = 0.7;
/** Severity at or above this (normalized) is MATERIAL. */
export const MATERIAL_MIN_SEVERITY = 2 / 3;

// Ordered lowest → highest, as Score requires. Concrete situations, no numbers (see the Score docs).
export const SEVERITY_LEVELS = [
  "Even if the other side uses it, it only dents a witness's credibility or a side point; the user's claims and remedies are unaffected.",
  "If the other side uses it, it reduces the damages or remedies the user can recover, but leaves liability intact.",
  "If the other side uses it, it defeats one element of a claim, or one of several claims, but the user's case survives in part.",
  "If the other side uses it, it disposes of the whole case — for example dismissal on a procedural ground, or a complete defence to liability.",
] as const;

export const SURFACING_LEVELS = [
  "It only becomes usable against the user on appeal or in proceedings after judgment.",
  "It comes out at the hearing or trial, through cross-examination or the evidence led there.",
  "It comes out in the parties' written submissions — the position paper, pleadings or statements of case.",
  "The other side can use it straight away — in its first response, or at the first conference or preliminary hearing.",
] as const;

export type WeaknessFlag = "NOT_BORNE_OUT";

export interface WeaknessJevCheck {
  support: SupportVerdict;
  supportConfidence: number;
  /** 0..1 — Score position normalized by the top level. */
  severity: number;
  severityConfidence: number;
  /** 0..1, where 1 is "usable straight away". */
  surfacing: number;
  surfacingConfidence: number;
  curable: CurableVerdict;
  curableConfidence: number;
  flags: WeaknessFlag[];
  /** True when the severity or surfacing Score's confidence is under UNCERTAIN_SCORE_CONFIDENCE. */
  uncertain: boolean;
}

export interface WeaknessJevInput {
  label: string;
  detail: string | null;
  sourceLabel: string | null;
}

/** A weakness the case data doesn't bear out can't be MATERIAL, whatever its severity. */
export function tagFromCheck(check: Pick<WeaknessJevCheck, "support" | "severity">): "MATERIAL" | "MINOR" {
  return check.support === "SUPPORTED" && check.severity >= MATERIAL_MIN_SEVERITY ? "MATERIAL" : "MINOR";
}

/** Impact on the panel's 0..10 scale (a weakness only ever hurts): severity, and 0 when the case
 * data doesn't bear the weakness out. */
export function impactFromCheck(check: Pick<WeaknessJevCheck, "support" | "severity">): number {
  return check.support === "SUPPORTED" ? Math.round(10 * check.severity) : 0;
}

/** Soonest to surface first, then most severe. */
export function compareBySurfacing(
  a: Pick<WeaknessJevCheck, "surfacing" | "severity">,
  b: Pick<WeaknessJevCheck, "surfacing" | "severity">,
): number {
  return b.surfacing - a.surfacing || b.severity - a.severity;
}

/** Throws on a Jev failure — the caller keeps the model's rating rather than a guess. */
export async function checkWeaknessWithJev(weakness: WeaknessJevInput, context: CaseJevContext): Promise<WeaknessJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "weakness", label: weakness.label });

  const response = await client.systemOne({
    state: {
      weakness: { point: weakness.label, whatWouldCloseIt: weakness.detail ?? "", source: weakness.sourceLabel ?? "" },
      caseData: caseDataState(context),
    },
    questions: {
      support: choice(
        "`weakness.point` was listed as a weakness in the user's own case. Judging only from `caseData`, classify it: SUPPORTED if `caseData` bears it out, even if worded differently; UNSUPPORTED if `caseData` does not address or does not establish it; CONTRADICTED if `caseData` shows the opposite.",
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
      ),
      severity: score(
        "Suppose the other side uses `weakness.point` against the user. How much of the user's case does it cost, given the claims and issues in `caseData`?",
        [...SEVERITY_LEVELS],
      ),
      surfacing: score(
        "How early in the proceedings can the other side use `weakness.point` against the user, given `caseData`?",
        [...SURFACING_LEVELS],
      ),
      curable: choice(
        "Can the user close `weakness.point` before it is used against them? BY_EVIDENCE if obtaining or producing a document, record or statement would close it; BY_ARGUMENT if it can be answered on the law or on facts already in `caseData`; NOT_CURABLE if nothing the user can still do would close it.",
        { BY_EVIDENCE: null, BY_ARGUMENT: null, NOT_CURABLE: null },
      ),
    },
  });

  const answers = response.answers;
  const rawSupport = readChoice<SupportVerdict>(answers.support.choice, SUPPORT_VERDICTS, "UNSUPPORTED");
  const { value: support, downgraded } = applyFloor(rawSupport, answers.support.confidence, "CONTRADICTED", CONTRADICTION_MIN_CONFIDENCE, "UNSUPPORTED");
  const check: WeaknessJevCheck = {
    support,
    supportConfidence: answers.support.confidence,
    severity: normalizeScore(answers.severity.score, SEVERITY_LEVELS),
    severityConfidence: answers.severity.confidence,
    surfacing: normalizeScore(answers.surfacing.score, SURFACING_LEVELS),
    surfacingConfidence: answers.surfacing.confidence,
    curable: readChoice<CurableVerdict>(answers.curable.choice, CURABLE_VERDICTS, "BY_EVIDENCE"),
    curableConfidence: answers.curable.confidence,
    flags: support === "SUPPORTED" ? [] : ["NOT_BORNE_OUT"],
    uncertain: isUncertain(answers.severity.confidence, answers.surfacing.confidence),
  };

  logger.info("Jev response", {
    feature: "weakness",
    label: weakness.label,
    ...check,
    // Logged so a floor-triggered downgrade is visible in the trace, not mistaken for UNSUPPORTED.
    rawSupport,
    downgraded,
  });
  return check;
}
