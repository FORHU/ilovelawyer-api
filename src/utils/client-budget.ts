import type { QuoteType } from "@prisma/client";

/** Client Budget: what a client says they can spend on a lawyer, in pence like a quote. The client
 * app offers ranges ("£500–£1,500"), the client's own amount (low = high) and "Not sure" (no
 * budget). A null high is open-ended ("Over £5,000"). Null `feePreference`: either kind of fee. */
export interface ClientBudget {
  minMinor: number | null;
  maxMinor: number | null;
  feePreference: QuoteType | null;
}

/** The Case columns a budget is stored in. Optional so a row from a query that predates them reads as no budget. */
export interface BudgetColumns {
  budgetMinMinor?: number | null;
  budgetMaxMinor?: number | null;
  budgetFeePreference?: QuoteType | null;
}

/** The case's budget, or null when the client set none. */
export function budgetOf(row: BudgetColumns): ClientBudget | null {
  const budget = { minMinor: row.budgetMinMinor ?? null, maxMinor: row.budgetMaxMinor ?? null, feePreference: row.budgetFeePreference ?? null };
  return budget.minMinor === null && budget.maxMinor === null && budget.feePreference === null ? null : budget;
}

/** What to write to the Case for a budget; null clears it. */
export function budgetColumns(budget: ClientBudget | null): Required<BudgetColumns> {
  return { budgetMinMinor: budget?.minMinor ?? null, budgetMaxMinor: budget?.maxMinor ?? null, budgetFeePreference: budget?.feePreference ?? null };
}
