import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import { describeDamageBasis, parseDamageBasis } from "./damages-compute";
import { evidenceNameMatches } from "./damages-proposal";
import { checkProofWithJev, PROOF_CONFIRM_MIN_CONFIDENCE } from "./witness-need-proof-jev";
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

/**
 * The one figure an AI head took from its source quote: a monthly rate, a stated amount or a
 * percentage. The support question compares the quote with this alone — the period and the
 * resulting amount are the lawyer's inputs, so a quote reading "salary £2,900" must not be judged
 * against "£87 accrued over one day".
 */
export function quotedFigureOf(basis: unknown, amount: number | null): string | null {
  const b = parseDamageBasis(basis);
  if (b.kind === "RATE_X_PERIOD") return `${b.monthlyRate} per month`;
  if (b.kind === "PERCENT_OF") return `${b.percent}%`;
  return amount != null ? String(amount) : null;
}

export function buildDamageJevState(head: DamageJevHead, context: DamageJevContext) {
  const quotedFigure = head.sourceQuote ? quotedFigureOf(head.basis, head.amount) : null;
  return {
    head: {
      category: head.category,
      label: head.label ?? head.category,
      amount: head.amount,
      basis: describeDamageBasis(head.basis) ?? "a fixed amount",
    },
    ...(head.sourceQuote ? { quote: head.sourceQuote } : {}),
    ...(quotedFigure ? { quotedFigure } : {}),
    caseData: {
      legalIssues: context.legalIssues.slice(0, MAX_CONTEXT_ITEMS),
      strengths: context.strengths.slice(0, MAX_CONTEXT_ITEMS),
      weaknesses: context.weaknesses.slice(0, MAX_CONTEXT_ITEMS),
    },
  };
}

/** Throws on a Jev failure — verifyDamageHeadsWithJev decides what that means. */
export async function rateDamageHeadWithJev(head: DamageJevHead, context: DamageJevContext): Promise<DamageJevRating> {
  const withQuote = !!head.sourceQuote && quotedFigureOf(head.basis, head.amount) !== null;
  logger.info("Jev request", { feature: "damages", headId: head.id, category: head.category, withQuote });
  const response = await getTypeSafeClient().systemOne({
    state: buildDamageJevState(head, context),
    questions: {
      ...(withQuote
        ? {
            support: choice(
              "`head` is one head of damages in a lawyer's damages model. `quote` is the line from a case document it was built from, and `quotedFigure` is the one figure taken from that line (a monthly rate, a stated amount or a percentage); the head's period and resulting amount are the lawyer's own inputs, not taken from the quote, so ignore them. Classify the relationship between `quote` and `quotedFigure` for what `head` is: SUPPORTED if `quote` states that figure for that purpose; UNSUPPORTED if `quote` does not state it or states it for something else; CONTRADICTED if `quote` states a different figure for the same thing.",
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

/**
 * Is `doc` the evidence a head is waiting on (DamageClaim.pendingEvidence, e.g. "payroll
 * certification")? Decides whether applying a proposed update may also certify the head.
 *
 * With USE_JEV_DAMAGES on, Jev reads the document (the same fit check that guards a witness
 * "what's needed" tick): true only for SATISFIES at or above PROOF_CONFIRM_MIN_CONFIDENCE, false for
 * DOES_NOT_SATISFY, null for PARTLY / CANNOT_TELL / a weak SATISFIES — the figures can still be
 * offered, but the head stays provisional. Off, it falls back to the document's name
 * (evidenceNameMatches), which can only say yes or "can't tell". Never throws.
 */
export async function checkPendingEvidence(
  pendingEvidence: string,
  doc: { name: string; category?: string | null; text: string | null },
): Promise<boolean | null> {
  if (!isDamagesJevEnabled()) return evidenceNameMatches(pendingEvidence, doc);
  const result = await checkProofWithJev({
    requirement: pendingEvidence,
    document: { name: doc.name, category: doc.category ?? null, summary: null, text: doc.text },
  });
  if (result.verdict === "SATISFIES" && result.confidence >= PROOF_CONFIRM_MIN_CONFIDENCE) return true;
  if (result.verdict === "DOES_NOT_SATISFY") return false;
  return null;
}
