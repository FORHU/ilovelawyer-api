import { LawCategory } from "@prisma/client";
import { TenantCode } from "../../types/tenant-code";
import type { SearchResult, BrowseResult, DocumentResult } from "../../services/law.service";

/**
 * One tenantCode's live legal-source surface for the Library tab: search, faceted browse, and
 * lazy-detail document lookup, each local-first (stored `Law` rows first, upstream on a miss,
 * write-through). Selected strictly by tenantCode — see law-source.registry.ts. Same shape as
 * legal-knowledge.registry.ts / prompt-registry.ts / deadline-engine.registry.ts.
 *
 * PH (`PhLawSourceProvider`) proxies juris.ph; UK (`UkLawSourceProvider`) proxies the UK Legal
 * MCP (search + detail) and the Find Case Law Atom feed (case-law browse). The response shapes
 * are shared (`SearchResult` / `BrowseResult` / `DocumentResult` from law.service.ts); UK-only
 * columns are carried in the PH-named fields (see docs/adr/0005-uk-library-source.md).
 */
export interface LawFacets {
  /** PH jurisprudence only. */
  caseType?: string;
  /** PH only (csv on the wire). */
  topics?: string[];
  /** UK case law only — court slugs, e.g. ["uksc", "ewca/civ"] (csv on the wire). Empty/absent
   * means "all courts", same as PH's empty `topics`. */
  courts?: string[];
  /** Both PH (juris.ph) and UK case-law browse. */
  year?: number;
}

export interface LawSourceProvider {
  readonly tenantCode: TenantCode;

  /** Accepted `?category=` wire values for this tenant (PH: jurisprudence|republic-acts;
   * UK: uk-case-law|uk-legislation). Used by the tenant-aware validation schemas. */
  readonly categoryWireValues: readonly string[];

  /** Facet vocabularies this tenant accepts on `/api/law/browse`, for validation. */
  readonly facetVocab: {
    caseTypes: readonly string[];
    topics: readonly string[];
    courts: readonly string[];
  };

  /** Wire `?category=` value -> the stored `LawCategory` enum. Throws HttpError(400) on an
   * unknown value. */
  parseCategory(wire: string): LawCategory;

  search(params: { category: LawCategory; q: string; limit: number }): Promise<SearchResult>;

  browse(params: {
    category: LawCategory;
    facets: LawFacets;
    cursor?: string;
    limit: number;
  }): Promise<BrowseResult>;

  getDocument(params: { category: LawCategory; id: string }): Promise<DocumentResult>;
}
