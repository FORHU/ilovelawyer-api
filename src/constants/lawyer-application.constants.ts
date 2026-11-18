/**
 * A Lawyer Application differs by country: what the admin checks, the fee's currency and the
 * reasons an admin can reject with. The practice areas a lawyer can pick are per country too, but
 * admins manage them (PracticeArea; defaults in practice-area.constants.ts). UK values that the
 * client hand-off also uses (UK_JURISDICTIONS, LAWYER_REGULATORS) stay in types/client-handoff.ts;
 * this file adds the country split and the PH values. The PH rules aren't final, so expect the PH
 * lists to change.
 */
export const LAWYER_COUNTRIES = ["UK", "PH", "KR"] as const;
export type LawyerCountry = (typeof LAWYER_COUNTRIES)[number];

export function isLawyerCountry(code: string | null | undefined): code is LawyerCountry {
  return !!code && (LAWYER_COUNTRIES as readonly string[]).includes(code);
}

export const FEE_CURRENCY_BY_COUNTRY = { UK: "GBP", PH: "PHP", KR: "KRW" } as const satisfies Record<LawyerCountry, string>;
export type FeeCurrency = (typeof FEE_CURRENCY_BY_COUNTRY)[LawyerCountry];

/** The highest first-consultation fee, in minor units: a ceiling for typos, not a pricing rule.
 * £10,000 or ₱10,000 (two decimals), and ₩10,000,000 (KRW has none). */
export const FEE_MAX_MINOR_BY_COUNTRY: Record<LawyerCountry, number> = { UK: 1_000_000, PH: 1_000_000, KR: 10_000_000 };

/** Why an admin rejects a UK application. Each but OTHER sends the lawyer a canned sentence. */
export const UK_REJECTION_REASONS = ["NAME_MISMATCH", "NOT_PRACTISING", "WRONG_JURISDICTION", "OTHER"] as const;
/** The PH equivalents: checked against the Roll of Attorneys and the IBP, not a register. */
export const PH_REJECTION_REASONS = ["NAME_MISMATCH", "ROLL_NOT_FOUND", "NOT_IN_GOOD_STANDING", "OTHER"] as const;
/** The KR equivalents: checked against the Korean Bar Association's register (대한변호사협회). */
export const KR_REJECTION_REASONS = ["NAME_MISMATCH", "REGISTRATION_NOT_FOUND", "NOT_PRACTISING", "OTHER"] as const;

export const REJECTION_REASONS_BY_COUNTRY: Record<LawyerCountry, readonly string[]> = {
  UK: UK_REJECTION_REASONS,
  PH: PH_REJECTION_REASONS,
  KR: KR_REJECTION_REASONS,
};

/** Every reason any country takes, for request validation; the service then checks the reason
 * against the application's own country. */
export const LAWYER_REJECTION_REASONS = [...new Set([...UK_REJECTION_REASONS, ...PH_REJECTION_REASONS, ...KR_REJECTION_REASONS])] as (
  | (typeof UK_REJECTION_REASONS)[number]
  | (typeof PH_REJECTION_REASONS)[number]
  | (typeof KR_REJECTION_REASONS)[number]
)[];

/** The 14 local bar associations (지방변호사회) a Korean lawyer belongs to. The code is stored; the
 * apps show the Korean name. To be confirmed by a Korean lawyer before launch. */
export const KR_LOCAL_BARS = [
  "SEOUL", // 서울지방변호사회
  "GYEONGGI_BUKBU", // 경기북부지방변호사회
  "INCHEON", // 인천지방변호사회
  "GYEONGGI_JUNGANG", // 경기중앙지방변호사회
  "GANGWON", // 강원지방변호사회
  "CHUNGBUK", // 충북지방변호사회
  "DAEJEON", // 대전지방변호사회
  "DAEGU", // 대구지방변호사회
  "BUSAN", // 부산지방변호사회
  "ULSAN", // 울산지방변호사회
  "GYEONGNAM", // 경남지방변호사회
  "GWANGJU", // 광주지방변호사회
  "JEONBUK", // 전북지방변호사회
  "JEJU", // 제주지방변호사회
] as const;
export type KrLocalBar = (typeof KR_LOCAL_BARS)[number];

/** How a Korean lawyer qualified: the bar exam (변호사시험, by round) or the Judicial Research and
 * Training Institute (사법연수원, by class). */
export const KR_QUALIFICATION_ROUTES = ["BAR_EXAM", "JRTI"] as const;
export type KrQualificationRoute = (typeof KR_QUALIFICATION_ROUTES)[number];
export type LawyerRejectionReason = (typeof LAWYER_REJECTION_REASONS)[number];
