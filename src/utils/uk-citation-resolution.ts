import { Prisma } from "@prisma/client";
import LawRepo from "../repositories/law.repository";
import { UK_CASELAW_BASE_URL, UK_LEGISLATION_BASE_URL } from "../config";
import { legislationHitToCreateInput, legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { legislationSearch, resolveUkCitation, UkResolvedCitation } from "./uk-legal-mcp";

export interface UkCitationResolutionResult {
  lawId: string;
  confidence: number;
}

/** The TNA judgment slug a resolved case citation's URL implies (e.g. "uksc/2022/34"), or null
 * for anything not on TNA (legislation.gov.uk, or no URL at all) — this is what decides whether
 * a resolved Law row can later be expanded via citations_network (UkCitationNetworkSvc.expand).
 * Must strip the same base that uk-law-mappers.ts builds `Law.jurisUrl` with (UK_CASELAW_BASE_URL). */
export function extractCaseUri(jurisUrl: string | null | undefined): string | null {
  if (!jurisUrl || !jurisUrl.startsWith(UK_CASELAW_BASE_URL)) return null;
  const slug = jurisUrl.slice(UK_CASELAW_BASE_URL.length).replace(/^\/+|\/+$/g, "");
  return slug || null;
}

/** A resolved legislation citation's URL is pinpoint-specific (e.g. ".../1967/87/section/1"),
 * but `Law.jurisSourceId` for that Act is always the bare Act URL (".../1967/87") — the shape
 * `legislationHitToCreateInput` (uk-law-mappers.ts) writes it in from `legislation_search`.
 * Strips any pinpoint/section suffix so a lookup or a newly-materialized row keys on the same
 * canonical Act URL regardless of which section was actually cited. Returns the input unchanged
 * if it isn't a legislation.gov.uk-shaped URL at all. */
export function normalizeUkLegislationUrl(url: string): string {
  const parts = legislationUrlParts(url);
  if (!parts) return url;
  return `${UK_LEGISLATION_BASE_URL}/${parts.type}/${parts.year}/${parts.number}`;
}

/** A `citations_resolve` hit is legislation-shaped (Act/SI, as opposed to a case) iff the MCP
 * populated any of its legislation-only fields — mirrors how `UkResolvedCitation` distinguishes
 * the two on the wire (there's no single `type` value documented as stable enough to switch on). */
export function isLegislationResolution(resolved: UkResolvedCitation): boolean {
  return resolved.legislation_title != null || resolved.section != null || resolved.si_number != null;
}

/** `citations_resolve` can recognize a citation's grammar but fail to pin down the exact
 * document, and falls back to a generic search-results URL instead of a real one — observed in
 * practice: "s.1 Abortion Act 1967" resolves at confidence 0.95 to
 * "https://www.legislation.gov.uk/search?title=Abortion+Act+1967", not a document at all. A
 * `resolved_url` only counts as a real document when it actually parses as one: a
 * `/type/year/number` legislation URL, or a TNA case slug under UK_CASELAW_BASE_URL. */
export function isRealDocumentUrl(resolved: UkResolvedCitation): boolean {
  if (!resolved.resolved_url) return false;
  return isLegislationResolution(resolved)
    ? legislationUrlParts(resolved.resolved_url) !== null
    : extractCaseUri(resolved.resolved_url) !== null;
}

/**
 * Resolves a free-text UK citation (OSCOLA-style — neutral citation, law report, legislation
 * section, SI, retained EU law) against the UK Legal MCP, materializing a Law row only when a
 * real URL exists. This is the one rule that decides resolved-vs-unresolved: it already covers
 * both "not a real/findable citation" (a neutral citation the MCP verified against The National
 * Archives and got a 0-confidence miss — resolved_url is null then too) and "a real but
 * unlinkable citation" (a pre-2001 law report TNA doesn't cover) — no separate confidence
 * threshold needed on top of it.
 */
export async function resolveUkCitationToLaw(citation: string): Promise<UkCitationResolutionResult | null> {
  let resolved: UkResolvedCitation;
  try {
    resolved = await resolveUkCitation(citation);
  } catch {
    return null;
  }

  if (!resolved.resolved_url) return null;

  if (!isRealDocumentUrl(resolved)) return null;

  const isLegislation = isLegislationResolution(resolved);
  const jurisSourceId = isLegislation ? normalizeUkLegislationUrl(resolved.resolved_url) : resolved.resolved_url;

  const existing = await LawRepo.findByJurisSourceId(jurisSourceId);
  if (existing) return { lawId: existing.id, confidence: resolved.confidence };

  const tenantId = await LawRepo.resolveUkTenantId();
  const created = await LawRepo.create({
    jurisSourceId,
    category: isLegislation ? "REPUBLIC_ACT" : "JURISPRUDENCE",
    tenantId,
    // A real title needs a separate case_law_search/legislation_search call — skipped for v1;
    // the citation string itself (e.g. "[2022] UKSC 34") is a normal, readable label to a
    // lawyer in the meantime.
    title: resolved.raw,
    caseNumber: isLegislation ? null : resolved.raw,
    raNumber: isLegislation ? resolved.raw : null,
    year: resolved.year,
    jurisUrl: jurisSourceId,
    rawJson: resolved as unknown as object,
  });

  return { lawId: created.id, confidence: resolved.confidence };
}

// citations_resolve's grammar is fixed-order ("s.N Act YYYY") and rejects the reverse — the
// natural order the AI actually cites in ("Act Title YYYY, s N", confirmed live against the
// UK Legal MCP: "Protection from Eviction Act 1977, s 3" is refused outright, and even
// "s.1 Abortion Act 1967" — the grammar it does accept — only resolves to a generic
// /search?title= page, not a real document. legislation_search, by contrast, is a plain title
// search and handles the AI's natural phrasing well, but only once any pinpoint is stripped off
// (a query with ", s 3" still attached returns zero results, confirmed live) — hence this
// extracts just the Act/SI title before searching, rather than reusing resolveUkCitationToLaw
// for legislation at all.
const TITLE_MATCH_CONFIDENCE = 0.9;

/** Strips a trailing pinpoint (", s 3", ", Sch 2", ...) off a natural-language UK legislation
 * citation label, leaving just the Act/SI title — which always ends in its enactment year, so
 * that's the reliable cut point. "Protection from Eviction Act 1977, s 3" -> "Protection from
 * Eviction Act 1977"; a label with no trailing pinpoint (nothing after the year) is returned
 * unchanged. Doesn't handle a title that itself embeds an earlier year before its own enactment
 * year (rare) — a documented heuristic, not a full citation parser. */
export function extractActTitle(label: string): string {
  const match = label.match(/^(.*?\b\d{4})\b/);
  return match ? match[1] : label;
}

/**
 * Resolves a UK legislation citation LABEL (not its URL — see the fast-path URL lookup in
 * legal-citation-link-rewrite.ts for that) to a Library Law row via a plain title search
 * (legislation_search), reusing the exact same write-through shape
 * (legislationHitToCreateInput) the Library's own manual search uses — so a row materialized
 * from a chat citation is indistinguishable from one a user found by searching directly.
 * Requires either an exact (case-insensitive) title match or a single unambiguous search hit;
 * anything else is treated as unresolved rather than guessed at.
 */
export async function resolveUkLegislationTitleToLaw(label: string): Promise<UkCitationResolutionResult | null> {
  const actTitle = extractActTitle(label).trim();
  if (!actTitle) return null;

  let result: Awaited<ReturnType<typeof legislationSearch>>;
  try {
    result = await legislationSearch({ query: actTitle, limit: 5 });
  } catch {
    return null;
  }

  const hit =
    result.results.find((r) => r.title.trim().toLowerCase() === actTitle.toLowerCase()) ??
    (result.results.length === 1 ? result.results[0] : null);
  if (!hit) return null;

  const existing = await LawRepo.findByJurisSourceId(hit.url);
  if (existing) return { lawId: existing.id, confidence: TITLE_MATCH_CONFIDENCE };

  const tenantId = await LawRepo.resolveUkTenantId();
  const created = await LawRepo.create(
    legislationHitToCreateInput(hit, tenantId) as Prisma.LawUncheckedCreateInput,
  );
  return { lawId: created.id, confidence: TITLE_MATCH_CONFIDENCE };
}
