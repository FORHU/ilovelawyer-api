import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, isUncertain, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";

/**
 * Jev as the check behind the Legal Issues panel. Chat Wonder still finds the issues and writes
 * who bears the burden on each; Jev then reads each issue against the case data:
 *
 *   - raised     Choice — is this question actually raised by the case's claims and facts?
 *   - contested  Choice — do the parties take opposing positions on it in the case data?
 *   - burden     Choice — which side bears the burden on it?
 *
 * The row's pill comes from `contested` (CONTESTED, else OPEN). Jev never sets BRIEFING or
 * RESOLVED — those are the lawyer's workflow states. A confident NOT_RAISED, or a burden that
 * disagrees with the drafting model's, flags the row; neither deletes it. Off unless
 * USE_JEV_LEGAL_ISSUES=true — run scripts/jev-legal-issues-benchmark.ts against lawyer-labelled
 * issues before turning it on.
 */

export function isLegalIssueJevEnabled(): boolean {
  return process.env.USE_JEV_LEGAL_ISSUES === "true";
}

export const RAISED_VERDICTS = ["RAISED", "NOT_RAISED"] as const;
export type RaisedVerdict = (typeof RAISED_VERDICTS)[number];
export const CONTESTED_VERDICTS = ["CONTESTED", "UNCONTESTED", "UNCLEAR"] as const;
export type ContestedVerdict = (typeof CONTESTED_VERDICTS)[number];
export const BURDEN_PARTIES = ["CLAIMANT", "RESPONDENT", "SHARED", "UNCLEAR"] as const;
export type BurdenParty = (typeof BURDEN_PARTIES)[number];

/** NOT_RAISED would tell a lawyer an issue isn't in their case at all, so it needs this much
 * confidence; below it the issue is treated as RAISED. Same bar as the other Jev pilots'
 * accusatory verdicts. Provisional — re-set from the benchmark. */
export const NOT_RAISED_MIN_CONFIDENCE = 0.7;
/** A burden that disagrees with the drafting model's is only flagged with this much confidence. */
export const BURDEN_DISPUTE_MIN_CONFIDENCE = 0.7;

export type LegalIssueFlag = "NOT_RAISED" | "BURDEN_DISPUTED";

export interface LegalIssueJevCheck {
  raised: RaisedVerdict;
  raisedConfidence: number;
  contested: ContestedVerdict;
  contestedConfidence: number;
  burden: BurdenParty;
  burdenConfidence: number;
  /** The drafting model's own burden call, when it made one — what BURDEN_DISPUTED compares to. */
  modelBurden: BurdenParty | null;
  flags: LegalIssueFlag[];
  /** True when the contested or burden answer's confidence is under UNCERTAIN_SCORE_CONFIDENCE. */
  uncertain: boolean;
}

export interface LegalIssueJevInput {
  label: string;
  detail: string | null;
  sourceLabel: string | null;
  modelBurden: BurdenParty | null;
}

/** The pill Jev's read implies. UNCLEAR stays OPEN — "contested" is a claim that needs support. */
export function tagFromCheck(check: Pick<LegalIssueJevCheck, "contested">): "CONTESTED" | "OPEN" {
  return check.contested === "CONTESTED" ? "CONTESTED" : "OPEN";
}

export function flagsFor(
  check: Pick<LegalIssueJevCheck, "raised" | "burden" | "burdenConfidence" | "modelBurden">,
): LegalIssueFlag[] {
  const flags: LegalIssueFlag[] = [];
  if (check.raised === "NOT_RAISED") flags.push("NOT_RAISED");
  const definite = (b: BurdenParty | null) => b !== null && b !== "UNCLEAR";
  if (
    definite(check.modelBurden) &&
    definite(check.burden) &&
    check.burden !== check.modelBurden &&
    check.burdenConfidence >= BURDEN_DISPUTE_MIN_CONFIDENCE
  ) {
    flags.push("BURDEN_DISPUTED");
  }
  return flags;
}

/** Throws on a Jev failure — the caller stores null rather than a guess. */
export async function checkLegalIssueWithJev(issue: LegalIssueJevInput, context: CaseJevContext): Promise<LegalIssueJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "legal-issue", label: issue.label });

  const response = await client.systemOne({
    state: {
      issue: { question: issue.label, burdenNote: issue.detail ?? "", source: issue.sourceLabel ?? "" },
      caseData: caseDataState(context),
    },
    questions: {
      raised: choice(
        "`issue.question` was listed as a legal question in this case. Judging only from `caseData` (its claims, parties, timeline, contradictions and witnesses), classify it: RAISED if the claims or facts in `caseData` put this question in play, even if worded differently; NOT_RAISED if nothing in `caseData` puts it in play.",
        { RAISED: null, NOT_RAISED: null },
      ),
      contested: choice(
        "Judging only from `caseData`, do the parties take opposing positions on `issue.question`? CONTESTED if `caseData` shows each side asserting something incompatible about it; UNCONTESTED if only one side addresses it or both agree; UNCLEAR if `caseData` does not say enough to tell.",
        { CONTESTED: null, UNCONTESTED: null, UNCLEAR: null },
      ),
      burden: choice(
        "On `issue.question`, which side bears the burden of proof? CLAIMANT is the party that brought the case (complainant, petitioner, plaintiff, claimant); RESPONDENT is the party defending it. SHARED if each side must prove part of it; UNCLEAR if `caseData` does not say enough to tell. Do not rely on `issue.burdenNote` — answer from the question and `caseData`.",
        { CLAIMANT: null, RESPONDENT: null, SHARED: null, UNCLEAR: null },
      ),
    },
  });

  const answers = response.answers;
  const rawRaised = readChoice<RaisedVerdict>(answers.raised.choice, RAISED_VERDICTS, "RAISED");
  const { value: raised, downgraded } = applyFloor(rawRaised, answers.raised.confidence, "NOT_RAISED", NOT_RAISED_MIN_CONFIDENCE, "RAISED");
  const partial = {
    raised,
    raisedConfidence: answers.raised.confidence,
    contested: readChoice<ContestedVerdict>(answers.contested.choice, CONTESTED_VERDICTS, "UNCLEAR"),
    contestedConfidence: answers.contested.confidence,
    burden: readChoice<BurdenParty>(answers.burden.choice, BURDEN_PARTIES, "UNCLEAR"),
    burdenConfidence: answers.burden.confidence,
    modelBurden: issue.modelBurden,
  };
  const check: LegalIssueJevCheck = {
    ...partial,
    flags: flagsFor(partial),
    uncertain: isUncertain(partial.contestedConfidence, partial.burdenConfidence),
  };

  logger.info("Jev response", {
    feature: "legal-issue",
    label: issue.label,
    ...check,
    // Logged so a floor-triggered RAISED is visible in the trace, not mistaken for a clean one.
    rawRaised,
    downgraded,
  });
  return check;
}
