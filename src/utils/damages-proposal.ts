import { parseDamageBasis, type DamageBasis } from "./damages-compute";

/**
 * A suggested update to an existing head, stored in DamageClaim.aiProposedBasis — never applied
 * on its own. Written by DamagesExtractSvc when a newly read document states a figure for a head
 * the case already has (e.g. the payroll certification's rate for the backwages head), and applied
 * or dismissed by the lawyer (DamageClaimSvc.applyProposal / dismissProposal).
 */
export interface DamageProposal {
  basis: DamageBasis;
  /** The stated figure when `basis` is FIXED; null otherwise. */
  amount: number | null;
  sourceDocumentId: string;
  documentName: string;
  sourceQuote: string;
  /** Is the document the evidence the head was waiting on (DamageClaim.pendingEvidence)? true =
   * applying also certifies the head; false = checked, and it isn't; null = no pending evidence,
   * or it couldn't be told. */
  satisfiesPending: boolean | null;
  proposedAt: string;
}

export function parseDamageProposal(raw: unknown): DamageProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.sourceDocumentId !== "string" || typeof p.sourceQuote !== "string" || !p.basis) return null;
  return {
    basis: parseDamageBasis(p.basis),
    amount: typeof p.amount === "number" && Number.isFinite(p.amount) ? p.amount : null,
    sourceDocumentId: p.sourceDocumentId,
    documentName: typeof p.documentName === "string" ? p.documentName : "",
    sourceQuote: p.sourceQuote,
    satisfiesPending: typeof p.satisfiesPending === "boolean" ? p.satisfiesPending : null,
    proposedAt: typeof p.proposedAt === "string" ? p.proposedAt : new Date(0).toISOString(),
  };
}

type Figures = { basis: unknown; amount: number | null };

/** Do the found figures say something different from the head's current ones? Only the numbers a
 * document can state are compared: a FIXED amount, a monthly rate (and a stated number of months),
 * a percentage and what it is a percentage of. */
export function figuresDiffer(current: Figures, found: Figures): boolean {
  const a = parseDamageBasis(current.basis);
  const b = parseDamageBasis(found.basis);
  if (a.kind !== b.kind) return true;
  if (a.kind === "FIXED" && b.kind === "FIXED") return current.amount !== found.amount;
  if (a.kind === "RATE_X_PERIOD" && b.kind === "RATE_X_PERIOD") {
    return a.monthlyRate !== b.monthlyRate || (b.months !== undefined && a.months !== b.months);
  }
  if (a.kind === "PERCENT_OF" && b.kind === "PERCENT_OF") {
    return a.percent !== b.percent || [...a.categories].sort().join() !== [...b.categories].sort().join();
  }
  return false;
}

/** The basis to propose: the found figures, keeping the lawyer's own period (dates, accrual,
 * projected finality) when only the rate changed — a payslip states a rate, not how long it ran. */
export function mergeProposedBasis(current: unknown, found: DamageBasis): DamageBasis {
  const a = parseDamageBasis(current);
  if (a.kind === "RATE_X_PERIOD" && found.kind === "RATE_X_PERIOD") {
    const useFoundMonths = found.months !== undefined && a.fromDate === undefined;
    return { ...a, monthlyRate: found.monthlyRate, ...(useFoundMonths ? { months: found.months } : {}) };
  }
  return found;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-./\\()[\],:;]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Without Jev: does the document's name or folder plainly name the pending evidence? Every word of
 * 4+ letters in `pendingEvidence` must start a word of the name/category (matched on its first six
 * letters, so "certification" finds "Certificate"). true on a match, null otherwise — a name that
 * doesn't match proves nothing either way.
 */
export function evidenceNameMatches(pendingEvidence: string, doc: { name: string; category?: string | null }): true | null {
  const wanted = words(pendingEvidence).filter((w) => w.length >= 4);
  if (wanted.length === 0) return null;
  const have = words(`${doc.name} ${doc.category ?? ""}`);
  const hit = wanted.every((w) => have.some((h) => h.startsWith(w.slice(0, 6))));
  return hit ? true : null;
}
