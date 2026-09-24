import { ConfidenceLevel, OutlookBand } from "@prisma/client";
import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/** Pilot for the Case Outlook Task Board's Jev question (see conversation, not yet a benchmark
 * report file at time of writing). Classifies band + confidence from the same structured signals
 * CaseOutlookAiSvc already assembles (findings, open risks, contradictions, deadlines) — NOT from
 * raw document text, unlike the current chat-wonder path (case-outlook-ai.service.ts), which reads
 * the actual excerpt pack. This is a narrower task: "given already-extracted case signals, classify
 * the outlook" rather than "read the documents and extract + classify in one call". Unused by
 * production code — CaseOutlookAiSvc still only calls chat-wonder. Exists so a benchmark script can
 * call it directly, the same way classifyPropositionWithJev/evaluateCitationWithJev do for their
 * pilots. */

export interface OutlookJevInput {
  readyDocumentCount: number;
  findings: { category: string; label: string }[];
  openRisks: { title: string; severity: string }[];
  contradictions: { factKey: string; leftValue: string; rightValue: string }[];
  deadlines: { label: string; daysUntilDue: number }[];
}

export interface OutlookJevResult {
  band: OutlookBand;
  bandConfidence: number;
  bandProbabilities: Record<string, number>;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  confidenceReportedConfidence: number;
}

// Mirrors caseOutlookOutputContract's band definitions (case-outlook-inputs.ts) exactly, so this
// pilot is judged against the same rubric the shipped chat-wonder prompt uses, not a rewritten one.
const BAND_CRITERIA = {
  FAVORABLE: "The material strongly supports the petitioner/plaintiff; little or nothing supports the respondent/defendant.",
  LEANS_FAVORABLE: "The material mostly supports the petitioner/plaintiff, with some points favoring the respondent/defendant.",
  UNCERTAIN: "The material is genuinely mixed, or too thin, to favor either side.",
  LEANS_UNFAVORABLE: "The material mostly supports the respondent/defendant, with some points favoring the petitioner/plaintiff.",
  UNFAVORABLE: "The material strongly supports the respondent/defendant; little or nothing supports the petitioner/plaintiff.",
} as const;

// Ordered 0→2 for score(); mirrors the "how well the material supports the band" framing from
// caseOutlookOutputContract, not a restatement of applyOutlookGuards's hard thin-evidence rule —
// that rule still runs afterward in code (see case-outlook-parse.ts) regardless of which model
// produced this raw read.
const CONFIDENCE_CRITERIA = [
  "LOW — the material is thin, one-sided in coverage rather than substance, or contains an unresolved contradiction on a fact the band depends on.",
  "MEDIUM — the material reasonably supports the band, but with gaps or an open risk that could change the picture.",
  "HIGH — the material clearly and consistently supports the band, with no unresolved contradiction bearing on it.",
] as const;

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ["LOW", "MEDIUM", "HIGH"];

function formatState(input: OutlookJevInput) {
  return {
    readyDocumentCount: input.readyDocumentCount,
    findings: input.findings.map((f) => `[${f.category}] ${f.label}`),
    openRisks: input.openRisks.map((r) => `[${r.severity}] ${r.title}`),
    contradictions: input.contradictions.map((c) => `${c.factKey}: "${c.leftValue}" vs "${c.rightValue}"`),
    deadlines: input.deadlines.map((d) => `${d.label} — due in ${d.daysUntilDue}d`),
  };
}

export async function classifyOutlookWithJev(input: OutlookJevInput): Promise<OutlookJevResult> {
  const client = getTypeSafeClient();
  const state = formatState(input);
  logger.info("Jev request", { feature: "case-outlook", state });

  const response = await client.systemOne({
    state,
    questions: {
      band: choice(
        "Weigh how the case currently stands for the petitioner/plaintiff against the respondent/defendant, based only on readyDocumentCount, findings, openRisks, contradictions and deadlines. Do not invent facts not in the state.",
        BAND_CRITERIA,
      ),
      confidenceLevel: score(
        "How well does the material support whatever band you'd pick for this case — is the evidence thin, one-sided, or contradictory, or does it clearly and consistently point one way?",
        CONFIDENCE_CRITERIA,
      ),
    },
  });

  const bandAnswer = response.answers.band;
  const confidenceAnswer = response.answers.confidenceLevel;
  const confidenceIndex = Math.max(0, Math.min(2, Math.round(confidenceAnswer.score)));

  logger.info("Jev response", {
    feature: "case-outlook",
    band: bandAnswer.choice,
    bandConfidence: bandAnswer.confidence,
    confidenceScore: confidenceAnswer.score,
    confidenceReportedConfidence: confidenceAnswer.confidence,
  });

  return {
    band: bandAnswer.choice as OutlookBand,
    bandConfidence: bandAnswer.confidence,
    bandProbabilities: bandAnswer.probabilities as Record<string, number>,
    confidence: CONFIDENCE_LEVELS[confidenceIndex] as ConfidenceLevel,
    confidenceScore: confidenceAnswer.score,
    confidenceReportedConfidence: confidenceAnswer.confidence,
  };
}
