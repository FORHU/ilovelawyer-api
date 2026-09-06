import LawRepo from "../repositories/law.repository";
import { resolveUkCitation, UkResolvedCitation } from "./uk-legal-mcp";

export interface UkCitationResolutionResult {
  lawId: string;
  confidence: number;
}

const TNA_CASE_BASE = "https://caselaw.nationalarchives.gov.uk/";

/** The TNA judgment slug a resolved case citation's URL implies (e.g. "uksc/2022/34"), or null
 * for anything not on TNA (legislation.gov.uk, or no URL at all) — this is what decides whether
 * a resolved Law row can later be expanded via citations_network (UkCitationNetworkSvc.expand). */
export function extractCaseUri(jurisUrl: string | null | undefined): string | null {
  if (!jurisUrl || !jurisUrl.startsWith(TNA_CASE_BASE)) return null;
  const slug = jurisUrl.slice(TNA_CASE_BASE.length).replace(/^\/+|\/+$/g, "");
  return slug || null;
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

  const existing = await LawRepo.findByJurisSourceId(resolved.resolved_url);
  if (existing) return { lawId: existing.id, confidence: resolved.confidence };

  const tenantId = await LawRepo.resolveUkTenantId();
  const created = await LawRepo.create({
    jurisSourceId: resolved.resolved_url,
    category: "JURISPRUDENCE",
    tenantId,
    // A real title needs a separate case_law_search call — skipped for v1; the citation string
    // itself (e.g. "[2022] UKSC 34") is a normal, readable label to a lawyer in the meantime.
    title: resolved.raw,
    caseNumber: resolved.raw,
    year: resolved.year,
    jurisUrl: resolved.resolved_url,
    rawJson: resolved as unknown as object,
  });

  return { lawId: created.id, confidence: resolved.confidence };
}
