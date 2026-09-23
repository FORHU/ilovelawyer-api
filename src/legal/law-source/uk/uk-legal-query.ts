// UK-only query planning for UkLawSourceProvider's legislation search.
//
// uk-legal-mcp.fly.dev's legislation_search only matches close to the literal Act title, so a
// common short form ("HRA", "PACE", "DPA") returns nothing. This module resolves a recognised
// acronym to its full title before the query is sent, and tags it with a stable document
// reference (legislation type/year/number, e.g. ukpga/2010/15 — legislation.gov.uk's own URI
// scheme, see legislationUrlParts in uk-law-mappers.ts) so the caller can put the exact Act
// first even when an amending Act with a near-identical title otherwise outranks it (seen live
// for Equality Act 2010 and Mental Health Act 1983 — see the table below).
//
// Ported from chat-wonder-v2-api's uk_legal_query.py (FORHU/chat-wonder-v2-api#94, same
// verification) for FORHU/ilovelawyer-api#152. Kept as a separate copy — different
// language/runtime, and per the sibling PH tickets' decision not to share the table across
// repos. Must not be used for, or merged with, ph-legal-query.ts.

export interface DocRef {
  type: string;
  year: number;
  number: number;
}

interface UkAlias {
  title: string;
  ref: DocRef;
}

// Keys are normalized (see aliasKey). Every entry's `ref` was read from the live
// legislation_search record for that Act — add new ones the same way, not from memory.
const UK_LAW_ALIASES: Record<string, UkAlias> = {
  HRA: { title: "Human Rights Act 1998", ref: { type: "ukpga", year: 1998, number: 42 } },
  DPA: { title: "Data Protection Act 2018", ref: { type: "ukpga", year: 2018, number: 12 } },
  PACE: { title: "Police and Criminal Evidence Act 1984", ref: { type: "ukpga", year: 1984, number: 60 } },
  FOIA: { title: "Freedom of Information Act 2000", ref: { type: "ukpga", year: 2000, number: 36 } },
  TUPE: {
    title: "The Transfer of Undertakings (Protection of Employment) Regulations 2006",
    ref: { type: "uksi", year: 2006, number: 246 },
  },
  IHTA: { title: "Inheritance Tax Act 1984", ref: { type: "ukpga", year: 1984, number: 51 } },
  SGA: { title: "Sale of Goods Act 1979", ref: { type: "ukpga", year: 1979, number: 54 } },
  CRA: { title: "Consumer Rights Act 2015", ref: { type: "ukpga", year: 2015, number: 15 } },
  LPA: { title: "Law of Property Act 1925", ref: { type: "ukpga", year: 1925, number: 20 } },
  MHA: { title: "Mental Health Act 1983", ref: { type: "ukpga", year: 1983, number: 20 } },
  ERA: { title: "Employment Rights Act 1996", ref: { type: "ukpga", year: 1996, number: 18 } },
  EA: { title: "Equality Act 2010", ref: { type: "ukpga", year: 2010, number: 15 } },
  CDPA: { title: "Copyright, Designs and Patents Act 1988", ref: { type: "ukpga", year: 1988, number: 48 } },
  POCA: { title: "Proceeds of Crime Act 2002", ref: { type: "ukpga", year: 2002, number: 29 } },
  RIPA: { title: "Regulation of Investigatory Powers Act 2000", ref: { type: "ukpga", year: 2000, number: 23 } },
  CCA: { title: "Consumer Credit Act 1974", ref: { type: "ukpga", year: 1974, number: 39 } },
  LASPO: {
    title: "Legal Aid, Sentencing and Punishment of Offenders Act 2012",
    ref: { type: "ukpga", year: 2012, number: 10 },
  },
  FSMA: { title: "Financial Services and Markets Act 2000", ref: { type: "ukpga", year: 2000, number: 8 } },
  MCA: { title: "Mental Capacity Act 2005", ref: { type: "ukpga", year: 2005, number: 9 } },
  SOA: { title: "Sexual Offences Act 2003", ref: { type: "ukpga", year: 2003, number: 42 } },
};

/** "H.R.A.", "hra" -> "HRA". */
const aliasKey = (q: string): string => q.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type UkLegislationPlan =
  | { kind: "alias"; query: string; ref: DocRef }
  | { kind: "plain"; query: string };

/**
 * Recognises a whole-query acronym/short form ("HRA") and expands it to the Act's full title —
 * the format that actually ranks well upstream. Anything else, including an acronym inside a
 * longer query ("HRA damages claim"), passes through untouched, so ordinary searches are
 * unaffected.
 */
export function planUkLegislationQuery(rawQuery: string): UkLegislationPlan {
  const q = rawQuery.trim();
  const alias = q ? UK_LAW_ALIASES[aliasKey(q)] : undefined;
  if (alias) return { kind: "alias", query: alias.title, ref: alias.ref };
  return { kind: "plain", query: q };
}

/**
 * Moves the row matching `ref` (type/year/number) to the front, if present — the fix for an
 * amending Act (e.g. "Worker Protection (Amendment of Equality Act 2010) Act 2023") outranking
 * the Act the alias actually meant.
 */
export function preferExactRef<T extends { type: string; year: number | null; number: number | null }>(
  rows: T[],
  ref: DocRef,
): T[] {
  if (rows.length === 0) return rows;
  const isExact = (row: T) => row.type === ref.type && row.year === ref.year && row.number === ref.number;
  const exact = rows.filter(isExact);
  if (exact.length === 0) return rows;
  return [...exact, ...rows.filter((row) => !isExact(row))];
}

/**
 * Same idea as preferExactRef, for stored Law rows: legislationHitToCreateInput stores a bare
 * `raNumber` (String(hit.number), no prefix) and `year`, but not `type` — the Law schema has no
 * column for it. raNumber+year is not quite as precise as type+year+number (a different
 * legislation type could in principle share both), but a same-year collision is rare enough
 * that this is worth doing rather than skipping the local cache's own version of the same bug.
 */
export function preferExactLocalRef<T extends { raNumber: string | null; year: number | null }>(
  rows: T[],
  ref: DocRef,
): T[] {
  if (rows.length === 0) return rows;
  const isExact = (row: T) => row.raNumber === String(ref.number) && row.year === ref.year;
  const exact = rows.filter(isExact);
  if (exact.length === 0) return rows;
  return [...exact, ...rows.filter((row) => !isExact(row))];
}
