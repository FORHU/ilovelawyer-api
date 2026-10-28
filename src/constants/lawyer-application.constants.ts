/**
 * A Lawyer Application differs by country: what the admin checks, the fee's currency and the
 * reasons an admin can reject with. The practice areas a lawyer can pick are per country too, but
 * admins manage them (PracticeArea; defaults in practice-area.constants.ts). UK values that the
 * client hand-off also uses (UK_JURISDICTIONS, LAWYER_REGULATORS) stay in types/client-handoff.ts;
 * this file adds the country split and the PH values. The PH rules aren't final, so expect the PH
 * lists to change.
 */
export const LAWYER_COUNTRIES = ["UK", "PH"] as const;
export type LawyerCountry = (typeof LAWYER_COUNTRIES)[number];

export function isLawyerCountry(code: string | null | undefined): code is LawyerCountry {
  return !!code && (LAWYER_COUNTRIES as readonly string[]).includes(code);
}

export const FEE_CURRENCY_BY_COUNTRY = { UK: "GBP", PH: "PHP" } as const satisfies Record<LawyerCountry, string>;
export type FeeCurrency = (typeof FEE_CURRENCY_BY_COUNTRY)[LawyerCountry];

/** Why an admin rejects a UK application. Each but OTHER sends the lawyer a canned sentence. */
export const UK_REJECTION_REASONS = ["NAME_MISMATCH", "NOT_PRACTISING", "WRONG_JURISDICTION", "OTHER"] as const;
/** The PH equivalents: checked against the Roll of Attorneys and the IBP, not a register. */
export const PH_REJECTION_REASONS = ["NAME_MISMATCH", "ROLL_NOT_FOUND", "NOT_IN_GOOD_STANDING", "OTHER"] as const;

export const REJECTION_REASONS_BY_COUNTRY: Record<LawyerCountry, readonly string[]> = {
  UK: UK_REJECTION_REASONS,
  PH: PH_REJECTION_REASONS,
};

/** Every reason either country takes, for request validation; the service then checks the reason
 * against the application's own country. */
export const LAWYER_REJECTION_REASONS = [...new Set([...UK_REJECTION_REASONS, ...PH_REJECTION_REASONS])] as (
  | (typeof UK_REJECTION_REASONS)[number]
  | (typeof PH_REJECTION_REASONS)[number]
)[];
export type LawyerRejectionReason = (typeof LAWYER_REJECTION_REASONS)[number];
