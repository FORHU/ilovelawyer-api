import { JURIS_PH_API_URL } from "../config";
import HttpError from "./http-error";

// ── juris.ph search API ──────────────────────────────────────────────────────
// GET {JURIS_PH_API_URL}/search?dataset=<jurisprudence|republic-acts>&q=<term>&limit=<n>
// Public, no auth. The two datasets return different item shapes (see JurisPhItem).

export type JurisPhDataset = "jurisprudence" | "republic-acts";

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
 * for LawSvc.search to fall back to our own stored rows. A 4xx (other than 429) is a
 * caller/programming error and surfaces as a normal HttpError instead. */
export class JurisPhUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JurisPhUnavailableError";
  }
}

const TIMEOUT_MS = 10_000;

export async function searchJurisPh(
  dataset: JurisPhDataset,
  q: string,
  limit: number,
): Promise<JurisPhSearchResponse> {
  const url = `${JURIS_PH_API_URL}/search?dataset=${encodeURIComponent(dataset)}&q=${encodeURIComponent(q)}&limit=${limit}`;

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
