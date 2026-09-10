import { LawCategory } from "@prisma/client";

/**
 * UK Library wire vocab. `uk-case-law` -> `JURISPRUDENCE`, `uk-legislation` -> `REPUBLIC_ACT`
 * (the `LawCategory` enum is reused, not extended — see docs/adr/0005-uk-library-source.md).
 */
export const UK_CATEGORY_WIRE_VALUES = ["uk-case-law", "uk-legislation"] as const;
export type UkCategoryWire = (typeof UK_CATEGORY_WIRE_VALUES)[number];

export const UK_CATEGORY_BY_WIRE: Record<UkCategoryWire, LawCategory> = {
  "uk-case-law": "JURISPRUDENCE",
  "uk-legislation": "REPUBLIC_ACT",
};

export const UK_WIRE_BY_CATEGORY: Record<LawCategory, UkCategoryWire> = {
  JURISPRUDENCE: "uk-case-law",
  REPUBLIC_ACT: "uk-legislation",
};

/**
 * Court slugs accepted on `/api/law/browse?court=` for UK case law — the subset of the UK Legal
 * MCP's `case_law_search` court vocab that Find Case Law's Atom feed also filters on. Extensible.
 */
export const UK_COURTS = [
  "uksc",
  "ukpc",
  "ewca/civ",
  "ewca/crim",
  "ewhc/admin",
  "ewhc/kb",
  "ewhc/ch",
  "ewhc/comm",
  "ewhc/fam",
  "ewhc/tcc",
  "ewhc/ipec",
  "ewhc/pat",
  "ewcop",
  "ewfc",
  "eat",
  "ukut/iac",
  "ukut/aac",
  "ukut/tcc",
  "ukut/lc",
  "ukftt/tc",
  "ukftt/grc",
  "nica",
  "niqb",
] as const;
export type UkCourt = (typeof UK_COURTS)[number];

/**
 * legislation.gov.uk type codes. Used for the `legislation_search` `type` filter and to parse a
 * legislation URL back into `{ type, year, number }` for `legislation_get_toc` / `_get_section`.
 */
export const UK_LEGISLATION_TYPES = [
  "ukpga",
  "ukla",
  "uksi",
  "asp",
  "ssi",
  "asc",
  "anaw",
  "wsi",
  "mwa",
  "nia",
  "nisr",
  "apni",
  "ukcm",
  "ukmd",
] as const;
export type UkLegislationType = (typeof UK_LEGISLATION_TYPES)[number];
