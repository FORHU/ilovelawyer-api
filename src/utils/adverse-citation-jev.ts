import { choice } from "@typesafe-ai/sdk";
import { CitationTreatment } from "@prisma/client";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, readChoice } from "./jev-common";

/**
 * Jev as the check behind the Citation Map's adverse-citation sweep. The sweep finds later
 * decisions in the corpus that overruled, abandoned or distinguished an authority the case cites
 * (CitationEdge); Jev then reads each treatment against what the case cites the authority for:
 *
 *   - effect   Choice — does the treatment defeat that proposition, can it be distinguished, or
 *                       does it not touch it at all?
 *
 * Only a DEFEATS_PROPOSITION hit is suggested as a Weakness. NOT_ADVERSE is the verdict that
 * would hide a real problem, so it needs NOT_ADVERSE_MIN_CONFIDENCE; below it the hit is kept as
 * DISTINGUISHABLE. Off unless USE_JEV_ADVERSE_SWEEP=true — run
 * scripts/jev-adverse-sweep-benchmark.ts against lawyer-labelled hits before turning it on.
 */

export function isAdverseSweepJevEnabled(): boolean {
  return process.env.USE_JEV_ADVERSE_SWEEP === "true";
}

export const EFFECT_VERDICTS = ["DEFEATS_PROPOSITION", "DISTINGUISHABLE", "NOT_ADVERSE"] as const;
export type EffectVerdict = (typeof EFFECT_VERDICTS)[number];

/** Provisional — re-set from the benchmark. */
export const NOT_ADVERSE_MIN_CONFIDENCE = 0.7;
const MAX_EXCERPT_CHARS = 1500;

export interface AdverseCitationJevCheck {
  effect: EffectVerdict;
  confidence: number;
}

export interface AdverseCitationJevInput {
  authority: { reference: string; citedFor: string };
  treatment: CitationTreatment;
  citingDecision: string;
  excerpt: string | null;
}

/** Throws on a Jev failure — the caller keeps the hit unchecked rather than guess. */
export async function checkAdverseCitationWithJev(input: AdverseCitationJevInput): Promise<AdverseCitationJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "adverse-citation", reference: input.authority.reference, treatment: input.treatment });

  const response = await client.systemOne({
    state: {
      authority: input.authority,
      laterDecision: {
        title: input.citingDecision,
        treatment: input.treatment.toLowerCase(),
        excerpt: (input.excerpt ?? "").slice(0, MAX_EXCERPT_CHARS),
      },
    },
    questions: {
      effect: choice(
        "A litigation team cites `authority` for the proposition in `authority.citedFor`. `laterDecision` treated that authority as `laterDecision.treatment`; `laterDecision.excerpt` is the passage where it did. Classify the effect on the team's proposition: DEFEATS_PROPOSITION if the later decision rejects or overturns the very rule or holding the team relies on; DISTINGUISHABLE if it limits or departs from the authority on facts or a point the team could argue does not apply to them; NOT_ADVERSE if the treatment concerns a different part of the authority and leaves the team's proposition untouched.",
        { DEFEATS_PROPOSITION: null, DISTINGUISHABLE: null, NOT_ADVERSE: null },
      ),
    },
  });

  const answer = response.answers.effect;
  const raw = readChoice<EffectVerdict>(answer.choice, EFFECT_VERDICTS, "DISTINGUISHABLE");
  const { value: effect, downgraded } = applyFloor(raw, answer.confidence, "NOT_ADVERSE", NOT_ADVERSE_MIN_CONFIDENCE, "DISTINGUISHABLE");
  logger.info("Jev response", {
    feature: "adverse-citation",
    reference: input.authority.reference,
    effect,
    rawEffect: raw,
    downgraded,
    confidence: answer.confidence,
  });
  return { effect, confidence: answer.confidence };
}

/** Whether a hit is suggested as a Weakness. The case's own ADVERSE citation check always is. A
 * later decision's treatment is when Jev reads it as defeating the proposition — or, without a
 * Jev read, when the treatment itself is OVERRULED or ABANDONED (DISTINGUISHED alone isn't). */
export function isSuggestedAsWeakness(hit: {
  kind: "OWN_STATUS" | "NEGATIVE_TREATMENT";
  treatment: CitationTreatment | null;
  jev: AdverseCitationJevCheck | null;
}): boolean {
  if (hit.kind === "OWN_STATUS") return true;
  if (hit.jev) return hit.jev.effect === "DEFEATS_PROPOSITION";
  return hit.treatment === "OVERRULED" || hit.treatment === "ABANDONED";
}
