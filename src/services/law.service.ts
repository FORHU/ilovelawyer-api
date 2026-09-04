import { createHash } from "crypto";
import { LawCategory, Prisma } from "@prisma/client";
import LawRepo, { ListLawsParams } from "../repositories/law.repository";
import HttpError from "../utils/http-error";
import {
  browseJurisPh,
  JurisPhBrowseCursor,
  JurisPhCaseType,
  JurisPhDataset,
  JurisPhDetail,
  JurisPhItem,
  JurisPhTopic,
  JurisPhUnavailableError,
  retrieveJurisPh,
  searchJurisPh,
} from "../utils/juris-ph";

type LawRow = NonNullable<Awaited<ReturnType<typeof LawRepo.findByJurisSourceId>>>;

const DATASET_BY_CATEGORY: Record<LawCategory, JurisPhDataset> = {
  JURISPRUDENCE: "jurisprudence",
  REPUBLIC_ACT: "republic-acts",
};

const CATEGORY_BY_DATASET: Record<JurisPhDataset, LawCategory> = {
  jurisprudence: "JURISPRUDENCE",
  "republic-acts": "REPUBLIC_ACT",
};

/** Accepts the wire value the client sends (`jurisprudence` | `republic-acts`). */
export function parseLawCategory(raw: string): LawCategory {
  const category = CATEGORY_BY_DATASET[raw as JurisPhDataset];
  if (!category) throw new HttpError("category must be 'jurisprudence' or 'republic-acts'", 400);
  return category;
}

// One notice for every search, regardless of how the result was sourced — the response
// must not hint at where a given hit came from.
const SEARCH_NOTICE =
  "Summaries, tags, and relevance scores are research aids and may contain errors. " +
  "Always verify against the official text of each result.";

interface SearchResultItem extends JurisPhItem {
  /** Our Law.id for this juris.ph document. */
  stored_id: string;
  /** true when this search inserted the row; false when it was already stored. */
  stored: boolean;
}

interface SearchResult {
  items: SearchResultItem[];
  meta: {
    dataset: JurisPhDataset;
    query: string;
    limit: number;
    count: number;
    source: "juris.ph" | "cache";
  };
  notice: string;
}

interface BrowseResult {
  items: SearchResultItem[];
  meta: {
    dataset: JurisPhDataset;
    limit: number;
    count: number;
    hasMore: boolean;
  };
  /** Opaque token for the next page — pass it back as `?cursor=`. null when there is no next page. */
  cursor: string | null;
  notice: string;
}

const BROWSE_PAGE_SIZE = 20;
/** How long a cached *first* browse page (cursor === "") is trusted before it's re-fetched
 * from juris.ph — new decisions land at the top of the newest year. Deeper pages are
 * historical and never expire. */
const BROWSE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Stable identity for a facet-filter combination. */
function browseFilterKey(p: {
  dataset: JurisPhDataset;
  caseType?: JurisPhCaseType;
  topics?: JurisPhTopic[];
  year?: number;
  limit: number;
}): string {
  return [
    `d=${p.dataset}`,
    `ct=${p.caseType ?? ""}`,
    `tp=${(p.topics ?? []).slice().sort().join("+")}`,
    `y=${p.year ?? ""}`,
    `l=${p.limit}`,
  ].join("|");
}

/** sha256 so the unique index stays small even when a cursor's seenIds list grows large. */
const browsePageKey = (filterKey: string, cursorRaw: string): string =>
  createHash("sha256").update(`${filterKey}\n${cursorRaw}`).digest("hex");

function encodeCursor(cursor: JurisPhBrowseCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): JurisPhBrowseCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError("Invalid cursor", 400);
  }
  const c = parsed as Partial<JurisPhBrowseCursor>;
  if (typeof c?.lastYear !== "number" || !Array.isArray(c.seenIds)) throw new HttpError("Invalid cursor", 400);
  return { lastYear: c.lastYear, seenIds: c.seenIds.filter((id): id is string => typeof id === "string") };
}

function toCreateInput(item: JurisPhItem, category: LawCategory, tenantId: string): Prisma.LawCreateManyInput {
  return {
    jurisSourceId: item.id,
    category,
    tenantId,
    score: item.score ?? null,
    title: item.case_title ?? item.title ?? "(untitled)",
    year: item.year ?? null,
    tags: item.tags ?? [],
    caseNumber: item.case_number ?? null,
    caseType: item.case_type ?? null,
    division: item.division ?? null,
    ponente: item.ponente ?? null,
    decisionDate: item.decision_date ? new Date(item.decision_date) : null,
    facts: item.facts ?? null,
    disposition: item.disposition ?? null,
    legalRulesCited: item.legal_rules_cited ?? [],
    raNumber: item.ra_number ?? null,
    summary: item.summary ?? null,
    jurisUrl: item.url,
    pdfUrl: item.pdf_url ?? null,
    sourceUrl: item.source_url ?? null,
    rawJson: item as unknown as Prisma.InputJsonValue,
  };
}

const asJson = (v: unknown[] | null): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  v ? (v as Prisma.InputJsonValue) : Prisma.JsonNull;

/** JurisPhDetail → the `detail*` columns (+ detailFetchedAt marker). Fields that don't apply
 * to this document's dataset arrive as null/[] and are stored as such. */
function toDetailInput(detail: JurisPhDetail): Prisma.LawUpdateInput {
  return {
    detailFetchedAt: new Date(),
    keywords: detail.keywords,
    sections: asJson(detail.sections),
    keyProvisions: detail.key_provisions,
    dateEnacted: detail.date_enacted,
    legislativeAgendaPurpose: detail.legislative_agenda_purpose,
    affectedLawsAmendments: detail.affected_laws_amendments,
    principalAuthors: detail.principal_authors,
    coAuthors: detail.co_authors,
    proceduralHistory: detail.procedural_history,
    courtReasoning: detail.court_reasoning,
    legalIssues: detail.legal_issues,
    parties: asJson(detail.parties),
    judges: asJson(detail.judges),
    sanctionsAndPenalties: asJson(detail.sanctions_and_penalties),
    relatedCasesCited: detail.related_cases_cited,
    citedGrNumbers: detail.cited_gr_numbers,
    citedRaNumbers: detail.cited_ra_numbers,
  };
}

interface DocumentResult {
  item: {
    id: string;
    stored_id: string;
    dataset: JurisPhDataset;
    title: string;
    reference: string | null;
    year: number | null;
    tags: string[];
    case_type: string | null;
    division: string | null;
    ponente: string | null;
    decision_date: string | null;
    facts: string | null;
    disposition: string | null;
    summary: string | null;
    legal_rules_cited: string[];
    pdf_url: string | null;
    source_url: string | null;
    juris_url: string;
  };
  detail: {
    fetched: boolean;
    keywords: string[];
    sections: unknown[] | null;
    key_provisions: string[];
    date_enacted: string | null;
    legislative_agenda_purpose: string | null;
    affected_laws_amendments: string | null;
    principal_authors: string | null;
    co_authors: string | null;
    procedural_history: string | null;
    court_reasoning: string | null;
    legal_issues: string[];
    parties: unknown[] | null;
    judges: unknown[] | null;
    sanctions_and_penalties: unknown[] | null;
    related_cases_cited: string[];
    cited_gr_numbers: string[];
    cited_ra_numbers: string[];
  };
  source: "juris.ph" | "cache";
  notice: string;
}

export default class LawSvc {
  /**
   * Local-first law search:
   *   1. Look the query up against the rows we've already saved. Any hit is returned
   *      as-is, without touching juris.ph.
   *   2. On a local miss, proxy juris.ph, write through every returned item we don't
   *      already store (keyed by juris `id`), and return the live results annotated
   *      with our row ids.
   *   3. If juris.ph is also unreachable on a local miss, 502.
   */
  static async search(params: { category: LawCategory; q: string; limit: number }): Promise<SearchResult> {
    const { category, q, limit } = params;
    const dataset = DATASET_BY_CATEGORY[category];

    // 1. Local DB first.
    const localRows = await LawRepo.localSearch({ category, q, limit });
    if (localRows.length > 0) return LawSvc.toStoredResult(dataset, q, limit, localRows);

    // 2. Local miss — go to juris.ph and write through.
    const tenantId = await LawRepo.resolvePhTenantId();

    let live: Awaited<ReturnType<typeof searchJurisPh>>;
    try {
      live = await searchJurisPh(dataset, q, limit);
    } catch (err) {
      if (err instanceof JurisPhUnavailableError) {
        throw new HttpError("juris.ph is unavailable and no matching laws are stored locally", 502);
      }
      throw err;
    }

    const items = await LawSvc.storeAndAnnotate(live.items, category, tenantId);

    // Dedup hits: refresh only the relevance score.
    await Promise.all(
      items.filter((it) => !it.stored).map((it) => LawRepo.updateScore(it.id, it.score ?? null)),
    );

    return {
      items,
      meta: {
        dataset,
        query: live.meta?.query ?? q,
        limit,
        count: items.length,
        source: "juris.ph",
      },
      notice: SEARCH_NOTICE,
    };
  }

  /**
   * Facet browse (no free-text query) — local-first like search/getDocument, keyed by the
   * exact (filter + cursor):
   *   1. That page already cached (LawBrowsePage)? Serve its rows straight from the DB — no
   *      juris.ph call. (First pages age out after BROWSE_CACHE_TTL_MS; deeper pages don't.)
   *   2. Miss/stale → fetch the page from juris.ph's scroll, write every row through to Law,
   *      record the page (ids + order + next cursor), return it.
   *   3. juris.ph unreachable + a stale page exists → serve the stale page; otherwise 502.
   * Caching the page (not just running a local query) is what keeps juris.ph's ordering and
   * completeness intact — a plain local keyset query would silently skip rows we haven't
   * cached for a partially-cached year.
   */
  static async browse(params: {
    category: LawCategory;
    caseType?: JurisPhCaseType;
    topics?: JurisPhTopic[];
    year?: number;
    cursor?: string;
    limit?: number;
  }): Promise<BrowseResult> {
    const { category, caseType, topics, year } = params;
    const dataset = DATASET_BY_CATEGORY[category];
    const limit = params.limit ?? BROWSE_PAGE_SIZE;
    const cursorRaw = params.cursor ?? "";
    const cursor = params.cursor ? decodeCursor(params.cursor) : null; // also validates
    const tenantId = await LawRepo.resolvePhTenantId();

    const filterKey = browseFilterKey({ dataset, caseType, topics, year, limit });
    const pageKey = browsePageKey(filterKey, cursorRaw);

    // 1. Local first — a cached page for this exact (filter, cursor).
    const cached = await LawRepo.findBrowsePage(pageKey);
    const cachedFresh =
      !!cached && (!cached.isFirstPage || Date.now() - cached.fetchedAt.getTime() < BROWSE_CACHE_TTL_MS);
    if (cached && cachedFresh) return LawSvc.browseFromCache(dataset, limit, cached);

    // 2. Miss/stale — fetch the page from juris.ph.
    let page: Awaited<ReturnType<typeof browseJurisPh>>;
    try {
      page = await browseJurisPh({ dataset, limit, cursor, caseType, topics, year });
    } catch (err) {
      if (err instanceof JurisPhUnavailableError) {
        if (cached) return LawSvc.browseFromCache(dataset, limit, cached); // stale, still better than 502
        throw new HttpError("juris.ph is unavailable — browse can't be served offline", 502);
      }
      throw err;
    }

    const items = await LawSvc.storeAndAnnotate(page.items, category, tenantId);
    const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;

    await LawRepo.saveBrowsePage({
      pageKey,
      filterKey,
      isFirstPage: cursorRaw === "",
      jurisIds: items.map((it) => it.id),
      hasMore: nextCursor !== null,
      nextCursor,
    });

    return {
      items,
      meta: { dataset, limit, count: items.length, hasMore: nextCursor !== null },
      cursor: nextCursor,
      notice: SEARCH_NOTICE,
    };
  }

  /** Rebuild a browse page from its cached id list — rows come from Law, kept in the recorded
   * order; any id no longer stored is simply dropped. */
  private static async browseFromCache(
    dataset: JurisPhDataset,
    limit: number,
    cached: { jurisIds: string[]; hasMore: boolean; nextCursor: string | null },
  ): Promise<BrowseResult> {
    const rows = await LawRepo.findByJurisSourceIds(cached.jurisIds);
    const byId = new Map(rows.map((r) => [r.jurisSourceId, r]));
    const ordered = cached.jurisIds.map((id) => byId.get(id)).filter((r): r is LawRow => !!r);
    return {
      items: LawSvc.rowsToItems(ordered),
      meta: { dataset, limit, count: ordered.length, hasMore: cached.hasMore },
      cursor: cached.nextCursor,
      notice: SEARCH_NOTICE,
    };
  }

  /**
   * One document by juris id, for the detail page. Local-first *with detail*: a stored row
   * whose `detailFetchedAt` is set is served straight from the DB; otherwise juris.ph's
   * `retrieve` is called, the row is upserted with the full detail, and that is returned.
   *   - unknown id at juris.ph → 404
   *   - juris.ph unreachable + row exists (no detail) → the base row, `detail.fetched: false`
   *   - juris.ph unreachable + no row → 502
   */
  static async getDocument(params: { category: LawCategory; id: string }): Promise<DocumentResult> {
    const { category, id } = params;
    const dataset = DATASET_BY_CATEGORY[category];

    const existing = await LawRepo.findByJurisSourceId(id);
    if (existing && existing.detailFetchedAt) {
      return LawSvc.toDocumentResult(dataset, existing, "cache");
    }

    const tenantId = await LawRepo.resolvePhTenantId();

    let retrieved: Awaited<ReturnType<typeof retrieveJurisPh>>;
    try {
      retrieved = await retrieveJurisPh(dataset, id);
    } catch (err) {
      if (err instanceof JurisPhUnavailableError) {
        if (existing) return LawSvc.toDocumentResult(dataset, existing, "cache");
        throw new HttpError("juris.ph is unavailable and this document is not stored locally", 502);
      }
      throw err;
    }

    if (!retrieved) throw new HttpError("No such law document", 404);

    const row = await LawRepo.upsertWithDetail(
      toCreateInput(retrieved.item, category, tenantId),
      toDetailInput(retrieved.detail),
    );
    return LawSvc.toDocumentResult(dataset, row, "juris.ph");
  }

  /** A stored Law row → the detail-page response. */
  private static toDocumentResult(
    dataset: JurisPhDataset,
    row: LawRow,
    source: "juris.ph" | "cache",
  ): DocumentResult {
    return {
      item: {
        id: row.jurisSourceId,
        stored_id: row.id,
        dataset,
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

  /** Write through any juris.ph item we don't already store, then return the items annotated
   * with our row ids. Shared by search (miss path) and browse. */
  private static async storeAndAnnotate(
    raw: JurisPhItem[],
    category: LawCategory,
    tenantId: string,
  ): Promise<SearchResultItem[]> {
    const items = raw.filter((it) => it.id);
    const jurisIds = items.map((it) => it.id);

    const alreadyStored = await LawRepo.findStoredIds(jurisIds);
    const freshItems = items.filter((it) => !alreadyStored.has(it.id));
    await LawRepo.createMany(freshItems.map((it) => toCreateInput(it, category, tenantId)));

    const idByJurisId = await LawRepo.findStoredIds(jurisIds);
    return items.map((it) => ({
      ...it,
      stored_id: idByJurisId.get(it.id) ?? "",
      stored: !alreadyStored.has(it.id),
    }));
  }

  /** Stored Law rows → response items: the normalized juris item from `rawJson`, plus our row
   * id. Used wherever we serve from the DB (search local hit, browse-page cache). */
  private static rowsToItems(rows: LawRow[]): SearchResultItem[] {
    return rows.map((row) => ({
      ...((row.rawJson ?? {}) as unknown as JurisPhItem),
      stored_id: row.id,
      stored: false,
    }));
  }

  /** Shape stored rows into the search response — used for every local hit. */
  private static toStoredResult(
    dataset: JurisPhDataset,
    q: string,
    limit: number,
    rows: LawRow[],
  ): SearchResult {
    return {
      items: LawSvc.rowsToItems(rows),
      meta: { dataset, query: q, limit, count: rows.length, source: "cache" },
      notice: SEARCH_NOTICE,
    };
  }

  static async list(params: ListLawsParams) {
    const { data, total } = await LawRepo.list(params);
    return {
      data,
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    };
  }
}
