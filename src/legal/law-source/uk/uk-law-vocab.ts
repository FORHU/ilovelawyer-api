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

/** legislation.gov.uk's codes for EU legislation retained after Brexit: regulations, decisions,
 * directives and treaties. Their provisions are articles (`…/eur/2016/679/article/6`), not sections. */
export const UK_EU_LEGISLATION_TYPES = ["eur", "eudn", "eudr", "eut"] as const;

/**
 * legislation.gov.uk type codes — every document type it publishes, since legislation_search can
 * return any of them (a "taxation" search brings back Acts of the English Parliament from 1697).
 * Used to parse a stored legislation URL back into `{ type, year, number }`; a code missing here
 * makes the row's URL unparseable and the Library viewer answers "No PDF available".
 */
export const UK_LEGISLATION_TYPES = [
  // UK Parliament: public general, local and private/personal Acts; Church Measures
  "ukpga",
  "ukla",
  "ukppa",
  "ukcm",
  // Scotland, Wales, Northern Ireland: Acts and Measures
  "asp",
  "asc",
  "anaw",
  "mwa",
  "nia",
  "apni",
  "mnia",
  // Historical: English Parliament (to 1707), Old Scottish and Irish Parliaments, Great Britain
  "aep",
  "aosp",
  "aip",
  "apgb",
  "gbla",
  "gbppa",
  // Secondary legislation: SIs, rules and orders, instruments, directions
  "uksi",
  "ssi",
  "wsi",
  "nisr",
  "nisi",
  "nisro",
  "uksro",
  "ukci",
  "ukmd",
  "ukmo",
  // Draft SIs (numbered by ISBN)
  "ukdsi",
  "sdsi",
  "wdsi",
  "nidsr",
  // Retained EU law (the UK GDPR is eur/2016/679)
  ...UK_EU_LEGISLATION_TYPES,
] as const;
export type UkLegislationType = (typeof UK_LEGISLATION_TYPES)[number];
