/**
 * LEGAL_REVIEW_REQUIRED: England & Wales bank holidays only — Scotland and Northern Ireland
 * observe a different set (e.g. St Andrew's Day, no separate Boxing Day substitute rules) and
 * are explicitly out of scope for this engine. Dates are computed calendar facts (Easter via
 * the standard algorithm, "nth Monday of month" bank holidays, weekend-substitution rules),
 * not legal interpretation — but the CPR day-counting rules that consume them (see
 * uk-deadline.engine.ts) still require attorney/legal review before any date here is treated
 * as a real filing deadline, mirroring the disclaimer the PH engine already carries.
 */
export const UK_FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  // New Year's Day, Christmas Day, and Boxing Day shift when they fall on a weekend (see
  // UK_VARIABLE_HOLIDAYS below for the year-specific observed dates); nothing here is
  // weekend-invariant enough to hardcode as a fixed month/day pair.
];

/** month is 1-based. Computed via the standard Easter algorithm + "nth Monday of month" bank
 * holiday rules + weekend-substitution for New Year's Day/Christmas Day/Boxing Day. */
export const UK_VARIABLE_HOLIDAYS: Record<number, { month: number; day: number; name: string }[]> = {
  2026: [
    { month: 1, day: 1, name: "New Year's Day" },
    { month: 4, day: 3, name: "Good Friday" },
    { month: 4, day: 6, name: "Easter Monday" },
    { month: 5, day: 4, name: "Early May bank holiday" },
    { month: 5, day: 25, name: "Spring bank holiday" },
    { month: 8, day: 31, name: "Summer bank holiday" },
    { month: 12, day: 25, name: "Christmas Day" },
    { month: 12, day: 28, name: "Boxing Day (substitute, falls on a Saturday)" },
  ],
  2027: [
    { month: 1, day: 1, name: "New Year's Day" },
    { month: 3, day: 26, name: "Good Friday" },
    { month: 3, day: 29, name: "Easter Monday" },
    { month: 5, day: 3, name: "Early May bank holiday" },
    { month: 5, day: 31, name: "Spring bank holiday" },
    { month: 8, day: 30, name: "Summer bank holiday" },
    { month: 12, day: 27, name: "Christmas Day (substitute, falls on a Saturday)" },
    { month: 12, day: 28, name: "Boxing Day (substitute, falls on a Sunday)" },
  ],
  2028: [
    { month: 1, day: 3, name: "New Year's Day (substitute, falls on a Saturday)" },
    { month: 4, day: 14, name: "Good Friday" },
    { month: 4, day: 17, name: "Easter Monday" },
    { month: 5, day: 1, name: "Early May bank holiday" },
    { month: 5, day: 29, name: "Spring bank holiday" },
    { month: 8, day: 28, name: "Summer bank holiday" },
    { month: 12, day: 25, name: "Christmas Day" },
    { month: 12, day: 26, name: "Boxing Day" },
  ],
};

export interface UKDeadlineRule {
  code: string;
  label: string;
  days: number;
  ruleSource: string;
}

/**
 * LEGAL_REVIEW_REQUIRED: drafted from general public knowledge of the Civil Procedure Rules
 * (England & Wales) — a small, well-documented set of headline periods, not a comprehensive
 * rule set. Every entry must be validated by a UK-qualified lawyer before being relied on as a
 * real filing deadline. Do not extend this list without the same review.
 */
export const UK_DEADLINE_RULES: UKDeadlineRule[] = [
  {
    code: "acknowledgment_of_service",
    label: "Acknowledgment of service",
    days: 14,
    ruleSource: "LEGAL_REVIEW_REQUIRED: Civil Procedure Rules, Part 10",
  },
  {
    code: "defence_after_acknowledgment",
    label: "Defence, after filing an acknowledgment of service",
    days: 28,
    ruleSource: "LEGAL_REVIEW_REQUIRED: Civil Procedure Rules, Part 15",
  },
  {
    code: "appellants_notice",
    label: "Appellant's notice",
    days: 21,
    ruleSource: "LEGAL_REVIEW_REQUIRED: Civil Procedure Rules, Part 52",
  },
];
