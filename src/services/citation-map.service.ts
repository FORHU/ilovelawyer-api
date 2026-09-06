import CaseAccess from "../utils/case-access";
import CitationCheckRepo from "../repositories/citation-check.repository";
import LawRepo from "../repositories/law.repository";
import { resolveCitationToLaw } from "../utils/citation-resolution";

// Loose guess at whether a free-text citedReference reads as a case number (vs. a case title) —
// used only to decide which field to lead the resolution search with; resolveCitationToLaw
// falls back to matching on the raw text either way.
const CASE_NUMBER_PATTERN = /\b(?:G\.?\s?R\.?|A\.?\s?C\.?|A\.?\s?M\.?|CA-G\.?\s?R\.?)\s*No\.?s?\.?\s*[\w.-]+/i;

/** Exported for reuse by CitationCheckSvc.check, which resolves a citation against the same PH
 * corpus at the moment it's entered, not just lazily when Citation Map is later opened. */
export function parseCitedReference(raw: string): { caseNumber?: string; title: string } {
  const match = raw.match(CASE_NUMBER_PATTERN);
  return { caseNumber: match?.[0]?.trim(), title: raw.trim() };
}

export interface CitationMapSeedItem {
  id: string;
  quotedText: string;
  citedReference: string | null;
  status: string;
  resolved: {
    lawId: string;
    title: string;
    caseNumber: string | null;
    jurisUrl: string;
    pdfUrl: string | null;
    citationsExtractedAt: string | null;
  } | null;
  confidence: number | null;
}

export default class CitationMapSvc {
  /**
   * Seed tier of the Citation Map: the case's own already-tracked citations (CitationCheck),
   * resolved lazily against the Law corpus and cached onto the row. Unresolved citations are
   * still returned — the frontend renders them as distinct "not found in database" nodes
   * rather than silently dropping them.
   */
  static async getSeed(caseId: string, userId: string): Promise<{ caseId: string; citations: CitationMapSeedItem[] }> {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const checks = await CitationCheckRepo.list(caseId);
    const withReference = checks.filter((c) => c.citedReference);

    const resolutions = await Promise.all(
      withReference.map(async (check) => {
        if (check.resolvedLawId) {
          return { check, lawId: check.resolvedLawId as string | null, confidence: check.resolutionConfidence };
        }
        const { caseNumber, title } = parseCitedReference(check.citedReference!);
        const resolved = await resolveCitationToLaw({ caseNumber, title });
        await CitationCheckRepo.markResolved(check.id, resolved?.lawId ?? null, resolved?.confidence ?? null);
        return { check, lawId: resolved?.lawId ?? null, confidence: resolved?.confidence ?? null };
      }),
    );

    const lawIds = resolutions.map((r) => r.lawId).filter((id): id is string => !!id);
    const laws = await LawRepo.findManyByIds(lawIds);
    const lawById = new Map(laws.map((law) => [law.id, law]));

    const citations: CitationMapSeedItem[] = resolutions.map(({ check, lawId, confidence }) => {
      const law = lawId ? lawById.get(lawId) : undefined;
      return {
        id: check.id,
        quotedText: check.quotedText,
        citedReference: check.citedReference,
        status: check.status,
        confidence,
        resolved: law
          ? {
              lawId: law.id,
              title: law.title,
              caseNumber: law.caseNumber,
              jurisUrl: law.jurisUrl,
              pdfUrl: law.pdfUrl,
              citationsExtractedAt: law.citationsExtractedAt?.toISOString() ?? null,
            }
          : null,
      };
    });

    return { caseId, citations };
  }
}
