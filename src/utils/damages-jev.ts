import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import { describeDamageBasis } from "./damages-compute";
import logger from "./logger";

/**
 * Jev as a second opinion on each head of the Damages & Remedies model. Chat Wonder (or the
 * lawyer) supplies the head; Jev only judges it, in one request per head:
 *
 *   - support       Choice — does the head's source quote bear out its figures? Only asked when
 *                   the head has a quote (AI-proposed heads); lawyer-entered heads get null.
 *   - awardability  Score  — how likely a court is to award the head, given the case's findings.
 *
 * Suggestions only: saved to the jev* columns and never applied to amount, status or range. The
 * panel shows them only when they add something (a disagreement, a weak head). Off unless
 * USE_JEV_DAMAGES=true — gated like the other Jev pilots until a benchmark against
 * lawyer-labelled heads has been run.
 */

export function isDamagesJevEnabled(): boolean {
  return process.env.USE_JEV_DAMAGES === "true";
}

export const DAMAGE_SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type DamageSupportVerdict = (typeof DAMAGE_SUPPORT_VERDICTS)[number];

/** CONTRADICTED is the accusatory verdict — below this it's reported as UNSUPPORTED, same floor
 * and reason as red-team-jev.ts. Provisional until the damages benchmark is run. */
export const DAMAGE_CONTRADICTION_MIN_CONFIDENCE = 0.7;

// Ordered lowest → highest, as Score requires. Concrete situations, no numbers.
export const AWARDABILITY_LEVELS = [
  "A court would almost certainly not award this head on these facts — for example moral or exemplary damages with nothing in the case data showing bad faith, fraud or oppression, or a figure nothing in the case supports.",
  "Unlikely to be awarded: the head depends on a fact the case data leaves contested or unsupported, so a court would probably deny it or cut it sharply.",
  "Could go either way: the case data gives the head real support, but the other side has a credible answer to it.",
  "Likely to be awarded: the head follows from facts the case data shows as documented or undisputed, under a rule that plainly applies — for example backwages once a dismissal is shown to be illegal.",
] as const;

export interface DamageJevHead {
  id: string;
  category: string;
  label: string | null;
  amount: number | null;
  basis: unknown;
  sourceQuote: string | null;
}

export interface DamageJevContext {
  legalIssues: string[];
  strengths: string[];
  weaknesses: string[];
}

export interface DamageJevRating {
  /** Null when the head has no source quote to check. */
  support: DamageSupportVerdict | null;
  /** 0..3 — the AWARDABILITY_LEVELS index. */
  awardability: number;
  /** The lower of the two answers' confidences, so "uncertain" covers either. */
  confidence: number;
}

const MAX_CONTEXT_ITEMS = 25;

export function buildDamageJevState(head: DamageJevHead, context: DamageJevContext) {
  return {
    head: {
      category: head.category,
      label: head.label ?? head.category,
      amount: head.amount,
      basis: describeDamageBasis(head.basis) ?? "a fixed amount",
    },
    ...(head.sourceQuote ? { quote: head.sourceQuote } : {}),
    caseData: {
      legalIssues: context.legalIssues.slice(0, MAX_CONTEXT_ITEMS),
      strengths: context.strengths.slice(0, MAX_CONTEXT_ITEMS),
      weaknesses: context.weaknesses.slice(0, MAX_CONTEXT_ITEMS),
    },
  };
}

/** Throws on a Jev failure — verifyDamageHeadsWithJev decides what that means. */
export async function rateDamageHeadWithJev(head: DamageJevHead, context: DamageJevContext): Promise<DamageJevRating> {
  const withQuote = !!head.sourceQuote;
  logger.info("Jev request", { feature: "damages", headId: head.id, category: head.category, withQuote });
  const response = await getTypeSafeClient().systemOne({
    state: buildDamageJevState(head, context),
    questions: {
      ...(withQuote
        ? {
            support: choice(
              "`head` is one head of damages in a lawyer's damages model, and `quote` is the line from a case document it was built from. Classify the relationship between `quote` and the figures in `head` (its amount or basis, and what they are for): SUPPORTED if `quote` states those figures for that purpose; UNSUPPORTED if `quote` does not state them or states them for something else; CONTRADICTED if `quote` states a different figure for the same thing.",
              { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
            ),
          }
        : {}),
      awardability: score(
        "Judging only from `caseData`, how likely is a court to award `head` if the lawyer claims it? Do not use facts that are not in the state.",
        [...AWARDABILITY_LEVELS],
      ),
    },
  });

  const answers = response.answers as Record<string, { choice?: unknown; score?: number; confidence: number }>;
  const award = answers.awardability!;
  const awardability = Math.max(0, Math.min(AWARDABILITY_LEVELS.length - 1, Math.round(award.score ?? 0)));
  let support: DamageSupportVerdict | null = null;
  let confidence = award.confidence;
  if (withQuote && answers.support) {
    const s = answers.support;
    const raw: DamageSupportVerdict = (DAMAGE_SUPPORT_VERDICTS as readonly unknown[]).includes(s.choice)
      ? (s.choice as DamageSupportVerdict)
      : "UNSUPPORTED";
    support = raw === "CONTRADICTED" && s.confidence < DAMAGE_CONTRADICTION_MIN_CONFIDENCE ? "UNSUPPORTED" : raw;
    confidence = Math.min(confidence, s.confidence);
  }

  const rating = { support, awardability, confidence };
  logger.info("Jev response", { feature: "damages", headId: head.id, ...rating });
  return rating;
}

/**
 * Rates every head in parallel. A head whose call fails is simply missing from the result (its
 * jev* columns keep whatever they had). Returns an empty map without calling Jev when the flag is
 * off. Never throws: the damages pass that calls it must still finish.
 */
export async function verifyDamageHeadsWithJev(
  heads: DamageJevHead[],
  context: DamageJevContext,
): Promise<Map<string, DamageJevRating>> {
  const out = new Map<string, DamageJevRating>();
  if (!isDamagesJevEnabled() || heads.length === 0) return out;
  await Promise.all(
    heads.map(async (head) => {
      try {
        out.set(head.id, await rateDamageHeadWithJev(head, context));
      } catch (err) {
        logger.warn("Jev error", { feature: "damages", headId: head.id, err });
      }
    }),
  );
  return out;
}
