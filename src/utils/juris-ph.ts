import { JURIS_PH_API_URL } from "../config";
import HttpError from "./http-error";

// ── juris.ph public API ──────────────────────────────────────────────────────
// One base (JURIS_PH_API_URL, e.g. https://juris.ph/api). This module appends the segment:
//   search   — GET  {base}/v1/search?dataset=<jurisprudence|republic-acts>&q=&limit=
//   browse   — POST {base}/qdrant/<collection>/scroll     (Qdrant scroll proxy)
//   retrieve — POST {base}/qdrant/<collection>/retrieve   (get points by id)
// <collection> is `juris-decisions` (jurisprudence) | `republic-acts`. All public, no auth.

export type JurisPhDataset = "jurisprudence" | "republic-acts";

const COLLECTION_BY_DATASET: Record<JurisPhDataset, string> = {
  jurisprudence: "juris-decisions",
  "republic-acts": "republic-acts",
};

const searchUrl = () => `${JURIS_PH_API_URL}/v1/search`;
const qdrantUrl = (collection: string, op: "scroll" | "retrieve") =>
  `${JURIS_PH_API_URL}/qdrant/${collection}/${op}`;

/** A single search hit. Fields are dataset-dependent — `case_*` for jurisprudence,
 * `ra_number`/`summary` for republic-acts — so everything past the shared core is optional. */
export interface JurisPhItem {
  id: string;
  score?: number;
  year?: number | null;
  tags?: string[];
  url: string;
  pdf_url?: string | null;
  source_url?: string | null;

  // jurisprudence
  case_number?: string;
  case_title?: string;
  case_type?: string;
  division?: string;
  ponente?: string;
  decision_date?: string;
  facts?: string;
  disposition?: string;
  legal_rules_cited?: string[];

  // republic-acts
  ra_number?: string;
  title?: string;
  summary?: string;
}

/** The fuller `retrieve` payload — everything the browse/search item shape drops. Dataset-
 * dependent: `sections`/`key_provisions` are republic-acts, the rest jurisprudence. */
export interface JurisPhDetail {
  keywords: string[];
  // republic-acts
  sections: { title?: string; summary?: string }[] | null;
  key_provisions: string[];
  date_enacted: string | null;
  legislative_agenda_purpose: string | null;
  affected_laws_amendments: string | null;
  principal_authors: string | null;
  co_authors: string | null;
  // jurisprudence
  procedural_history: string | null;
  court_reasoning: string | null;
  legal_issues: string[];
  parties: unknown[] | null;
  judges: unknown[] | null;
  sanctions_and_penalties: unknown[] | null;
  related_cases_cited: string[];
  cited_gr_numbers: string[];
  cited_ra_numbers: string[];
}

export interface JurisPhSearchResponse {
  items: JurisPhItem[];
  meta: {
    dataset: JurisPhDataset;
    query: string;
    year: number | null;
    limit: number;
    count: number;
  };
  notice: string;
}

/** Thrown when juris.ph is unreachable (network error, timeout, 5xx, or 429) — the signal
 * for callers to fall back to our own stored rows. A 4xx (other than 429) is a
 * caller/programming error and surfaces as a normal HttpError instead. */
export class JurisPhUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JurisPhUnavailableError";
  }
}

const TIMEOUT_MS = 10_000;

/** Shared POST to a juris.ph endpoint — network/5xx/429 → JurisPhUnavailableError,
 * other non-2xx → HttpError(502), unreadable body → JurisPhUnavailableError. */
async function postJurisPh(url: string, body: unknown, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new JurisPhUnavailableError(err instanceof Error ? err.message : `juris.ph ${label} request failed`);
  }

  if (res.status >= 500 || res.status === 429) {
    throw new JurisPhUnavailableError(`juris.ph responded ${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(`juris.ph rejected the ${label} request (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`, 502);
  }

  const data = await res.json().catch(() => null);
  if (data == null) throw new JurisPhUnavailableError(`juris.ph returned an unreadable ${label} payload`);
  return data;
}

export async function searchJurisPh(
  dataset: JurisPhDataset,
  q: string,
  limit: number,
): Promise<JurisPhSearchResponse> {
  const url = `${searchUrl()}?dataset=${encodeURIComponent(dataset)}&q=${encodeURIComponent(q)}&limit=${limit}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // fetch throws on DNS/connection failure and on AbortSignal timeout.
    throw new JurisPhUnavailableError(err instanceof Error ? err.message : "juris.ph request failed");
  }

  if (res.status >= 500 || res.status === 429) {
    throw new JurisPhUnavailableError(`juris.ph responded ${res.status}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(`juris.ph rejected the request (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`, 502);
  }

  const data = (await res.json().catch(() => null)) as JurisPhSearchResponse | null;
  if (!data || !Array.isArray(data.items)) {
    throw new JurisPhUnavailableError("juris.ph returned an unreadable payload");
  }
  return data;
}

// ── browse (Qdrant scroll proxy) ─────────────────────────────────────────────
// juris.ph orders these by `year desc`, which disables Qdrant's own `next_page_offset`, so
// paging is a year keyset: the caller tracks `{ lastYear, seenIds }` and the next request
// sends `order_by.start_from = lastYear` plus `must_not: [{ has_id: seenIds }]` to skip rows
// already shown at the boundary year.

/** The two facet vocabularies juris.ph exposes on its browse pages — mirror them exactly so
 * a value we accept is a value juris.ph will actually match. `caseType` is jurisprudence-only. */
export const JURIS_PH_CASE_TYPES = [
  "Criminal",
  "Civil",
  "Administrative",
  "Labor",
  "Constitutional",
  "Commercial",
] as const;

export const JURIS_PH_TOPICS = [
  "criminal",
  "civil",
  "labor",
  "constitutional",
  "administrative",
  "taxation",
  "family",
  "election",
  "environmental",
  "corporate",
] as const;

export type JurisPhCaseType = (typeof JURIS_PH_CASE_TYPES)[number];
export type JurisPhTopic = (typeof JURIS_PH_TOPICS)[number];

/** Opaque-to-the-client keyset cursor. `lastYear` is the year of the last row of the previous
 * page; `seenIds` are every row id already returned at that year (juris.ph's `oK` logic). */
export interface JurisPhBrowseCursor {
  lastYear: number;
  seenIds: string[];
}

export interface JurisPhBrowseParams {
  dataset: JurisPhDataset;
  limit: number;
  cursor: JurisPhBrowseCursor | null;
  caseType?: JurisPhCaseType;
  topics?: JurisPhTopic[];
  year?: number;
}

export interface JurisPhBrowseResult {
  items: JurisPhItem[];
  /** Cursor for the next page, or null when juris.ph returned a short page (end of results). */
  nextCursor: JurisPhBrowseCursor | null;
}

/** One selected topic → an OR group matching the tag (either case) or the embedding text —
 * copied verbatim from juris.ph's own `aK`, since the payload `tags` are freeform title-case
 * phrases and only the `embedding_text` clause reliably matches a bare topic word. */
function topicClause(topic: string) {
  return {
    should: [
      { key: "tags", match: { value: topic } },
      { key: "tags", match: { value: topic.charAt(0).toUpperCase() + topic.slice(1) } },
      { key: "embedding_text", match: { text: topic } },
    ],
  };
}

interface QdrantPoint {
  id: string;
  payload: Record<string, unknown> | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function jsonArr(v: unknown): unknown[] | null {
  return Array.isArray(v) && v.length > 0 ? v : null;
}

/** juris.ph's raw Qdrant payload → the same normalized JurisPhItem shape `/api/v1/search`
 * returns, so write-through (toCreateInput) and the frontend need no browse-specific branch. */
function pointToItem(dataset: JurisPhDataset, point: QdrantPoint): JurisPhItem {
  const p = point.payload ?? {};
  const year = typeof p.year === "number" ? p.year : null;

  if (dataset === "jurisprudence") {
    const rules = Array.isArray(p.legal_rules_cited)
      ? p.legal_rules_cited
          .map((r) => (typeof r === "string" ? r : str((r as Record<string, unknown>)?.citation)))
          .filter((r): r is string => !!r)
      : [];
    return {
      id: point.id,
      year,
      tags: strArr(p.tags),
      url: `https://juris.ph/case/${point.id}`,
      pdf_url: str(p.source_pdf_url) ?? null,
      source_url: str(p.source_url) ?? null,
      case_number: str(p.case_number),
      case_title: str(p.case_title),
      case_type: str(p.case_type),
      division: str(p.division),
      ponente: str(p.ponente),
      decision_date: str(p.decision_date_iso),
      facts: str(p.factual_background),
      disposition: str(p.final_disposition),
      legal_rules_cited: rules,
    };
  }

  return {
    id: point.id,
    year,
    tags: strArr(p.tags),
    url: `https://juris.ph/republic-act/${point.id}`,
    pdf_url: null,
    source_url: null,
    ra_number: str(p.ra_bill_number),
    title: str(p.title),
    summary: str(p.summary),
  };
}

/** Raw Qdrant payload → the typed detail fields. Fields absent for a dataset stay null/[]. */
function pointToDetail(dataset: JurisPhDataset, payload: Record<string, unknown>): JurisPhDetail {
  const p = payload;
  return {
    keywords: strArr(p.keywords),
    sections: dataset === "republic-acts" ? (jsonArr(p.sections) as JurisPhDetail["sections"]) : null,
    key_provisions: strArr(p.key_provisions),
    date_enacted: str(p.date_enacted) ?? null,
    legislative_agenda_purpose: str(p.legislative_agenda_purpose) ?? null,
    affected_laws_amendments: str(p.affected_laws_amendments) ?? null,
    principal_authors: str(p.principal_authors) ?? null,
    co_authors: str(p.co_authors) ?? null,
    procedural_history: str(p.procedural_history) ?? null,
    court_reasoning: str(p.court_reasoning) ?? null,
    legal_issues: strArr(p.legal_issues),
    parties: jsonArr(p.parties),
    judges: jsonArr(p.judges),
    sanctions_and_penalties: jsonArr(p.sanctions_and_penalties),
    related_cases_cited: strArr(p.related_cases_cited),
    cited_gr_numbers: strArr(p.cited_gr_numbers),
    cited_ra_numbers: strArr(p.cited_ra_numbers),
  };
}

/** Next keyset cursor, matching juris.ph's `oK`: null when the page was short (no more rows);
 * otherwise the last row's year plus every id seen at that year (carried across pages). */
function nextCursor(
  items: JurisPhItem[],
  limit: number,
  prev: JurisPhBrowseCursor | null,
): JurisPhBrowseCursor | null {
  if (items.length < limit) return null;
  const lastYear = items[items.length - 1]?.year;
  if (typeof lastYear !== "number") return null;
  const carried = prev && prev.lastYear === lastYear ? prev.seenIds : [];
  const atYear = items.filter((it) => it.year === lastYear).map((it) => it.id);
  return { lastYear, seenIds: [...carried, ...atYear] };
}

export async function browseJurisPh(params: JurisPhBrowseParams): Promise<JurisPhBrowseResult> {
  const { dataset, limit, cursor, caseType, topics, year } = params;
  const collection = COLLECTION_BY_DATASET[dataset];

  const must: unknown[] = [];
  if (typeof year === "number") must.push({ key: "year", match: { value: year } });
  if (caseType && dataset === "jurisprudence") must.push({ key: "case_type", match: { value: caseType } });
  for (const topic of topics ?? []) must.push(topicClause(topic));

  const filter: Record<string, unknown> = {};
  if (must.length > 0) filter.must = must;
  if (cursor && cursor.seenIds.length > 0) filter.must_not = [{ has_id: cursor.seenIds }];

  const body = {
    limit,
    with_payload: true,
    order_by: {
      key: "year",
      direction: "desc",
      ...(cursor ? { start_from: cursor.lastYear } : {}),
    },
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  };

  const data = (await postJurisPh(qdrantUrl(collection, "scroll"), body, "browse")) as {
    result?: { points?: QdrantPoint[] };
  };
  const points = data?.result?.points;
  if (!Array.isArray(points)) {
    throw new JurisPhUnavailableError("juris.ph returned an unreadable browse payload");
  }

  const items = points.filter((pt) => pt && pt.id).map((pt) => pointToItem(dataset, pt));
  return { items, nextCursor: nextCursor(items, limit, cursor) };
}

/** Fetch one document's full payload by juris id. Returns null when juris.ph has no such
 * point (unknown id) — the caller decides whether that's a 404. */
export async function retrieveJurisPh(
  dataset: JurisPhDataset,
  id: string,
): Promise<{ item: JurisPhItem; detail: JurisPhDetail } | null> {
  const collection = COLLECTION_BY_DATASET[dataset];
  const data = (await postJurisPh(
    qdrantUrl(collection, "retrieve"),
    { ids: [id], with_payload: true, with_vector: false },
    "retrieve",
  )) as { result?: QdrantPoint[] };

  const point = Array.isArray(data?.result) ? data.result[0] : undefined;
  if (!point || !point.id) return null;

  return { item: pointToItem(dataset, point), detail: pointToDetail(dataset, point.payload ?? {}) };
}
