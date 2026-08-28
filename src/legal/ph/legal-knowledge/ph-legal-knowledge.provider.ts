import LegalRagSvc from "../../../services/legal-rag.service";
import LegalSourceCacheSvc from "../../../services/legal-source-cache.service";
import { LegalKnowledgeProvider } from "../../legal-knowledge-provider";

/** Thin adapter over the existing PH-only LegalRagSvc/LegalSourceCacheSvc — no new logic. */
export class PHLegalKnowledgeProvider implements LegalKnowledgeProvider {
  readonly tenantCode = "PH" as const;
  readonly corpusAvailable = true;

  getCategories() {
    return LegalRagSvc.getCategories();
  }

  getSubcategories(category: string) {
    return LegalRagSvc.getSubcategories(category);
  }

  list(params: Parameters<typeof LegalRagSvc.list>[0]) {
    return LegalRagSvc.list(params);
  }

  getLibrarySections() {
    return LegalRagSvc.getLibrarySections();
  }

  search(query: string, limit: number) {
    return LegalRagSvc.search(query, limit);
  }

  vectorSearch(embedding: number[], limit: number, offset: number, minSimilarity: number) {
    return LegalRagSvc.vectorSearch(embedding, limit, offset, minSimilarity);
  }

  getById(id: number) {
    return LegalRagSvc.getById(id);
  }

  getRelated(id: number, limit: number) {
    return LegalRagSvc.getRelated(id, limit);
  }

  getSourcePageDoc(itemId: string, titleHint?: string) {
    return LegalRagSvc.getSourcePageDoc(itemId, titleHint);
  }

  analyzeKeyword(keyword: string) {
    return LegalSourceCacheSvc.analyze(keyword, "PH");
  }
}
