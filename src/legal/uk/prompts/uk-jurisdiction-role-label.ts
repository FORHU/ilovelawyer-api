// Shared by the lighter UK prompt builders (case-finding, case-reconstruction, case-strategy)
// that only need a one-line jurisdiction mention, not the full framing red-team.prompt.ts uses
// (courts/procedure/terminology). Keep the value set in sync with UK_JURISDICTIONS in
// ../../../validation/case.validation.ts.
const ARTICLE_BY_JURISDICTION: Record<string, string> = {
  "England and Wales": "an England & Wales",
  Scotland: "a Scotland",
  "Northern Ireland": "a Northern Ireland",
};

const DEFAULT_UK_JURISDICTION = "England and Wales";

/** Returns e.g. "an England & Wales" / "a Scotland" — ready to drop in front of "case" — falling
 * back to the historical England & Wales default (flagged as assumed) when unset. */
export function ukJurisdictionRoleLabel(ukJurisdiction?: string | null): string {
  const label = ukJurisdiction ? ARTICLE_BY_JURISDICTION[ukJurisdiction] : undefined;
  if (label) return label;
  return `${ARTICLE_BY_JURISDICTION[DEFAULT_UK_JURISDICTION]} (assumed — no Jurisdiction set on this case)`;
}
