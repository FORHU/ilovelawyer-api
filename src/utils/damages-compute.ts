import type { TenantCode } from "../types/tenant-code";

/**
 * The Damages & Remedies model's arithmetic — the one place a head's amount, the case total, each
 * head's share and the exposure range are worked out. Pure (no DB, no LLM): DamageClaimSvc calls
 * it to persist computed amounts, and the snapshot calls it to serve `damagesSummary`, so the
 * panel, Red Team and chat all read the same numbers. The model proposes inputs, never totals.
 */

export const DAMAGE_CATEGORIES = ["ACTUAL", "MORAL", "EXEMPLARY", "ATTORNEYS_FEES", "OTHER"] as const;
export type DamageCategoryValue = (typeof DAMAGE_CATEGORIES)[number];

export const DAMAGE_STATUSES = ["PROVISIONAL", "SUPPORTED", "CERTIFIED"] as const;
export type DamageStatusValue = (typeof DAMAGE_STATUSES)[number];

/** How a head's amount is reached. Stored in DamageClaim.basis; null reads as FIXED. */
export type DamageBasis =
  /** The amount is whatever the lawyer entered (DamageClaim.amount). */
  | { kind: "FIXED" }
  /** monthlyRate × months, or × the months between fromDate and untilDate (ISO dates). untilDate
   * "asOf" keeps the period running to the day the summary is computed — backwages accrue until
   * the decision becomes final. highUntilDate, a projected finality date, sets the head's high end
   * the same way when no explicit amountHigh is given. */
  | {
      kind: "RATE_X_PERIOD";
      monthlyRate: number;
      months?: number;
      fromDate?: string;
      untilDate?: string;
      highUntilDate?: string;
    }
  /** percent% of the sum of the case's heads in `categories` — e.g. attorney's fees at 10% of
   * Actual + Moral + Exemplary. Only non-PERCENT_OF heads count toward the base, so two derived
   * heads can never feed each other. */
  | { kind: "PERCENT_OF"; percent: number; categories: DamageCategoryValue[] };

export interface DamageHeadInput {
  id: string;
  category: DamageCategoryValue;
  amount: number | null;
  basis: unknown;
  amountLow: number | null;
  amountHigh: number | null;
  status: DamageStatusValue;
  pendingEvidence: string | null;
}

export interface DamageHeadResult {
  id: string;
  category: DamageCategoryValue;
  /** Null only for a FIXED head with no amount, or a RATE_X_PERIOD head with no period. */
  amount: number | null;
  low: number | null;
  high: number | null;
  /** 0..1 of the total; 0 when the total is 0. */
  share: number;
  /** A PERCENT_OF head is only as firm as the weakest head it is computed from. */
  effectiveStatus: DamageStatusValue;
  derived: boolean;
}

export interface DamagesSummary {
  currency: "PHP" | "GBP";
  total: number;
  low: number;
  high: number;
  /** A readable ceiling for the exposure bar's scale (1.24M → 1.4M). */
  scaleMax: number;
  headCount: number;
  heads: DamageHeadResult[];
  /** True when any head's effective status is PROVISIONAL. */
  provisional: boolean;
  /** Distinct pendingEvidence of the provisional heads, in head order. */
  pendingEvidence: string[];
  /** The day accruing heads (untilDate "asOf") were computed to, as YYYY-MM-DD; null when no head
   * accrues. */
  asOf: string | null;
}

/** untilDate value meaning "up to the day the summary is computed". */
export const AS_OF = "asOf";

const STATUS_RANK: Record<DamageStatusValue, number> = { PROVISIONAL: 0, SUPPORTED: 1, CERTIFIED: 2 };

export function currencyForTenant(tenantCode: TenantCode | null | undefined): "PHP" | "GBP" {
  return tenantCode === "UK" ? "GBP" : "PHP";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isCategory(value: unknown): value is DamageCategoryValue {
  return typeof value === "string" && (DAMAGE_CATEGORIES as readonly string[]).includes(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads a stored basis defensively — it is a Json column, so anything malformed reads as FIXED
 * rather than throwing inside the snapshot. */
export function parseDamageBasis(raw: unknown): DamageBasis {
  if (!raw || typeof raw !== "object") return { kind: "FIXED" };
  const b = raw as Record<string, unknown>;
  if (b.kind === "RATE_X_PERIOD") {
    const monthlyRate = finite(b.monthlyRate);
    if (monthlyRate === undefined) return { kind: "FIXED" };
    // Unset fields are left out rather than set to undefined, so a parsed basis round-trips to the
    // same JSON it was stored as.
    const months = finite(b.months);
    return {
      kind: "RATE_X_PERIOD",
      monthlyRate,
      ...(months !== undefined ? { months } : {}),
      ...(typeof b.fromDate === "string" ? { fromDate: b.fromDate } : {}),
      ...(typeof b.untilDate === "string" ? { untilDate: b.untilDate } : {}),
      ...(typeof b.highUntilDate === "string" ? { highUntilDate: b.highUntilDate } : {}),
    };
  }
  if (b.kind === "PERCENT_OF") {
    const percent = finite(b.percent);
    const categories = Array.isArray(b.categories) ? b.categories.filter(isCategory) : [];
    if (percent === undefined || categories.length === 0) return { kind: "FIXED" };
    return { kind: "PERCENT_OF", percent, categories: [...new Set(categories)] };
  }
  return { kind: "FIXED" };
}

/** Whole calendar months from `from` to `until`, plus the leftover days as a fraction of a
 * 30-day month (the usual payroll convention), to 2 decimals. Undefined for bad or reversed dates. */
export function monthsBetween(from: string, until: string): number | undefined {
  const a = new Date(from);
  const b = new Date(until);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return undefined;
  // `from` + n months, clamped to the month's last day so Jan 31 + 1 month is Feb 28, not Mar 3.
  const addMonths = (n: number) => {
    const lastDay = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n + 1, 0)).getUTCDate();
    return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n, Math.min(a.getUTCDate(), lastDay)));
  };
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  let anchor = addMonths(months);
  if (anchor > b) {
    months -= 1;
    anchor = addMonths(months);
  }
  const days = Math.round((b.getTime() - anchor.getTime()) / 86_400_000);
  return round2(months + days / 30);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periodMonths(basis: Extract<DamageBasis, { kind: "RATE_X_PERIOD" }>, asOf: Date = new Date()): number | undefined {
  if (basis.months !== undefined) return basis.months;
  if (basis.fromDate && basis.untilDate) {
    return monthsBetween(basis.fromDate, basis.untilDate === AS_OF ? isoDay(asOf) : basis.untilDate);
  }
  return undefined;
}

function accrues(basis: DamageBasis): boolean {
  return basis.kind === "RATE_X_PERIOD" && basis.months === undefined && basis.untilDate === AS_OF;
}

/** Does this head have the inputs its basis needs? CERTIFIED is refused without them. */
export function hasBasisInputs(head: Pick<DamageHeadInput, "amount" | "basis">): boolean {
  const basis = parseDamageBasis(head.basis);
  if (basis.kind === "FIXED") return head.amount != null;
  if (basis.kind === "RATE_X_PERIOD") return periodMonths(basis) !== undefined;
  return true;
}

/** Rounds `value` up to the next step of a fifth of its order of magnitude: 1.24M → 1.4M,
 * 918.6K → 920K, 47K → 48K. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = magnitude / 5;
  return round2(Math.ceil(value / step - 1e-9) * step);
}

export function computeDamagesSummary(
  heads: DamageHeadInput[],
  tenantCode?: TenantCode | null,
  /** "Today" for accruing heads; injectable so the result is testable. */
  asOf: Date = new Date(),
): DamagesSummary {
  const parsed = heads.map((head) => ({ head, basis: parseDamageBasis(head.basis) }));

  // Pass 1: every head that isn't derived from other heads.
  const base = new Map<string, { amount: number | null; low: number | null; high: number | null }>();
  for (const { head, basis } of parsed) {
    if (basis.kind === "PERCENT_OF") continue;
    let amount: number | null;
    let projectedHigh: number | null = null;
    if (basis.kind === "RATE_X_PERIOD") {
      const months = periodMonths(basis, asOf);
      amount = months === undefined ? null : round2(basis.monthlyRate * months);
      const highMonths =
        basis.fromDate && basis.highUntilDate ? monthsBetween(basis.fromDate, basis.highUntilDate) : undefined;
      if (highMonths !== undefined) projectedHigh = round2(basis.monthlyRate * highMonths);
    } else {
      amount = head.amount;
    }
    base.set(head.id, {
      amount,
      low: head.amountLow ?? amount,
      // A projected finality date never lowers the high end below what has already accrued.
      high: head.amountHigh ?? (projectedHigh !== null ? Math.max(projectedHigh, amount ?? 0) : amount),
    });
  }

  // Pass 2: derived heads, from the base heads' amounts (and their lows/highs for the range).
  const results: DamageHeadResult[] = parsed.map(({ head, basis }) => {
    if (basis.kind !== "PERCENT_OF") {
      const v = base.get(head.id)!;
      return { id: head.id, category: head.category, ...v, share: 0, effectiveStatus: head.status, derived: false };
    }
    const sources = parsed.filter(
      (p) => p.basis.kind !== "PERCENT_OF" && basis.categories.includes(p.head.category),
    );
    const sum = (pick: "amount" | "low" | "high") =>
      sources.reduce((total, p) => total + (base.get(p.head.id)![pick] ?? 0), 0);
    const rate = basis.percent / 100;
    const amount = round2(sum("amount") * rate);
    const effectiveStatus = sources.reduce<DamageStatusValue>(
      (weakest, p) => (STATUS_RANK[p.head.status] < STATUS_RANK[weakest] ? p.head.status : weakest),
      head.status,
    );
    return {
      id: head.id,
      category: head.category,
      amount,
      low: head.amountLow ?? round2(sum("low") * rate),
      high: head.amountHigh ?? round2(sum("high") * rate),
      share: 0,
      effectiveStatus,
      derived: true,
    };
  });

  const total = round2(results.reduce((t, r) => t + (r.amount ?? 0), 0));
  const low = round2(results.reduce((t, r) => t + (r.low ?? 0), 0));
  const high = round2(results.reduce((t, r) => t + (r.high ?? 0), 0));
  for (const r of results) r.share = total > 0 && r.amount ? r.amount / total : 0;

  const pendingEvidence: string[] = [];
  for (const { head } of parsed) {
    const result = results.find((r) => r.id === head.id)!;
    const evidence = head.pendingEvidence?.trim();
    if (result.effectiveStatus === "PROVISIONAL" && evidence && !pendingEvidence.includes(evidence)) {
      pendingEvidence.push(evidence);
    }
  }

  return {
    currency: currencyForTenant(tenantCode),
    total,
    low,
    high,
    scaleMax: niceCeiling(Math.max(high, total)),
    headCount: results.length,
    heads: results,
    provisional: results.some((r) => r.effectiveStatus === "PROVISIONAL"),
    pendingEvidence,
    asOf: parsed.some((p) => accrues(p.basis)) ? isoDay(asOf) : null,
  };
}

/** A basis in words for prompts ("27000 × 18 months", "10% of ACTUAL + MORAL"); null for FIXED. */
export function describeDamageBasis(raw: unknown): string | null {
  const basis = parseDamageBasis(raw);
  if (basis.kind === "RATE_X_PERIOD") {
    const months = periodMonths(basis);
    if (months === undefined) return `${basis.monthlyRate} monthly, period not set`;
    return `${basis.monthlyRate} × ${months} months${accrues(basis) ? " (accruing to today)" : ""}`;
  }
  if (basis.kind === "PERCENT_OF") return `${basis.percent}% of ${basis.categories.join(" + ")}`;
  return null;
}

export interface DamagePromptHead {
  category: string;
  label?: string | null;
  description?: string | null;
  amount?: number | null;
  status?: string | null;
  low?: number | null;
  high?: number | null;
  basisText?: string | null;
  pendingEvidence?: string | null;
}

/** One head as a line of plain text for prompts (Red Team, chat), e.g.
 * "ACTUAL (Actual (backwages)): 486000 — unpaid wages [provisional; range 430000–560000; basis 27000 × 18 months; pending payroll certification]".
 * The description stays verbatim and in the same place, since Red Team's [ARGUMENTS] cite it as a source. */
export function formatDamageForPrompt(d: DamagePromptHead): string {
  const details: string[] = [];
  if (d.status) details.push(d.status.toLowerCase());
  if (d.low != null && d.high != null && (d.low !== d.amount || d.high !== d.amount)) details.push(`range ${d.low}–${d.high}`);
  if (d.basisText) details.push(`basis ${d.basisText}`);
  if (d.pendingEvidence && d.status === "PROVISIONAL") details.push(`pending ${d.pendingEvidence}`);
  return (
    `${d.category}${d.label ? ` (${d.label})` : ""}` +
    `${d.amount != null ? `: ${d.amount}` : ""}` +
    `${d.description ? ` — ${d.description}` : ""}` +
    `${details.length ? ` [${details.join("; ")}]` : ""}`
  );
}
