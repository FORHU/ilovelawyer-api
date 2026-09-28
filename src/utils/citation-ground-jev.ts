import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, readChoice } from "./jev-common";

/**
 * Jev as the check behind the Citation Map's authority → claim links. Chat Wonder proposes the
 * links (or the lawyer adds one); Jev then reads the authority's text against the claim:
 *
 *   - attaches   Choice — does the authority bear on this claim?
 *
 * SUPPORTS_GROUND shows as Mapped, TANGENTIAL as a weak link; an AI link Jev reads as
 * DOES_NOT_APPLY is not saved, a manual one is kept and flagged. Off unless
 * USE_JEV_CITATION_GROUNDS=true — run scripts/jev-citation-grounds-benchmark.ts against
 * lawyer-labelled links before turning it on.
 */

export function isCitationGroundJevEnabled(): boolean {
  return process.env.USE_JEV_CITATION_GROUNDS === "true";
}

export const ATTACHES_VERDICTS = ["SUPPORTS_GROUND", "TANGENTIAL", "DOES_NOT_APPLY"] as const;
export type AttachesVerdict = (typeof ATTACHES_VERDICTS)[number];

/** DOES_NOT_APPLY drops an AI link outright, so it needs this much confidence; below it the link
 * is kept as TANGENTIAL. Provisional — re-set from the benchmark. */
export const DOES_NOT_APPLY_MIN_CONFIDENCE = 0.7;
// Enough of the authority's official text to judge it by, without sending a whole judgment.
const MAX_OFFICIAL_CHARS = 1500;

export interface CitationGroundJevCheck {
  attaches: AttachesVerdict;
  confidence: number;
}

export interface CitationGroundJevInput {
  authority: { reference: string; title: string | null; quotedText: string; officialText: string | null };
  claim: { title: string; causeOfAction: string | null; description: string | null };
  role: "SUBSTANTIVE" | "PROCEDURAL";
}

/** Throws on a Jev failure — the caller keeps the link unchecked rather than guess. */
export async function checkCitationGroundWithJev(input: CitationGroundJevInput): Promise<CitationGroundJevCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "citation-ground", reference: input.authority.reference, claim: input.claim.title });

  const response = await client.systemOne({
    state: {
      authority: {
        reference: input.authority.reference,
        title: input.authority.title ?? "",
        citedFor: input.authority.quotedText,
        officialText: (input.authority.officialText ?? "").slice(0, MAX_OFFICIAL_CHARS),
      },
      claim: {
        title: input.claim.title,
        pleadedUnder: input.claim.causeOfAction ?? "",
        description: input.claim.description ?? "",
      },
      proposedRole: input.role,
    },
    questions: {
      attaches: choice(
        "A litigation team cites `authority` in support of `claim` (proposedRole: SUBSTANTIVE = it states or applies the rule the claim rests on; PROCEDURAL = it sets a procedure whose breach is the claim). Judging from `authority.citedFor` and `authority.officialText`, classify the link: SUPPORTS_GROUND if the authority bears directly on `claim`; TANGENTIAL if it is related but does not establish or govern the claim; DOES_NOT_APPLY if it has nothing to do with the claim.",
        { SUPPORTS_GROUND: null, TANGENTIAL: null, DOES_NOT_APPLY: null },
      ),
    },
  });

  const answer = response.answers.attaches;
  const raw = readChoice<AttachesVerdict>(answer.choice, ATTACHES_VERDICTS, "TANGENTIAL");
  const { value: attaches, downgraded } = applyFloor(raw, answer.confidence, "DOES_NOT_APPLY", DOES_NOT_APPLY_MIN_CONFIDENCE, "TANGENTIAL");
  logger.info("Jev response", {
    feature: "citation-ground",
    reference: input.authority.reference,
    claim: input.claim.title,
    attaches,
    rawAttaches: raw,
    downgraded,
    confidence: answer.confidence,
  });
  return { attaches, confidence: answer.confidence };
}
