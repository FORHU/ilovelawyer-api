import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import { parseDamageBasis } from "./damages-compute";
import { evidenceNameMatches } from "./damages-proposal";
import { checkProofWithJev, PROOF_CONFIRM_MIN_CONFIDENCE } from "./witness-need-proof-jev";
import logger from "./logger";

/**
 * Jev as the reviewer behind the damages extraction — never shown to the lawyer. Chat Wonder
 * proposes heads from the case's documents; before any is saved, Jev reads each one's quoted line
 * and says whether it really states the figure taken from it (vetDamageHeads). DamagesExtractSvc
 * sends the ones Jev rejects back to Chat Wonder once, with the reason, and keeps only what Jev then
 * accepts — so a wrong figure is corrected or dropped rather than reaching the panel with a warning.
 *
 * Jev also decides whether a newly arrived document is the evidence a head was waiting on
 * (checkPendingEvidence). Off unless USE_JEV_DAMAGES=true, like the other Jev pilots; with it off,
 * proposals are kept on the parser's own checks (quote in the document, figure in the quote).
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

/** The parts of a proposed head the quote check reads. */
export interface QuotedHead {
  category: string;
  label: string | null;
  basis: unknown;
  amount: number | null;
  quote: string;
}

export interface QuotedFigureCheck {
  verdict: DamageSupportVerdict;
  confidence: number;
}

/**
 * The one figure a head took from its quote: a monthly rate, a stated amount or a percentage. The
 * check compares the quote with this alone — a period and the resulting amount are never taken
 * from the quote, so a line reading "salary £2,900" must not be judged against "£87 accrued".
 */
export function quotedFigureOf(basis: unknown, amount: number | null): string | null {
  const b = parseDamageBasis(basis);
  if (b.kind === "RATE_X_PERIOD") return `${b.monthlyRate} per month`;
  if (b.kind === "PERCENT_OF") return `${b.percent}%`;
  return amount != null ? String(amount) : null;
}

/** Does the head's quote state the figure taken from it? Null when there is no figure to check or
 * the Jev call fails — the caller then keeps the parser's verdict. */
export async function checkQuotedFigure(head: QuotedHead): Promise<QuotedFigureCheck | null> {
  const quotedFigure = quotedFigureOf(head.basis, head.amount);
  if (!quotedFigure) return null;
  try {
    logger.info("Jev request", { feature: "damages-quote", category: head.category, quotedFigure });
    const response = await getTypeSafeClient().systemOne({
      state: { head: { category: head.category, label: head.label ?? head.category }, quote: head.quote, quotedFigure },
      questions: {
        support: choice(
          "`head` is a head of damages proposed from a case document. `quote` is the line it was taken from, and `quotedFigure` is the figure taken from that line (a monthly rate, a stated amount or a percentage). Classify the relationship between `quote` and `quotedFigure` for what `head` is: SUPPORTED if `quote` states that figure for that purpose; UNSUPPORTED if `quote` does not state it, or states it for something else (for example net or gross pay taken as the basic salary); CONTRADICTED if `quote` states a different figure for the same thing.",
          { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
        ),
      },
    });
    const s = response.answers.support;
    const raw: DamageSupportVerdict = (DAMAGE_SUPPORT_VERDICTS as readonly unknown[]).includes(s.choice)
      ? (s.choice as DamageSupportVerdict)
      : "UNSUPPORTED";
    const verdict = raw === "CONTRADICTED" && s.confidence < DAMAGE_CONTRADICTION_MIN_CONFIDENCE ? "UNSUPPORTED" : raw;
    logger.info("Jev response", { feature: "damages-quote", category: head.category, verdict, confidence: s.confidence });
    return { verdict, confidence: s.confidence };
  } catch (err) {
    logger.warn("Jev error", { feature: "damages-quote", category: head.category, err });
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
