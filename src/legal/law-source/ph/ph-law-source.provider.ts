import { LawCategory } from "@prisma/client";
import LawSvc, { parseLawCategory } from "../../../services/law.service";
import {
  JURIS_PH_CASE_TYPES,
  JURIS_PH_TOPICS,
  JurisPhCaseType,
  JurisPhTopic,
} from "../../../utils/juris-ph";
import { LawFacets, LawSourceProvider } from "../law-source-provider";

/**
 * Thin adapter over the existing PH-only `LawSvc` (juris.ph write-through cache) — no new logic,
 * same pattern as `PHLegalKnowledgeProvider` over `LegalRagSvc`. `LawSvc` and the ADMIN
 * `/api/admin/law/*` routes keep calling it directly, unchanged.
 */
export class PhLawSourceProvider implements LawSourceProvider {
  readonly tenantCode = "PH" as const;
  readonly categoryWireValues = ["jurisprudence", "republic-acts"] as const;
  readonly facetVocab = {
    caseTypes: JURIS_PH_CASE_TYPES,
    topics: JURIS_PH_TOPICS,
    courts: [] as const,
  };

  parseCategory(wire: string): LawCategory {
    return parseLawCategory(wire);
  }

  search(params: { category: LawCategory; q: string; limit: number }) {
    return LawSvc.search(params);
  }

  browse(params: { category: LawCategory; facets: LawFacets; cursor?: string; limit: number }) {
    // The wire values were already validated against JURIS_PH_CASE_TYPES / JURIS_PH_TOPICS by
    // lawBrowseSchema, so these casts only re-assert what the schema guaranteed.
    return LawSvc.browse({
      category: params.category,
      caseType: params.facets.caseType as JurisPhCaseType | undefined,
      topics: params.facets.topics as JurisPhTopic[] | undefined,
      year: params.facets.year,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  getDocument(params: { category: LawCategory; id: string }) {
    return LawSvc.getDocument(params);
  }
}
