import { Jurisdiction } from "../types/jurisdiction";
import LegalRagSvc from "../services/legal-rag.service";
import LegalSourceCacheSvc from "../services/legal-source-cache.service";

/**
 * One jurisdiction's legal-research surface: the PH-only ingested case-law/statute corpus
 * (categories, browse, search, getById, ...) plus AI-assisted keyword analysis. Selected by
 * jurisdiction only (see legal/legal-knowledge.registry.ts) — never by client input, and never
 * falls back to another jurisdiction's corpus.
 */
export interface LegalKnowledgeProvider {
  readonly jurisdiction: Jurisdiction;
  /** Whether the raw corpus-backed methods below (everything except analyzeKeyword) are
   * available for this jurisdiction. False means those methods reject rather than returning
   * another jurisdiction's data. */
  readonly corpusAvailable: boolean;

  getCategories(): ReturnType<typeof LegalRagSvc.getCategories>;
  getSubcategories(category: string): ReturnType<typeof LegalRagSvc.getSubcategories>;
  list(params: Parameters<typeof LegalRagSvc.list>[0]): ReturnType<typeof LegalRagSvc.list>;
  getLibrarySections(): ReturnType<typeof LegalRagSvc.getLibrarySections>;
  search(query: string, limit: number): ReturnType<typeof LegalRagSvc.search>;
  vectorSearch(
    embedding: number[],
    limit: number,
    offset: number,
    minSimilarity: number,
  ): ReturnType<typeof LegalRagSvc.vectorSearch>;
  getById(id: number): ReturnType<typeof LegalRagSvc.getById>;
  getRelated(id: number, limit: number): ReturnType<typeof LegalRagSvc.getRelated>;
  getSourcePageDoc(itemId: string, titleHint?: string): ReturnType<typeof LegalRagSvc.getSourcePageDoc>;

  /**
   * AI-assisted keyword analysis. Already jurisdiction-safe today via LegalSourceCacheSvc (its
   * Tier 2 RAG-corpus lookup is already skipped for non-PH jurisdictions — see that service),
   * so both providers delegate to it directly rather than gating it behind corpusAvailable.
   */
  analyzeKeyword(keyword: string): ReturnType<typeof LegalSourceCacheSvc.analyze>;
}
