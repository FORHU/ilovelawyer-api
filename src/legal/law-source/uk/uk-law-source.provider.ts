import { createHash } from "crypto";
import { Law, LawCategory } from "@prisma/client";
import LawRepo from "../../../repositories/law.repository";
import HttpError from "../../../utils/http-error";
import {
  caseLawSearch,
  legislationSearch,
  judgmentGetIndex,
  legislationGetToc,
  legislationGetSection,
  getCitationsNetwork,
  UkLegalMcpUnavailableError,
  type UkLegislationSectionResult,
} from "../../../utils/uk-legal-mcp";
import { extractCaseUri } from "../../../utils/uk-citation-resolution";
import {
  SEARCH_NOTICE,
  type SearchResult,
  type BrowseResult,
  type DocumentResult,
  type SearchResultItem,
} from "../../../services/law.service";
import { LawFacets, LawSourceProvider } from "../law-source-provider";
import {
  UK_CATEGORY_WIRE_VALUES,
  UK_CATEGORY_BY_WIRE,
  UK_WIRE_BY_CATEGORY,
  UK_COURTS,
  UkCategoryWire,
} from "./uk-law-vocab";
import {
  caseLawHitToCreateInput,
  legislationHitToCreateInput,
  caseLawDetailInput,
  legislationDetailInput,
  legislationUrlParts,
} from "./uk-law-mappers";

/** Newest-first "browse" is match-all search filtered by court. */
const BROWSE_WILDCARD = "*";
const BROWSE_PAGE_SIZE = 20;
const BROWSE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Top-level TOC entries to pull full section text for on a legislation detail fetch. */
const LEGISLATION_DETAIL_SECTIONS = 4;

/**
 * UK Library source: search + faceted (court) browse + lazy-detail, proxying the UK Legal MCP
 * (uk-legal-mcp.fly.dev) and writing results through into the `Law` table exactly as
 * `LawSvc` does for juris.ph. Local-first: stored UK-tenant rows first, MCP on a miss, and
 * stored rows again when the MCP is unreachable. `uk-case-law` -> case law (Find Case Law),
 * `uk-legislation` -> Acts & SIs (legislation.gov.uk). Faceted browse is case-law only —
 * legislation has no query-less list upstream (see docs/adr/0005-uk-library-source.md).
 */
export class UkLawSourceProvider implements LawSourceProvider {
  readonly tenantCode = "UK" as const;
  readonly categoryWireValues = UK_CATEGORY_WIRE_VALUES;
  readonly facetVocab = {
    caseTypes: [] as const,
    topics: [] as const,
    courts: UK_COURTS,
  };

  parseCategory(wire: string): LawCategory {
    const category = UK_CATEGORY_BY_WIRE[wire as UkCategoryWire];
    if (!category) {
      throw new HttpError("category must be 'uk-case-law' or 'uk-legislation'", 400);
    }
    return category;
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(params: { category: LawCategory; q: string; limit: number }): Promise<SearchResult> {
    const { category, q, limit } = params;
    const wire = UK_WIRE_BY_CATEGORY[category];

    const localRows = await LawRepo.localSearchUk({ category, q, limit });
    if (localRows.length > 0) {
      return this.toResult(wire, q, limit, localRows, "cache");
    }

    const tenantId = await LawRepo.resolveUkTenantId();
    let created: Law[];
    try {
      created =
        category === "JURISPRUDENCE"
          ? await this.searchCaseLaw(q, limit, tenantId)
          : await this.searchLegislation(q, limit, tenantId);
    } catch (err) {
      if (err instanceof UkLegalMcpUnavailableError) {
        throw new HttpError(
          "The UK legal source is unavailable and no matching laws are stored locally",
          502,
        );
      }
      throw err;
    }

    return this.toResult(wire, q, limit, created, "uk-legal-mcp");
  }

  private async searchCaseLaw(q: string, limit: number, tenantId: string): Promise<Law[]> {
    const { results } = await caseLawSearch({ query: q, limit });
    return this.writeThrough(
      results.map((hit) => caseLawHitToCreateInput(hit, tenantId)),
    );
  }

  private async searchLegislation(q: string, limit: number, tenantId: string): Promise<Law[]> {
    const { results } = await legislationSearch({ query: q, limit });
    return this.writeThrough(
      results.map((hit) => legislationHitToCreateInput(hit, tenantId)),
    );
  }

  // ── browse (case law only) ────────────────────────────────────────────────

  async browse(params: {
    category: LawCategory;
    facets: LawFacets;
    cursor?: string;
    limit: number;
  }): Promise<BrowseResult> {
    if (params.category !== "JURISPRUDENCE") {
      throw new HttpError(
        "UK legislation has no browse — search by title instead",
        400,
      );
    }

    const limit = params.limit || BROWSE_PAGE_SIZE;
    const court = params.facets.court;
    const page = decodePage(params.cursor);
    const isFirstPage = page === 1;

    const filterKey = `t=UK|d=uk-case-law|court=${court ?? ""}|l=${limit}`;
    const pageKey = browsePageKey(filterKey, String(page));

    const cached = await LawRepo.findBrowsePage(pageKey);
    const cachedFresh =
      !!cached && (!cached.isFirstPage || Date.now() - cached.fetchedAt.getTime() < BROWSE_CACHE_TTL_MS);
    if (cached && cachedFresh) {
      return this.browseFromCache(limit, cached);
    }

    const tenantId = await LawRepo.resolveUkTenantId();
    let hits: Awaited<ReturnType<typeof caseLawSearch>>;
    try {
      hits = await caseLawSearch({ query: BROWSE_WILDCARD, court, page, limit });
    } catch (err) {
      if (err instanceof UkLegalMcpUnavailableError) {
        if (cached) return this.browseFromCache(limit, cached);
        throw new HttpError("The UK legal source is unavailable — browse can't be served offline", 502);
      }
      throw err;
    }

    const rows = await this.writeThrough(
      hits.results.map((hit) => caseLawHitToCreateInput(hit, tenantId)),
    );

    await LawRepo.saveBrowsePage({
      pageKey,
      filterKey,
      isFirstPage,
      jurisIds: rows.map((r) => r.jurisSourceId),
      hasMore: hits.has_more,
      nextCursor: hits.has_more ? encodePage(page + 1) : null,
    });

    return {
      items: rows.map((r) => this.rowToItem("uk-case-law", r)),
      meta: { dataset: "uk-case-law", limit, count: rows.length, hasMore: hits.has_more },
      cursor: hits.has_more ? encodePage(page + 1) : null,
      notice: SEARCH_NOTICE,
    };
  }

  private async browseFromCache(
    limit: number,
    cached: { jurisIds: string[]; hasMore: boolean; nextCursor: string | null },
  ): Promise<BrowseResult> {
    const rows = await LawRepo.findByJurisSourceIds(cached.jurisIds);
    const byId = new Map(rows.map((r) => [r.jurisSourceId, r]));
    const ordered = cached.jurisIds
      .map((id) => byId.get(id))
      .filter((r): r is Law => !!r);
    return {
      items: ordered.map((r) => this.rowToItem("uk-case-law", r)),
      meta: { dataset: "uk-case-law", limit, count: ordered.length, hasMore: cached.hasMore },
      cursor: cached.nextCursor,
      notice: SEARCH_NOTICE,
    };
  }

  // ── document (lazy detail) ────────────────────────────────────────────────

  async getDocument(params: { category: LawCategory; id: string }): Promise<DocumentResult> {
    const wire = UK_WIRE_BY_CATEGORY[params.category];
    const existing = await LawRepo.findById(params.id);
    if (!existing || existing.category !== params.category) {
      throw new HttpError("No such law document", 404);
    }
    if (existing.detailFetchedAt) {
      return this.toDocumentResult(wire, existing, "cache");
    }

    try {
      const row =
        params.category === "JURISPRUDENCE"
          ? await this.fillCaseLawDetail(existing)
          : await this.fillLegislationDetail(existing);
      return this.toDocumentResult(wire, row, "uk-legal-mcp");
    } catch (err) {
      if (err instanceof UkLegalMcpUnavailableError) {
        return this.toDocumentResult(wire, existing, "cache");
      }
      throw err;
    }
  }

  private async fillCaseLawDetail(row: Law): Promise<Law> {
    const slug = extractCaseUri(row.jurisUrl);
    if (!slug) return row;
    const [index, network] = await Promise.all([
      judgmentGetIndex(slug).catch(() => null),
      getCitationsNetwork(slug).catch(() => null),
    ]);
    return LawRepo.updateDetail(row.id, caseLawDetailInput(index, network));
  }

  private async fillLegislationDetail(row: Law): Promise<Law> {
    const parts = legislationUrlParts(row.jurisUrl);
    if (!parts) return row;
    const toc = await legislationGetToc(parts).catch(() => null);
    const sectionIds = (toc?.items ?? [])
      .slice(0, LEGISLATION_DETAIL_SECTIONS)
      .map((raw) => raw.split(":")[0].trim())
      .filter(Boolean);
    const sections: UkLegislationSectionResult[] = [];
    for (const section of sectionIds) {
      const s = await legislationGetSection({ ...parts, section }).catch(() => null);
      if (s) sections.push(s);
    }
    return LawRepo.updateDetail(row.id, legislationDetailInput(toc, sections));
  }

  // ── shaping ───────────────────────────────────────────────────────────────

  /** Insert every hit we don't already store (keyed by jurisSourceId = canonical URL), then
   * return the full rows in input order. */
  private async writeThrough(inputs: Parameters<typeof LawRepo.createMany>[0]): Promise<Law[]> {
    const ids = inputs.map((i) => i.jurisSourceId);
    await LawRepo.createMany(inputs);
    const rows = await LawRepo.findByJurisSourceIds(ids);
    const byId = new Map(rows.map((r) => [r.jurisSourceId, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is Law => !!r);
  }

  private rowToItem(wire: UkCategoryWire, row: Law): SearchResultItem {
    const isCase = wire === "uk-case-law";
    return {
      id: row.id,
      stored_id: row.id,
      stored: false,
      score: row.score ?? undefined,
      year: row.year,
      tags: row.tags,
      url: row.jurisUrl,
      pdf_url: row.pdfUrl,
      source_url: row.sourceUrl,
      case_number: isCase ? row.caseNumber ?? undefined : undefined,
      case_title: isCase ? row.title : undefined,
      division: row.division ?? undefined,
      decision_date: row.decisionDate ? row.decisionDate.toISOString() : undefined,
      ra_number: isCase ? undefined : row.raNumber ?? undefined,
      title: isCase ? undefined : row.title,
      summary: row.summary ?? undefined,
    };
  }

  private toResult(
    wire: UkCategoryWire,
    q: string,
    limit: number,
    rows: Law[],
    source: "cache" | "uk-legal-mcp",
  ): SearchResult {
    const items = rows.map((r) => this.rowToItem(wire, r));
    return {
      items,
      meta: { dataset: wire, query: q, limit, count: items.length, source },
      notice: SEARCH_NOTICE,
    };
  }

  private toDocumentResult(
    wire: UkCategoryWire,
    row: Law,
    source: "cache" | "uk-legal-mcp",
  ): DocumentResult {
    const isCase = wire === "uk-case-law";
    return {
      item: {
        id: row.id,
        stored_id: row.id,
        dataset: wire,
        title: row.title,
        reference: row.caseNumber ?? row.raNumber ?? null,
        year: row.year,
        tags: row.tags,
        case_type: row.caseType,
        division: row.division,
        ponente: row.ponente,
        decision_date: row.decisionDate ? row.decisionDate.toISOString() : null,
        facts: row.facts,
        disposition: row.disposition,
        summary: row.summary,
        legal_rules_cited: row.legalRulesCited,
        pdf_url: row.pdfUrl,
        source_url: row.sourceUrl,
        juris_url: row.jurisUrl,
      },
      detail: {
        fetched: row.detailFetchedAt !== null,
        keywords: row.keywords,
        sections: (row.sections as unknown[] | null) ?? null,
        key_provisions: row.keyProvisions,
        date_enacted: row.dateEnacted,
        legislative_agenda_purpose: row.legislativeAgendaPurpose,
        affected_laws_amendments: row.affectedLawsAmendments,
        principal_authors: row.principalAuthors,
        co_authors: row.coAuthors,
        procedural_history: row.proceduralHistory,
        court_reasoning: row.courtReasoning,
        legal_issues: row.legalIssues,
        parties: (row.parties as unknown[] | null) ?? null,
        judges: (row.judges as unknown[] | null) ?? null,
        sanctions_and_penalties: (row.sanctionsAndPenalties as unknown[] | null) ?? null,
        related_cases_cited: row.relatedCasesCited,
        cited_gr_numbers: row.citedGrNumbers,
        cited_ra_numbers: row.citedRaNumbers,
      },
      source,
      notice: SEARCH_NOTICE,
    };
  }
}

// ── cursor / page-key helpers ───────────────────────────────────────────────

function encodePage(page: number): string {
  return Buffer.from(JSON.stringify({ page })).toString("base64url");
}

function decodePage(raw: string | undefined): number {
  if (!raw) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { page?: unknown };
    if (typeof parsed.page === "number" && Number.isInteger(parsed.page) && parsed.page >= 1) {
      return parsed.page;
    }
  } catch {
    /* fall through */
  }
  throw new HttpError("Invalid cursor", 400);
}

function browsePageKey(filterKey: string, cursorRaw: string): string {
  return createHash("sha256").update(`${filterKey}\n${cursorRaw}`).digest("hex");
}
