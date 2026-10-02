import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/**
 * Jev as the reviewer behind the damages extraction — never shown to the lawyer. Chat Wonder
 * proposes entries from the case's documents; before any is saved, Jev reads each one's quoted line
 * and says whether it really states the amount taken from it (vetDamageHeads). DamagesExtractSvc
 * sends the ones Jev rejects back to Chat Wonder once, with the reason, and keeps only what Jev then
 * accepts — so a wrong figure is corrected or dropped rather than reaching the panel with a warning.
 * Off unless USE_JEV_DAMAGES=true, like the other Jev pilots; with it off, proposals are kept on
 * the parser's own checks (quote in the document, amount in the quote).
 */

export function isDamagesJevEnabled(): boolean {
  return process.env.USE_JEV_DAMAGES === "true";
}

export const DAMAGE_SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type DamageSupportVerdict = (typeof DAMAGE_SUPPORT_VERDICTS)[number];

/** CONTRADICTED is the accusatory verdict — below this it's treated as UNSUPPORTED, same floor and
 * reason as red-team-jev.ts. Provisional until the damages benchmark is run. */
export const DAMAGE_CONTRADICTION_MIN_CONFIDENCE = 0.7;

/** A proposal is only rejected when Jev says so with at least this confidence; below it, Jev can't
 * tell, and the parser's own checks (the figure is written in the quote) stand. */
export const DAMAGE_REJECT_MIN_CONFIDENCE = 0.5;

/** The parts of a proposed entry the quote check reads. */
export interface QuotedHead {
  kind: string;
  title: string;
  amount: number | null;
  quote: string;
}

export interface QuotedFigureCheck {
  verdict: DamageSupportVerdict;
  confidence: number;
}

/** The figure an entry took from its quote — its amount; null for an entry with none. */
export function quotedFigureOf(amount: number | null): string | null {
  return amount != null ? String(amount) : null;
}

/** Does the head's quote state the figure taken from it? Null when there is no figure to check or
 * the Jev call fails — the caller then keeps the parser's verdict. */
export async function checkQuotedFigure(head: QuotedHead): Promise<QuotedFigureCheck | null> {
  const quotedFigure = quotedFigureOf(head.amount);
  if (!quotedFigure) return null;
  try {
    logger.info("Jev request", { feature: "damages-quote", kind: head.kind, quotedFigure });
    const response = await getTypeSafeClient().systemOne({
      state: { head: { kind: head.kind, title: head.title }, quote: head.quote, quotedFigure },
      questions: {
        support: choice(
          "`head` is a damages or remedy entry proposed from a case document. `quote` is the line it was taken from, and `quotedFigure` is the amount taken from that line. Classify the relationship between `quote` and `quotedFigure` for what `head` is: SUPPORTED if `quote` states that amount for that purpose; UNSUPPORTED if `quote` does not state it, or states it for something else (for example a monthly salary taken as the whole claim); CONTRADICTED if `quote` states a different amount for the same thing.",
          { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
        ),
      },
    });
    const s = response.answers.support;
    const raw: DamageSupportVerdict = (DAMAGE_SUPPORT_VERDICTS as readonly unknown[]).includes(s.choice)
      ? (s.choice as DamageSupportVerdict)
      : "UNSUPPORTED";
    const verdict = raw === "CONTRADICTED" && s.confidence < DAMAGE_CONTRADICTION_MIN_CONFIDENCE ? "UNSUPPORTED" : raw;
    logger.info("Jev response", { feature: "damages-quote", kind: head.kind, verdict, confidence: s.confidence });
    return { verdict, confidence: s.confidence };
  } catch (err) {
    logger.warn("Jev error", { feature: "damages-quote", kind: head.kind, err });
    return null;
  }
}

export function isRejected(check: QuotedFigureCheck | null): check is QuotedFigureCheck {
  return !!check && check.verdict !== "SUPPORTED" && check.confidence >= DAMAGE_REJECT_MIN_CONFIDENCE;
}

/**
 * Checks every proposed head in parallel and splits them: `accepted` (Jev agrees, can't tell, or
 * couldn't be asked) and `rejected` (Jev says the quote doesn't state the figure, with the verdict
 * for the follow-up question to Chat Wonder). With the flag off, everything is accepted unchecked.
 */
export async function vetDamageHeads<T extends QuotedHead>(
  heads: T[],
): Promise<{ accepted: T[]; rejected: { head: T; check: QuotedFigureCheck }[] }> {
  if (!isDamagesJevEnabled() || heads.length === 0) return { accepted: heads, rejected: [] };
  const checks = await Promise.all(heads.map((h) => checkQuotedFigure(h)));
  const accepted: T[] = [];
  const rejected: { head: T; check: QuotedFigureCheck }[] = [];
  heads.forEach((head, i) => {
    const check = checks[i] ?? null;
    if (isRejected(check)) rejected.push({ head, check });
    else accepted.push(head);
  });
  return { accepted, rejected };
}
