import CaseAccess from "../utils/case-access";
import CitationCheckRepo from "../repositories/citation-check.repository";
import LawRepo from "../repositories/law.repository";
import { resolveUkCitationToLaw } from "../utils/uk-citation-resolution";
import { CitationMapSeedItem } from "./citation-map.service";

export default class UkCitationMapSvc {
  /**
   * Seed tier of the Citation Map for a UK case — same shape and caching rule as
   * CitationMapSvc.getSeed (PH), just resolving the case's own CitationCheck rows against the
   * UK Legal MCP instead of juris.ph. citations_resolve already parses whatever OSCOLA format
   * citedReference is in, so no PH-style case-number-guessing regex is needed here.
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
        const resolved = await resolveUkCitationToLaw(check.citedReference!);
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
