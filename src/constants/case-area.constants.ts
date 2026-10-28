export interface DefaultCaseArea {
  code: string;
  name: string;
  description: string;
}

/** Where a case nothing else fits goes. Always there and always on: it can be renamed, but not
 * switched off or deleted. */
export const OTHER_CASE_AREA = "OTHER";

/** Never a case area: referral fees are banned in personal injury, so Jev recognises it on its own
 * and such cases are refused a lawyer (PERSONAL_INJURY_EXCLUDED). */
export const PERSONAL_INJURY = "PERSONAL_INJURY";

/**
 * The kinds of problem a client's case can be about that the UK site starts with, in picker order.
 * The case_areas migration inserted them, and prisma/seeders/case-area.seeder.ts adds back any that
 * are missing; neither touches a row an admin has since edited. The descriptions are what Jev was
 * told before admins could edit them.
 */
export const DEFAULT_CASE_AREAS: readonly DefaultCaseArea[] = [
  { code: "EMPLOYMENT", name: "Employment", description: "Work, dismissal, pay, discrimination at work." },
  { code: "PROPERTY", name: "Property", description: "Renting, landlords, deposits, buying or owning a home, neighbours." },
  { code: "FAMILY", name: "Family", description: "Divorce, separation, children." },
  { code: "CONSUMER", name: "Consumer", description: "Goods, services, refunds, problems with a business." },
  { code: OTHER_CASE_AREA, name: "Other", description: "Anything else." },
];

/** A code is set once, when the area is made: capitals, digits and underscores. */
export const CASE_AREA_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const CASE_AREA_NAME_MAX_LENGTH = 60;
export const CASE_AREA_DESCRIPTION_MAX_LENGTH = 500;
