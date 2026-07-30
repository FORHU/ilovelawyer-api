export interface LibrarySectionItem {
  key: string;
  category: string | null;
  subcategory?: string;
}

export interface LibrarySection {
  key: string;
  items: LibrarySectionItem[];
}

/**
 * Maps documents.category/subcategory values (free-form strings, no DB enum)
 * to the 3 library homepage cards. Values below are placeholders taken from
 * the previously-hardcoded frontend labels and must be confirmed against the
 * real `documents` table (e.g. via `LegalRagRepo.getCategories()` /
 * `getSubcategories()`) once a populated environment is reachable.
 */
// item.key must match the existing i18n key names in locales/{en,tl,ko}/library.json
// under `categories.<section.key>.<item.key>` so the frontend can look up display
// labels without any locale-file changes.
export const LIBRARY_SECTIONS: LibrarySection[] = [
  {
    key: "codals",
    items: [
      { key: "civilCode", category: "Civil Code" },
      { key: "constitution1987", category: "1987 Constitution" },
      { key: "revisedPenalCode", category: "Revised Penal Code" },
      { key: "laborCode", category: "Labor Code" },
      { key: "familyCode", category: "Family Code" },
    ],
  },
  {
    key: "jurisprudence",
    items: [
      { key: "enBancDecisions", category: "SCRA", subcategory: "En Banc" },
      { key: "divisionDecisions", category: "SCRA", subcategory: "Division" },
      { key: "lowerCourtRulings", category: "Persuasive Rulings" },
      { key: "indexedDecisions", category: null },
    ],
  },
  {
    key: "issuance",
    items: [
      { key: "presidentialIssuances", category: "Presidential Issuance" },
      { key: "administrativeAgencyIssuances", category: "Administrative Issuance" },
      { key: "judicialIssuances", category: "Judicial Issuance" },
    ],
  },
];
