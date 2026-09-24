import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/**
 * Phase 1, step 3 of docs/plans/grounding-verifier.md — the paid half of the grounding check:
 * given something an answer asserted and the bundle passage it cited, does the passage actually
 * bear it out? Same shape as citation-validity.ts (which scores 15/15 on the ambiguous set),
 * pointed at case-bundle documents rather than legal authorities.
 *
 * Two questions per call, because they fail together. The Brackenmoor grader deducts under
 * criterion A when a cited passage does not support the assertion, and separately under criterion
 * E when the answer treats a party's allegation or a witness's account as an established fact —
 * and the same passage settles both. Asking them together costs one call rather than two.
 */

export const ASSERTION_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type AssertionVerdict = (typeof ASSERTION_VERDICTS)[number];

/**
 * CONTRADICTED is the only accusatory verdict — it tells a lawyer their own answer says the
 * opposite of the document it cites — so it carries a confidence floor the other two do not.
 * Below this, the verdict is recorded as UNSUPPORTED instead: still flagged for review, without
 * asserting the stronger claim.
 *
 * The floor is set from the first run of the grounding benchmark, where every correct verdict
 * landed at 89–100% and both genuine errors sat at 48–52%. This directly serves the plan's ship
 * gate ("no false CONTRADICTED verdicts — a wrong accusation is worse than a missed one").
 */
export const CONTRADICTION_MIN_CONFIDENCE = 0.7;

/** Criterion E's four levels, in ascending order of what the passage actually settles. */
export const EVIDENCE_KINDS = ["ASSERTED_BY_PARTY", "STATED_BY_WITNESS", "SHOWN_BY_DOCUMENT", "ESTABLISHED"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const EVIDENCE_KIND_DEFINITIONS: Record<EvidenceKind, string> = {
  ASSERTED_BY_PARTY: "the passage records a party's own allegation, case or position — something claimed, not proved",
  STATED_BY_WITNESS: "the passage is a witness's account or recollection, which may be honest and still wrong or contested",
  SHOWN_BY_DOCUMENT: "the passage is a document, record or measurement showing the fact directly, though its weight may still be disputed",
  ESTABLISHED: "the passage records a finding, admission, agreed fact or determination that settles the point",
};

export interface AssertionCheck {
  verdict: AssertionVerdict;
  confidence: number;
  evidenceKind: EvidenceKind;
  kindConfidence: number;
  /** Plain-language note for the lawyer reading the verification row. */
  notes: string;
}

function isVerdict(v: unknown): v is AssertionVerdict {
  return typeof v === "string" && (ASSERTION_VERDICTS as readonly string[]).includes(v);
}

function isEvidenceKind(v: unknown): v is EvidenceKind {
  return typeof v === "string" && (EVIDENCE_KINDS as readonly string[]).includes(v);
}

/**
 * Throws on a Jev failure rather than swallowing it — the caller decides what an unverifiable
 * assertion means, exactly as evaluateCitation does with evaluateCitationWithJev. A verification
 * layer that silently reports "fine" when it could not check is worse than one that reports
 * nothing.
 */
export async function checkAssertionWithJev(assertion: string, passage: string, citation?: string): Promise<AssertionCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "assertion-check", citation, assertionChars: assertion.length, passageChars: passage.length });
  const response = await client.systemOne({
    state: { assertion, citedPassage: passage, citation: citation ?? "" },
    questions: {
      support: choice(
        "An answer asserted `assertion` and cited `citation` for it. `citedPassage` is what that reference actually contains. Classify the relationship: SUPPORTED if the passage bears out the assertion, even if worded differently; UNSUPPORTED if the passage does not address or does not establish it; CONTRADICTED if the passage says the opposite of the assertion or expressly denies what it claims.",
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
      ),
      evidenceKind: choice(
        "What does `citedPassage` actually amount to for this assertion?\n" +
          EVIDENCE_KINDS.map((k) => `${k} — ${EVIDENCE_KIND_DEFINITIONS[k]}`).join("\n"),
        Object.fromEntries(EVIDENCE_KINDS.map((k) => [k, null])) as Record<EvidenceKind, null>,
      ),
    },
  });

  const support = response.answers.support;
  const kind = response.answers.evidenceKind;
  const raw: AssertionVerdict = isVerdict(support.choice) ? support.choice : "UNSUPPORTED";
  const downgraded = raw === "CONTRADICTED" && support.confidence < CONTRADICTION_MIN_CONFIDENCE;
  const verdict: AssertionVerdict = downgraded ? "UNSUPPORTED" : raw;
  const evidenceKind: EvidenceKind = isEvidenceKind(kind.choice) ? kind.choice : "ASSERTED_BY_PARTY";
  const pct = Math.round(support.confidence * 100);
  const notes = downgraded
    ? `The cited passage may not support this assertion; a possible contradiction was too uncertain to report as one (${pct}%).`
    : verdict === "SUPPORTED"
      ? `The cited passage bears out this assertion (confidence ${pct}%).`
      : verdict === "CONTRADICTED"
        ? `The cited passage contradicts this assertion (confidence ${pct}%). Check before relying on it.`
        : `The cited passage does not establish this assertion (confidence ${pct}%).`;

  logger.info("Jev response", {
    feature: "assertion-check",
    citation,
    verdict,
    // Both are logged when the floor fires, so a downgrade is visible in the trace rather than
    // looking like Jev simply said UNSUPPORTED.
    rawVerdict: raw,
    downgraded,
    confidence: support.confidence,
    evidenceKind,
    kindConfidence: kind.confidence,
  });

  return { verdict, confidence: support.confidence, evidenceKind, kindConfidence: kind.confidence, notes };
}
