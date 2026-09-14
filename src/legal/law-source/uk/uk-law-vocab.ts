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
 * Court slugs accepted on `/api/law/browse?court=` for UK case law. Each is verified to be a
 * valid `court=` filter on TNA's Find Case Law atom feed (`atom.xml?court=<slug>` -> 200).
 * NOTE: Northern Ireland courts (`nica`, `niqb`, `nifc`, `nist`) are deliberately absent — TNA's
 * atom feed rejects them with HTTP 400 "not one of the available choices", even though the UK
 * Legal MCP's own inputSchema lists them. NI judgments are still reachable by free-text search,
 * just not by this court facet. See docs/adr/0005-uk-library-source.md.
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
  "ewhc/scco",
  "ewhc/admlty",
  "ewcop",
  "ewfc",
  "eat",
  "ukut/iac",
  "ukut/aac",
  "ukut/tcc",
  "ukut/lc",
  "ukftt/tc",
  "ukftt/grc",
  "ukist",
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
