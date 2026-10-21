/**
 * What the client app charges (pay per case, plus credit top-ups). PLACEHOLDERS until pricing is
 * agreed (FORHU/ilovelawyer-app#795, #846). The client app reads them from GET
 * /api/client/pricing and never hard-codes them, except its Terms text (TERMS_CASE_PRICE in
 * ilovelawyer-client), which must be kept in step.
 */
export const CLIENT_CURRENCY = "USD";

/** One case, in cents, and the chat credits it comes with. Each message to the AI uses one. */
export const CLIENT_CASE_PRICE_MINOR = 999;
export const CLIENT_CASE_CREDITS = 50;

export interface ClientTopUpPack {
  id: string;
  name: string;
  credits: number;
  priceMinor: number;
}

export const CLIENT_TOP_UP_PACKS: readonly ClientTopUpPack[] = [
  { id: "p25", name: "Small", credits: 25, priceMinor: 499 },
  { id: "p100", name: "Standard", credits: 100, priceMinor: 1499 },
  { id: "p250", name: "Large", credits: 250, priceMinor: 2999 },
];
export const CLIENT_DEFAULT_TOP_UP_PACK = "p100";

/** Promo codes, matched case-insensitively. `firstCaseOnly`: only for a client who has never paid
 * for a case. */
export const CLIENT_PROMOS: readonly { code: string; discountMinor: number; firstCaseOnly: boolean; description: string }[] = [
  { code: "WELCOME5", discountMinor: 500, firstCaseOnly: true, description: "$5 off your first case" },
];
