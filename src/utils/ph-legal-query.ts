import { LawCategory } from "@prisma/client";

// PH-only query planning for LawSvc.search. juris.ph does keyword-ish semantic matching, so
// acronyms ("VAWC") return nothing and the *format* of a number ("RA 9262" vs "R.A. No. 9262"
// vs "9262") changes whether the right document ranks at all. This module turns what the user
// typed into the set of queries worth running. No DB or network here — see law.service.ts.
// UK has its own path (UkLawSourceProvider) and must not share this table.

interface PhAlias {
  /** Republic Act number the acronym stands for. */
  ra: string;
  /** Conventional title — used as an extra query, since number-only queries miss some acts. */
  title: string;
}

/** Keys are normalized (see aliasKey). Every entry was checked against the juris.ph record for
 * that RA number; add new ones the same way rather than from memory. */
const PH_LAW_ALIASES: Record<string, PhAlias> = {
  VAWC: { ra: "9262", title: "Anti-Violence Against Women and Their Children Act of 2004" },
  IPRA: { ra: "8371", title: "Indigenous Peoples Rights Act of 1997" },
  EPIRA: { ra: "9136", title: "Electric Power Industry Reform Act of 2001" },
  AMLA: { ra: "9160", title: "Anti-Money Laundering Act of 2001" },
  ADR: { ra: "9285", title: "Alternative Dispute Resolution Act of 2004" },
  ARTA: { ra: "11032", title: "Ease of Doing Business and Efficient Government Service Delivery Act of 2018" },
  EODB: { ra: "11032", title: "Ease of Doing Business and Efficient Government Service Delivery Act of 2018" },
  DPA: { ra: "10173", title: "Data Privacy Act of 2012" },
  CARL: { ra: "6657", title: "Comprehensive Agrarian Reform Law of 1988" },
  CARP: { ra: "6657", title: "Comprehensive Agrarian Reform Law of 1988" },
  CARPER: { ra: "9700", title: "Comprehensive Agrarian Reform Program Extension with Reforms" },
  JJWA: { ra: "9344", title: "Juvenile Justice and Welfare Act of 2006" },
  ATA: { ra: "11479", title: "Anti-Terrorism Act of 2020" },
  HSA: { ra: "9372", title: "Human Security Act of 2007" },
  CPA: { ra: "10175", title: "Cybercrime Prevention Act of 2012" },
  SSA: { ra: "11313", title: "Safe Spaces Act" },
  TRAIN: { ra: "10963", title: "Tax Reform for Acceleration and Inclusion" },
  CREATE: { ra: "11534", title: "Corporate Recovery and Tax Incentives for Enterprises Act" },
  CDDA: { ra: "9165", title: "Comprehensive Dangerous Drugs Act of 2002" },
  ATIP: { ra: "9208", title: "Anti-Trafficking in Persons Act of 2003" },
  OSAEC: { ra: "11930", title: "Anti-Online Sexual Abuse or Exploitation of Children" },
  MCW: { ra: "9710", title: "Magna Carta of Women" },
  LGC: { ra: "7160", title: "Local Government Code of 1991" },
  RCC: { ra: "11232", title: "Revised Corporation Code of the Philippines" },
  SRC: { ra: "8799", title: "Securities Regulation Code" },
  GPRA: { ra: "9184", title: "Government Procurement Reform Act" },
  PCA: { ra: "10667", title: "Philippine Competition Act" },
  IPC: { ra: "8293", title: "Intellectual Property Code of the Philippines" },
  CMTA: { ra: "10863", title: "Customs Modernization and Tariff Act" },
  ESWMA: { ra: "9003", title: "Ecological Solid Waste Management Act of 2000" },
  UHC: { ra: "11223", title: "Universal Health Care Act" },
  RH: { ra: "10354", title: "Responsible Parenthood and Reproductive Health Act of 2012" },
  RHLAW: { ra: "10354", title: "Responsible Parenthood and Reproductive Health Act of 2012" },
  RTL: { ra: "11203", title: "Rice Tariffication Law" },
  AFASA: { ra: "12010", title: "Anti-Financial Account Scamming Act" },
  CCESPO: { ra: "6713", title: "Code of Conduct and Ethical Standards for Public Officials and Employees" },
  RESA: { ra: "9646", title: "Real Estate Service Act of 2009" },
  FIA: { ra: "7042", title: "Foreign Investments Act of 1991" },
  BOT: { ra: "6957", title: "Build-Operate-Transfer Law" },
  SEZ: { ra: "7916", title: "Special Economic Zone Act of 1995" },
};

/** "V.A.W.C.", "vawc", "RH Law" -> "VAWC", "RHLAW". */
const aliasKey = (q: string): string => q.toUpperCase().replace(/[^A-Z0-9]/g, "");

// "RA 9262", "R.A. No. 9262", "Republic Act #9262", "Rep. Act No.9262", "RA9262"
const RA_NUMBER_RE = /^(?:r\.?\s*a\.?|rep(?:ublic)?\.?\s*act)\s*(?:nos?\.?|number|#)?\s*(\d{1,6})$/i;
// "G.R. No. 203335", "GR# 203335", "G. R. No. L-12345"
const GR_NUMBER_RE = /^g\.?\s*r\.?\s*(?:nos?\.?|number|#)?\s*(l-)?\s*(\d{1,7})$/i;
// A bare number, optionally "No. 9262" / "#9262" — 3+ digits so "5" isn't treated as a law.
const BARE_NUMBER_RE = /^(?:nos?\.?\s*|#\s*)?(\d{3,7})$/i;

// Issuances juris.ph doesn't index (its datasets are jurisprudence + republic-acts only).
const UNINDEXED_RE =
  /^(e\.?\s*o\.?|executive\s+order|p\.?\s*d\.?|presidential\s+decree|a\.?\s*o\.?|administrative\s+order|m\.?\s*o\.?|memorandum\s+order|m\.?\s*c\.?|memorandum\s+circular|b\.?\s*p\.?(?:\s*blg\.?)?|batas\s+pambansa(?:\s*blg\.?)?|c\.?\s*a\.?|commonwealth\s+act|act)\s*(?:nos?\.?|number|#)?\s*(\d{1,5}(?:-[a-z])?)$/i;

function unindexedLabel(type: string, num: string): string {
  const t = type.toLowerCase().replace(/[.\s]/g, "");
  const name =
    t === "eo" || t === "executiveorder" ? "Executive Order No."
    : t === "pd" || t === "presidentialdecree" ? "Presidential Decree No."
    : t === "ao" || t === "administrativeorder" ? "Administrative Order No."
    : t === "mo" || t === "memorandumorder" ? "Memorandum Order No."
    : t === "mc" || t === "memorandumcircular" ? "Memorandum Circular No."
    : t.startsWith("bp") || t.startsWith("batas") ? "Batas Pambansa Blg."
    : t === "ca" || t === "commonwealthact" ? "Commonwealth Act No."
    : "Act No.";
  return `${name} ${num.toUpperCase()}`;
}

export type PhSearchPlan =
  | {
      kind: "unindexed";
      /** e.g. "Presidential Decree No. 442" */
      label: string;
    }
  | {
      kind: "search";
      /** Terms ILIKE'd against the stored text columns (unused when `number` is set). */
      localTerms: string[];
      /** A direct lookup by document number: match stored rows on this column's digits. */
      number?: { field: "raNumber" | "caseNumber"; digits: string };
      /** Queries to send to juris.ph in parallel. A plain query yields exactly one. */
      remoteQueries: string[];
    };

const unique = (xs: string[]): string[] => [...new Set(xs)];
const raVariants = (n: string): string[] => [`Republic Act No. ${n}`, `R.A. No. ${n}`, `RA ${n}`];

/**
 * Decides what to run for a typed query. Anything not recognised is returned untouched (one
 * local term, one remote query), so existing behaviour is unchanged for ordinary searches.
 * Recognition is whole-query on purpose: "vawc" expands, "vawc cases in Cebu" does not.
 */
export function planPhSearch(category: LawCategory, rawQuery: string): PhSearchPlan {
  const q = rawQuery.trim();
  const plain: PhSearchPlan = { kind: "search", localTerms: [q], remoteQueries: [q] };

  const issuance = q.match(UNINDEXED_RE);
  if (issuance) return { kind: "unindexed", label: unindexedLabel(issuance[1], issuance[2]) };

  // RA number / acronym, or the number typed bare, in the Republic Acts library.
  const raNumber = q.match(RA_NUMBER_RE)?.[1] ?? (category === "REPUBLIC_ACT" ? q.match(BARE_NUMBER_RE)?.[1] : undefined);
  const alias = PH_LAW_ALIASES[aliasKey(q)];

  if (category === "REPUBLIC_ACT") {
    if (raNumber) {
      return {
        kind: "search",
        localTerms: [],
        number: { field: "raNumber", digits: raNumber },
        remoteQueries: raVariants(raNumber),
      };
    }
    if (alias) {
      return {
        kind: "search",
        localTerms: [],
        number: { field: "raNumber", digits: alias.ra },
        // The acronym itself is left out: on juris.ph it returns nothing or unrelated acts.
        remoteQueries: unique([...raVariants(alias.ra), alias.title]),
      };
    }
    return plain;
  }

  // Jurisprudence: a G.R. number is a direct lookup; an RA number or acronym finds the cases
  // that cite the act (there's no RA row to match, so this stays a text search).
  const gr = q.match(GR_NUMBER_RE);
  const bare = q.match(BARE_NUMBER_RE)?.[1];
  if (gr || bare) {
    const digits = gr ? gr[2] : bare!;
    const prefix = gr?.[1] ? "L-" : "";
    return {
      kind: "search",
      localTerms: [],
      number: { field: "caseNumber", digits },
      remoteQueries: unique([`G.R. No. ${prefix}${digits}`, `${prefix}${digits}`]),
    };
  }

  const citedRa = raNumber ?? alias?.ra;
  if (citedRa) {
    const terms = [`Republic Act No. ${citedRa}`, `R.A. No. ${citedRa}`, ...(alias ? [alias.title] : [])];
    return {
      kind: "search",
      localTerms: unique([q, ...terms]),
      remoteQueries: unique([q, ...terms.slice(0, 2), ...(alias ? [alias.title] : [])]),
    };
  }
  return plain;
}

/** The document number inside a stored/returned reference — "G.R. No. 203335", "RA 9262",
 * "No. 8371" and "9262" all compare on their first run of digits. First run only, so an
 * amending act's "R.A. No. 9208 (as amended by R.A. No. 10364)" still reads as 9208. */
export const documentNumber = (v: string | null | undefined): string => (v ?? "").match(/\d+/)?.[0] ?? "";
