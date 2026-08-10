export interface LibrarySectionItem {
  key: string;
  /**
   * "browse" — filters the documents list by category/subcategory (real, countable data).
   * "analyze" — fires the existing AI keyword-lookup (same mechanism as the hero's
   * Quick Access buttons) with `query`, since these are single canonical statutes
   * (e.g. Civil Code = RA 386) rather than a browsable collection of documents.
   */
  mode: "browse" | "analyze";
  category: string | null;
  subcategory?: string;
  /**
   * When true, filters to rows with subcategory IS NULL exactly — required whenever this
   * item must NOT overlap with a sibling item that filters on a specific subcategory value
   * under the same category (e.g. supremeCourtDecisions vs. courtOfTaxAppeals, both under
   * category='jurisprudence'). Without this, omitting `subcategory` means "any subcategory,"
   * which silently includes tagged subsets and produces overlapping/duplicated counts.
   */
  noSubcategory?: boolean;
  query?: string;
}

export interface LibrarySection {
  key: string;
  items: LibrarySectionItem[];
}

/**
 * Maps the real, verified `documents.category`/`subcategory` taxonomy (confirmed
 * against the forhu-staging-chat-wonder-v2-api-legal-postgres DB) to the 3 library
 * homepage cards.
 *
 * Verified taxonomy (2026-07-30):
 * - category='law' (42,389 rows): individual standalone statutes (RAs, PDs, Acts,
 *   LOIs), each identified only by its own act/law number — NOT subdivided by named
 *   code (no "Civil Code"/"Family Code" subcategory exists). 42,282 have no
 *   subcategory at all.
 * - category='jurisprudence' (17,194 rows): 13,005 with no subcategory (general SC
 *   decisions, not split by En Banc/Division), 4,189 tagged 'court_of_tax_appeals'.
 * - category='issuance' (20,870 rows): real breakdown by issuing agency —
 *   bureau_of_internal_revenue (10,289), department_of_the_interior_and_local_government
 *   (5,011), bureau_of_customs (4,969), department_of_labor_and_employment (370),
 *   department_of_justice (86), plus a few near-zero agencies omitted here
 *   (employees_compensation_commission, bureau_of_corrections, department_of_energy,
 *   civil_service_commission — 1-2 rows each).
 *
 * item.key must match the existing i18n key names in locales/{en,tl,ko}/library.json
 * under `categories.<section.key>.<item.key>` so the frontend can look up display
 * labels without any locale-file changes (aside from the jurisprudence/issuance key
 * renames documented in docs/library-sections.md).
 */
export const LIBRARY_SECTIONS: LibrarySection[] = [
  {
    key: "codals",
    items: [
      { key: "civilCode", mode: "analyze", category: null, query: "Civil Code" },
      { key: "constitution1987", mode: "analyze", category: null, query: "1987 Constitution" },
      { key: "revisedPenalCode", mode: "analyze", category: null, query: "Revised Penal Code" },
      { key: "laborCode", mode: "analyze", category: null, query: "Labor Code" },
      { key: "familyCode", mode: "analyze", category: null, query: "Family Code" },
    ],
  },
  {
    key: "jurisprudence",
    items: [
      { key: "supremeCourtDecisions", mode: "browse", category: "jurisprudence", noSubcategory: true },
      { key: "courtOfTaxAppeals", mode: "browse", category: "jurisprudence", subcategory: "court_of_tax_appeals" },
      { key: "indexedDecisions", mode: "browse", category: null },
    ],
  },
  {
    key: "issuance",
    items: [
      { key: "bureauOfInternalRevenue", mode: "browse", category: "issuance", subcategory: "bureau_of_internal_revenue" },
      {
        key: "departmentOfTheInteriorAndLocalGovernment",
        mode: "browse",
        category: "issuance",
        subcategory: "department_of_the_interior_and_local_government",
      },
      { key: "bureauOfCustoms", mode: "browse", category: "issuance", subcategory: "bureau_of_customs" },
      {
        key: "departmentOfLaborAndEmployment",
        mode: "browse",
        category: "issuance",
        subcategory: "department_of_labor_and_employment",
      },
      { key: "departmentOfJustice", mode: "browse", category: "issuance", subcategory: "department_of_justice" },
    ],
  },
];
