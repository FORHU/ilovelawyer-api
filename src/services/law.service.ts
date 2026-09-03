import { LawCategory, Prisma } from "@prisma/client";
import LawRepo, { ListLawsParams } from "../repositories/law.repository";
import HttpError from "../utils/http-error";
import {
  JurisPhDataset,
  JurisPhItem,
  JurisPhUnavailableError,
  searchJurisPh,
} from "../utils/juris-ph";

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

    const items = live.items.filter((it) => it.id);
    const jurisIds = items.map((it) => it.id);

    const alreadyStored = await LawRepo.findStoredIds(jurisIds);
    const freshItems = items.filter((it) => !alreadyStored.has(it.id));

    await LawRepo.createMany(freshItems.map((it) => toCreateInput(it, category, tenantId)));

    // Dedup hits: refresh only the relevance score.
    await Promise.all(
      items
        .filter((it) => alreadyStored.has(it.id))
        .map((it) => LawRepo.updateScore(it.id, it.score ?? null)),
    );

    // Re-read so newly inserted rows also have an id to hand back.
    const idByJurisId = await LawRepo.findStoredIds(jurisIds);

    return {
      items: items.map((it) => ({
        ...it,
        stored_id: idByJurisId.get(it.id) ?? "",
        stored: !alreadyStored.has(it.id),
      })),
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

  /** Shape stored rows into the search response — used for every local hit. */
  private static toStoredResult(
    dataset: JurisPhDataset,
    q: string,
    limit: number,
    rows: Awaited<ReturnType<typeof LawRepo.localSearch>>,
  ): SearchResult {
    return {
      items: rows.map((row) => ({
        ...((row.rawJson ?? {}) as unknown as JurisPhItem),
        stored_id: row.id,
        stored: false,
      })),
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
