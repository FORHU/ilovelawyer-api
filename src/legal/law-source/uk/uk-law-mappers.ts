import { LawCategory, Prisma } from "@prisma/client";
import type {
  UkCaseLawSearchHit,
  UkLegislationSearchHit,
  UkCitationsNetworkResult,
  UkJudgmentIndexResult,
  UkLegislationTocResult,
  UkLegislationSectionResult,
} from "../../../utils/uk-legal-mcp";
import { UK_CASELAW_BASE_URL, UK_LEGISLATION_BASE_URL } from "../../../config";
import { UK_LEGISLATION_TYPES } from "./uk-law-vocab";

const asJson = (v: unknown[]): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  v.length > 0 ? (v as Prisma.InputJsonValue) : Prisma.JsonNull;

/** "uksc/2024/12" -> "UKSC"; "ewca/civ/2023/450" -> "EWCA (Civ)". Everything before the first
 * 4-digit year segment is the court; the rest is year/number. */
export function courtCodeFromSlug(slug: string): string | null {
  const parts = slug.split("/").filter(Boolean);
  const yearIdx = parts.findIndex((p) => /^\d{4}$/.test(p));
  const courtParts = yearIdx > 0 ? parts.slice(0, yearIdx) : parts.slice(0, 1);
  if (courtParts.length === 0) return null;
  const [head, ...rest] = courtParts;
  return rest.length > 0
    ? `${head.toUpperCase()} (${rest.map((r) => r[0].toUpperCase() + r.slice(1)).join(" ")})`
    : head.toUpperCase();
}

function yearFromSlug(slug: string): number | null {
  const m = slug.match(/\/(\d{4})\//);
  return m ? Number(m[1]) : null;
}

function neutralCitation(hit: UkCaseLawSearchHit): string | null {
  const ncn = hit.identifiers.find((i) => i.type === "ukncn");
  return ncn?.value ?? null;
}

/** canonical legislation URL -> { type, year, number }, or null if it doesn't parse. Accepts
 * any host (the `${UK_LEGISLATION_BASE_URL}` prefix is stripped first, then a bare
 * `<type>/<year>/<number>` path is matched) so a stored URL still parses if the base changes. */
export function legislationUrlParts(
  url: string,
): { type: string; year: number; number: number } | null {
  const path = url.startsWith(UK_LEGISLATION_BASE_URL)
    ? url.slice(UK_LEGISLATION_BASE_URL.length)
    : url;
  const m = path.match(/\/?([a-z]+)\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!(UK_LEGISLATION_TYPES as readonly string[]).includes(type)) return null;
  return { type, year: Number(m[2]), number: Number(m[3]) };
}

// ── search / browse write-through ───────────────────────────────────────────

export function caseLawHitToCreateInput(
  hit: UkCaseLawSearchHit,
  tenantId: string,
): Prisma.LawCreateManyInput {
  const jurisUrl = `${UK_CASELAW_BASE_URL}/${hit.uri.replace(/^\/+/, "")}`;
  return {
    jurisSourceId: jurisUrl,
    category: "JURISPRUDENCE",
    tenantId,
    title: hit.title || "(untitled)",
    year: yearFromSlug(hit.uri),
    tags: [],
    caseNumber: neutralCitation(hit),
    division: courtCodeFromSlug(hit.uri),
    decisionDate: hit.published ? new Date(hit.published) : null,
    jurisUrl,
    sourceUrl: jurisUrl,
    // Only the MCP-supplied assets URL (assets.caselaw.nationalarchives.gov.uk) is embeddable;
    // the `${jurisUrl}/data.pdf` path on the TNA site sends X-Frame-Options: DENY, so there is
    // no fallback — a row with no assets PDF just renders without the embedded viewer.
    pdfUrl: hit.pdf_url ?? null,
    rawJson: hit as unknown as Prisma.InputJsonValue,
  };
}

export function legislationHitToCreateInput(
  hit: UkLegislationSearchHit,
  tenantId: string,
): Prisma.LawCreateManyInput {
  return {
    jurisSourceId: hit.url,
    category: "REPUBLIC_ACT",
    tenantId,
    title: hit.title || "(untitled)",
    year: hit.year,
    tags: [],
    raNumber: hit.number != null ? String(hit.number) : null,
    score: hit.score,
    jurisUrl: hit.url,
    sourceUrl: hit.url,
    // legislation.gov.uk is behind an AWS WAF JS challenge and sends X-Frame-Options: DENY, so
    // a `.../data.pdf` link can't be embedded (it just renders blank). No pdfUrl — the detail
    // page shows the TOC + "View source" link instead.
    pdfUrl: null,
    rawJson: hit as unknown as Prisma.InputJsonValue,
  };
}

// ── lazy detail write-through ───────────────────────────────────────────────

/** Lower-cases, collapses whitespace, strips leading zeros in number tokens — so
 * "[2026] UKFTT 01281 (GRC)" and "[2026] UKFTT 1281 (GRC)" (a citations_network quirk) match. */
const normalizeCitation = (c: string): string =>
  c.toLowerCase().replace(/\s+/g, " ").replace(/\b0+(\d)/g, "$1").trim();

/** Dedupe near-identical citations and drop the judgment's own citation (which
 * citations_network echoes back, often in more than one form). */
function cleanCitations(raw: string[], selfCitation: string | null): string[] {
  const self = selfCitation ? normalizeCitation(selfCitation) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    const key = normalizeCitation(c);
    if (!key || key === self || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function caseLawDetailInput(
  index: UkJudgmentIndexResult | null,
  network: UkCitationsNetworkResult | null,
  selfCitation: string | null,
): Prisma.LawUpdateInput {
  const sections = (index?.paragraphs ?? []).map((p) => ({ title: p.eId, summary: p.preview }));
  const legislation = cleanCitations(
    [...(network?.legislation_refs ?? []), ...(network?.si_refs ?? [])],
    null,
  );
  const cases = cleanCitations(
    [...(network?.neutral_citations ?? []), ...(network?.law_report_refs ?? [])],
    selfCitation,
  );
  return {
    detailFetchedAt: new Date(),
    keywords: [],
    sections: asJson(sections),
    legalRulesCited: legislation,
    relatedCasesCited: cases,
    citedGrNumbers: cleanCitations(network?.neutral_citations ?? [], selfCitation),
    citedRaNumbers: legislation,
  };
}

export function legislationDetailInput(
  toc: UkLegislationTocResult | null,
  sections: UkLegislationSectionResult[],
): Prisma.LawUpdateInput {
  const tocSections = (toc?.items ?? []).map((raw) => {
    const idx = raw.indexOf(": ");
    return idx >= 0 ? { title: raw.slice(idx + 2), summary: raw.slice(0, idx) } : { title: raw };
  });
  const keyProvisions = sections
    .filter((s) => s.content?.trim())
    .map((s) => (s.title ? `${s.title}: ${s.content}` : s.content));
  return {
    detailFetchedAt: new Date(),
    keywords: [],
    sections: asJson(tocSections),
    keyProvisions,
    // Heal rows written before pdfUrl was dropped for legislation (not embeddable — see above).
    pdfUrl: null,
  };
}
