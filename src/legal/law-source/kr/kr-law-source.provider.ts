import { createHash } from "crypto";
import { Law, LawCategory } from "@prisma/client";
import LawRepo from "../../../repositories/law.repository";
import HttpError from "../../../utils/http-error";
import { LawPreview, toLawPreview } from "../../../utils/law-preview";
import { callKoreanLawTool, isNotFound, KoreanLawMcpUnavailableError } from "../../../utils/korean-law-mcp";
import {
  SEARCH_NOTICE,
  type SearchResult,
  type BrowseResult,
  type DocumentResult,
  type SearchResultItem,
} from "../../../services/law.service";
import { LawFacets, LawSourceProvider } from "../law-source-provider";
import {
  KR_CATEGORY_BY_WIRE,
  KR_CATEGORY_WIRE_VALUES,
  KR_COURTS,
  KR_LAW_ID_PREFIX,
  KR_PRECEDENT_ID_PREFIX,
  KR_WIRE_BY_CATEGORY,
  type KrCategoryWire,
} from "./kr-law-vocab";
import {
  cleanBatchArticles,
  decisionDetailInput,
  decisionHitToCreateInput,
  lawDetailInput,
  lawHitToCreateInput,
  parseDecisionSearch,
  parseDecisionText,
  parseLawSearch,
  parseLawToc,
} from "./kr-law-parsers";

const BROWSE_PAGE_SIZE = 20;
/** A search or browse page is fetched from the MCP once and served from the DB for this long. */
const PAGE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** get_batch_articles takes at most 50 articles per call. */
const ARTICLES_PER_BATCH = 50;
/** A statute's text is filled this many batches at a time. */
const BATCH_CONCURRENCY = 3;
/** Past this many articles the text is cut short (with a note): one fill stays under a minute. */
const MAX_ARTICLES = 1500;
/** How long a citation hover card waits on a first-time detail fill (see getPreview). */
const PREVIEW_FILL_BUDGET_MS = 6_000;

const UNAVAILABLE = "The Korean legal source is unavailable and no matching laws are stored locally";

/**
 * KR Library source: statutes (법령) and court decisions (판례) from law.go.kr, through the Korean
 * Law MCP, written through into the `Law` table like the PH and UK sources.
 *
 * - `kr-legislation`: search by statute name (law.go.kr has no query-less list of statutes, so no
 *   browse). Opening one fills its full text, article by article, the first time.
 * - `kr-case-law`: search, or browse newest first, both filterable by court (KR_COURTS). Opening
 *   one fills its sections (판시사항, 판결요지, 참조조문, 참조판례, 주문) and full text.
 *
 * Every page of a search or browse is cached as a `LawBrowsePage` for PAGE_CACHE_TTL_MS, so paging
 * and repeat searches don't call the MCP again. When the MCP is down, a stale cached page or the
 * stored rows that match are served instead, else 502. No year facet: law.go.kr's date filter on
 * precedents returned decisions outside the range when tried.
 */
export class KrLawSourceProvider implements LawSourceProvider {
  readonly tenantCode = "KR" as const;
  readonly categoryWireValues = KR_CATEGORY_WIRE_VALUES;
  readonly facetVocab = {
    caseTypes: [] as const,
    topics: [] as const,
    courts: KR_COURTS,
  };

  parseCategory(wire: string): LawCategory {
    const category = KR_CATEGORY_BY_WIRE[wire as KrCategoryWire];
    if (!category) throw new HttpError("category must be 'kr-case-law' or 'kr-legislation'", 400);
    return category;
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(params: { category: LawCategory; q: string; limit: number; courts?: string[]; cursor?: string }): Promise<SearchResult> {
    const { category, q, limit } = params;
    const wire = KR_WIRE_BY_CATEGORY[category];
    const page = decodePage(params.cursor);

    if (category === "REPUBLIC_ACT") {
      // One page only: search_law ranks exact name matches first and has no paging.
      const result = await this.cachedPage(`t=KR|d=${wire}|q=${normal(q)}|l=${limit}`, 1, async () => {
        const text = await callKoreanLawTool("search_law", { query: q.trim(), display: limit });
        const tenantId = await LawRepo.resolveKrTenantId();
        const rows = await this.writeThrough(parseLawSearch(text).slice(0, limit).map((hit) => lawHitToCreateInput(hit, tenantId)));
        return { rows, hasMore: false };
      }).catch((err) => this.offline(err, category, q, limit, []));
      return { ...this.toResult(wire, q, limit, result.rows, result.cached), cursor: null };
    }

    const courts = params.courts ?? [];
    const result = await this.decisionPages(wire, q.trim(), courts, page, limit).catch((err) =>
      page === 1 ? this.offline(err, category, q, limit, courts) : Promise.reject(err),
    );
    return { ...this.toResult(wire, q, limit, result.rows, result.cached), cursor: result.hasMore ? encodePage(page + 1) : null };
  }

  // ── browse (case law only) ────────────────────────────────────────────────

  async browse(params: { category: LawCategory; facets: LawFacets; cursor?: string; limit: number }): Promise<BrowseResult> {
    if (params.category !== "JURISPRUDENCE") throw new HttpError("Korean statutes have no browse — search by name instead", 400);
    const limit = params.limit || BROWSE_PAGE_SIZE;
    const page = decodePage(params.cursor);
    let result: { rows: Law[]; hasMore: boolean };
    try {
      result = await this.decisionPages("kr-case-law", "", params.facets.courts ?? [], page, limit);
    } catch (err) {
      if (err instanceof KoreanLawMcpUnavailableError) throw new HttpError("The Korean legal source is unavailable — browse can't be served offline", 502);
      throw err;
    }
    return {
      items: result.rows.map((r) => this.rowToItem("kr-case-law", r)),
      meta: { dataset: "kr-case-law", limit, count: result.rows.length, hasMore: result.hasMore },
      cursor: result.hasMore ? encodePage(page + 1) : null,
      notice: SEARCH_NOTICE,
    };
  }

  /**
   * One page of decisions for `q` ("" = newest first), across `courts` (none = every court). The
   * MCP filters one court per request, so several courts are fetched in parallel, each a share of
   * `limit`, and merged newest first.
   */
  private async decisionPages(
    wire: KrCategoryWire,
    q: string,
    courts: string[],
    page: number,
    limit: number,
  ): Promise<{ rows: Law[]; hasMore: boolean; cached: boolean }> {
    const sources: (string | undefined)[] = courts.length ? courts : [undefined];
    const perSource = Math.max(1, Math.ceil(limit / sources.length));
    const pages = await Promise.all(
      sources.map((court) =>
        this.cachedPage(`t=KR|d=${wire}|q=${normal(q)}|court=${court ?? ""}|l=${perSource}`, page, async () => {
          const text = await callKoreanLawTool("search_decisions", {
            domain: "precedent",
            query: q,
            display: perSource,
            page,
            // Newest first when browsing; a search keeps law.go.kr's own order.
            ...(q ? {} : { sort: "ddes" }),
            ...(court ? { options: { court } } : {}),
          });
          if (isNotFound(text)) return { rows: [], hasMore: false };
          const parsed = parseDecisionSearch(text);
          const tenantId = await LawRepo.resolveKrTenantId();
          const rows = await this.writeThrough(parsed.hits.map((hit) => decisionHitToCreateInput(hit, tenantId)));
          return { rows, hasMore: page * perSource < parsed.total && parsed.hits.length > 0 };
        }),
      ),
    );
    const rows = pages.flatMap((p) => p.rows);
    if (sources.length > 1) rows.sort((a, b) => (b.decisionDate?.getTime() ?? 0) - (a.decisionDate?.getTime() ?? 0));
    return { rows, hasMore: pages.some((p) => p.hasMore), cached: pages.every((p) => p.cached) };
  }

  /** A page from the `LawBrowsePage` cache while fresh, else `fetch` (written through and cached).
   * A stale cached page still beats a 502 when the MCP is down. */
  private async cachedPage(
    filterKey: string,
    page: number,
    fetch: () => Promise<{ rows: Law[]; hasMore: boolean }>,
  ): Promise<{ rows: Law[]; hasMore: boolean; cached: boolean }> {
    const pageKey = createHash("sha256").update(`${filterKey}\n${page}`).digest("hex");
    const cached = await LawRepo.findBrowsePage(pageKey);
    if (cached && Date.now() - cached.fetchedAt.getTime() < PAGE_CACHE_TTL_MS) {
      return { rows: await this.rowsFor(cached.jurisIds), hasMore: cached.hasMore, cached: true };
    }
    let fresh: { rows: Law[]; hasMore: boolean };
    try {
      fresh = await fetch();
    } catch (err) {
      if (err instanceof KoreanLawMcpUnavailableError && cached) {
        return { rows: await this.rowsFor(cached.jurisIds), hasMore: cached.hasMore, cached: true };
      }
      throw err;
    }
    await LawRepo.saveBrowsePage({
      pageKey,
      filterKey,
      isFirstPage: page === 1,
      jurisIds: fresh.rows.map((r) => r.jurisSourceId),
      hasMore: fresh.hasMore,
      nextCursor: fresh.hasMore ? encodePage(page + 1) : null,
    });
    return { ...fresh, cached: false };
  }

  /** The MCP is down and nothing is cached for this page: whatever stored rows match, else 502. */
  private async offline(err: unknown, category: LawCategory, q: string, limit: number, courts: string[]) {
    if (!(err instanceof KoreanLawMcpUnavailableError)) throw err;
    const rows = await LawRepo.localSearchKr({ category, q, limit, courts });
    if (rows.length === 0) throw new HttpError(UNAVAILABLE, 502);
    return { rows, hasMore: false, cached: true };
  }

  // ── document (lazy detail) ────────────────────────────────────────────────

  async getDocument(params: { category: LawCategory; id: string }): Promise<DocumentResult> {
    const wire = KR_WIRE_BY_CATEGORY[params.category];
    const existing = await this.krRow(params);
    if (existing.detailFetchedAt) return this.toDocumentResult(wire, existing, "cache");
    try {
      return this.toDocumentResult(wire, await this.fillDetail(existing), "korean-law-mcp");
    } catch (err) {
      if (err instanceof KoreanLawMcpUnavailableError) return this.toDocumentResult(wire, existing, "cache");
      throw err;
    }
  }

  /** DB-first, like UK: a row nobody has opened yet has no text, so the first preview runs the
   * detail fill, capped at PREVIEW_FILL_BUDGET_MS; an overrunning fill finishes in the background. */
  async getPreview(params: { category: LawCategory; id: string }): Promise<LawPreview> {
    const row = await this.krRow(params);
    const preview = toLawPreview(row);
    if (preview.snippet || row.detailFetchedAt) return preview;
    const fill = this.fillDetail(row).catch(() => null);
    const filled = await Promise.race([fill, new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIEW_FILL_BUDGET_MS))]);
    return filled ? toLawPreview(filled) : preview;
  }

  /** `id` is our `Law.id`; the row must be a KR one of this category. */
  private async krRow(params: { category: LawCategory; id: string }): Promise<Law> {
    const row = await LawRepo.findById(params.id);
    const prefix = params.category === "JURISPRUDENCE" ? KR_PRECEDENT_ID_PREFIX : KR_LAW_ID_PREFIX;
    if (!row || row.category !== params.category || !row.jurisSourceId.startsWith(prefix)) throw new HttpError("No such law document", 404);
    return row;
  }

  private fillDetail(row: Law): Promise<Law> {
    return row.category === "JURISPRUDENCE" ? this.fillDecision(row) : this.fillStatute(row);
  }

  private async fillDecision(row: Law): Promise<Law> {
    const id = row.jurisSourceId.slice(KR_PRECEDENT_ID_PREFIX.length);
    const text = await callKoreanLawTool("get_decision_text", { domain: "precedent", id, full: true });
    if (isNotFound(text)) return row;
    return LawRepo.updateDetail(row.id, decisionDetailInput(parseDecisionText(text)));
  }

  /** The table of contents, then every article's text in batches of 50 (a few batches at a time). */
  private async fillStatute(row: Law): Promise<Law> {
    const mst = row.jurisSourceId.slice(KR_LAW_ID_PREFIX.length);
    const toc = parseLawToc(await callKoreanLawTool("get_law_text", { mst }));
    const articles = toc.articles.slice(0, MAX_ARTICLES).map((a) => a.jo);
    const batches: string[][] = [];
    for (let i = 0; i < articles.length; i += ARTICLES_PER_BATCH) batches.push(articles.slice(i, i + ARTICLES_PER_BATCH));

    const texts: string[] = new Array(batches.length).fill("");
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const group = batches.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.all(
        group.map((articlesInBatch) => callKoreanLawTool("execute_tool", { tool_name: "get_batch_articles", params: { mst, articles: articlesInBatch } })),
      );
      results.forEach((text, j) => (texts[i + j] = isNotFound(text) ? "" : cleanBatchArticles(text, toc.title ?? row.title)));
    }
    let fullText = texts.filter(Boolean).join("\n\n").trim() || null;
    if (fullText && toc.articles.length > MAX_ARTICLES) {
      fullText += `\n\n… 제${MAX_ARTICLES + 1}번째 조문부터는 국가법령정보센터 원문에서 확인하세요.`;
    }
    return LawRepo.updateDetail(row.id, lawDetailInput(toc, fullText));
  }

  // ── shaping ───────────────────────────────────────────────────────────────

  private async writeThrough(inputs: Parameters<typeof LawRepo.createMany>[0]): Promise<Law[]> {
    const ids = inputs.map((i) => i.jurisSourceId);
    if (ids.length === 0) return [];
    await LawRepo.createMany(inputs);
    return this.rowsFor(ids);
  }

  private async rowsFor(jurisIds: string[]): Promise<Law[]> {
    const rows = await LawRepo.findByJurisSourceIds(jurisIds);
    const byId = new Map(rows.map((r) => [r.jurisSourceId, r]));
    return jurisIds.map((id) => byId.get(id)).filter((r): r is Law => !!r);
  }

  private rowToItem(wire: KrCategoryWire, row: Law): SearchResultItem {
    const isCase = wire === "kr-case-law";
    return {
      id: row.id,
      stored_id: row.id,
      stored: false,
      score: row.score ?? undefined,
      year: row.year,
      tags: row.tags,
      url: row.jurisUrl,
      pdf_url: null,
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

  private toResult(wire: KrCategoryWire, q: string, limit: number, rows: Law[], cached: boolean): SearchResult {
    const items = rows.map((r) => this.rowToItem(wire, r));
    return { items, meta: { dataset: wire, query: q, limit, count: items.length, source: cached ? "cache" : "korean-law-mcp" }, notice: SEARCH_NOTICE };
  }

  private toDocumentResult(wire: KrCategoryWire, row: Law, source: "cache" | "korean-law-mcp"): DocumentResult {
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
        // No PDF: the Library shows `full_text` (the judgment, or the statute's articles).
        pdf_url: null,
        source_url: row.sourceUrl,
        juris_url: row.jurisUrl,
        full_text: row.fullText,
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

const normal = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

function encodePage(page: number): string {
  return Buffer.from(JSON.stringify({ page })).toString("base64url");
}

/** A cursor is `{page}`; absent means page 1. */
function decodePage(raw: string | undefined): number {
  if (!raw) return 1;
  try {
    const { page } = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { page?: unknown };
    if (typeof page === "number" && Number.isInteger(page) && page >= 1) return page;
  } catch {
    // fall through to the 400 below
  }
  throw new HttpError("Invalid cursor", 400);
}
