import { UK_LEGAL_MCP_URL } from "../config";
import HttpError from "./http-error";

// ── UK Legal MCP (uk-legal-mcp.fly.dev) ──────────────────────────────────────
// Stateless JSON-RPC 2.0 over HTTP — `tools/call` works without a session handshake, no auth
// (see ADR-0003 in chat-wonder-v2-api, which already calls this same public server from the AI
// chat's tool loop; this is a separate, direct integration for the Citation Map).

/** Thrown when the MCP is unreachable (network error, timeout, 5xx) or returns a JSON-RPC
 * error — the signal for callers to treat a citation as unresolved rather than failing outright. */
export class UkLegalMcpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UkLegalMcpUnavailableError";
  }
}

const TIMEOUT_MS = 10_000;
let requestId = 0;

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(UK_LEGAL_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new UkLegalMcpUnavailableError(err instanceof Error ? err.message : `UK Legal MCP ${name} request failed`);
  }

  if (res.status >= 500 || res.status === 429) {
    throw new UkLegalMcpUnavailableError(`UK Legal MCP responded ${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(`UK Legal MCP rejected the ${name} request (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`, 502);
  }

  const payload = await res.json().catch(() => null);
  if (payload == null) throw new UkLegalMcpUnavailableError(`UK Legal MCP returned an unreadable ${name} payload`);
  if (payload.error) throw new UkLegalMcpUnavailableError(`UK Legal MCP ${name} error: ${payload.error.message ?? "unknown"}`);

  const result = payload.result ?? {};
  const text: unknown = result.content?.[0]?.text;

  // A tool-level failure — the MCP returns HTTP 200 with `result.isError: true` and a
  // human-readable `content[0].text` like `Internal error: {"error_category": "...", ...}`
  // (NOT JSON), so this must be checked before the text-JSON fallback below or JSON.parse
  // throws a bare SyntaxError that escapes as a 500.
  if (result.isError) {
    throw mcpToolError(name, typeof text === "string" ? text : "");
  }

  const structured = result.structuredContent;
  if (structured !== undefined) return structured as T;

  // Fallback for a server that only returns the text-content form — content[0].text is itself
  // a JSON string (mirrors the Python client's unwrap_tool_result).
  if (typeof text === "string") {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UkLegalMcpUnavailableError(`UK Legal MCP ${name} returned an unparseable payload`);
    }
  }
  throw new UkLegalMcpUnavailableError(`UK Legal MCP ${name} returned no usable content`);
}

/** Turns the MCP's `Internal error: {json}` tool-failure text into a typed error. A `validation`
 * category (e.g. a court slug TNA's atom feed doesn't accept) is the caller's bad input -> 400;
 * `not_found` -> 404; anything else is treated as a transient upstream problem so callers fall
 * back to stored rows the same way they do for a network failure. */
function mcpToolError(name: string, rawText: string): Error {
  const jsonStart = rawText.indexOf("{");
  let category: string | undefined;
  let description: string | undefined;
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(rawText.slice(jsonStart)) as {
        error_category?: string;
        description?: string;
      };
      category = parsed.error_category;
      description = parsed.description;
    } catch {
      /* fall through to the generic message */
    }
  }
  const message = description || rawText || `UK Legal MCP ${name} failed`;
  if (category === "validation") return new HttpError(`UK Legal MCP ${name}: ${message}`, 400);
  if (category === "not_found") return new HttpError(`UK Legal MCP ${name}: ${message}`, 404);
  return new UkLegalMcpUnavailableError(`UK Legal MCP ${name} error: ${message}`);
}

export interface UkCitationsNetworkResult {
  case_uri: string;
  neutral_citations: string[];
  legislation_refs: string[];
  si_refs: string[];
  eu_refs: string[];
  law_report_refs: string[];
  total_citations: number;
}

/** Every citation a UK judgment makes, grouped by type — no LLM extraction needed, this is a
 * real, structured answer from the MCP itself. */
export async function getCitationsNetwork(caseUri: string): Promise<UkCitationsNetworkResult> {
  return callTool<UkCitationsNetworkResult>("citations_network", { case_uri: caseUri });
}

export interface UkResolvedCitation {
  raw: string;
  type: string;
  year: number | null;
  court: string | null;
  number: number | null;
  report_series: string | null;
  volume: number | null;
  page: number | null;
  legislation_title: string | null;
  section: string | null;
  si_year: number | null;
  si_number: number | null;
  /** Null for a neutral citation TNA couldn't find, or for a citation type TNA doesn't cover
   * (e.g. a pre-2001 law report) — never fabricated. */
  resolved_url: string | null;
  confidence: number;
}

/** Parses and live-verifies a single OSCOLA citation against The National Archives. */
export async function resolveUkCitation(citation: string): Promise<UkResolvedCitation> {
  return callTool<UkResolvedCitation>("citations_resolve", { citation });
}

export interface UkJudgmentGrepHit {
  eId: string;
  snippet: string;
  match: string;
}

export interface UkJudgmentGrepResult {
  slug: string;
  pattern: string;
  hits: UkJudgmentGrepHit[];
  truncated: boolean;
}

/** Searches within one judgment's actual text for a pattern — real pinpoint citations (eId
 * like "para_4"), not a guess. Used to auto-detect which paragraph a quoted passage lives in;
 * a quote that doesn't match verbatim (paraphrased slightly, or from a source the judgment
 * doesn't cover) simply returns no hits rather than a wrong pinpoint. */
export async function grepJudgment(slug: string, pattern: string, maxHits = 3): Promise<UkJudgmentGrepResult> {
  return callTool<UkJudgmentGrepResult>("case_law_grep_judgment", { slug, pattern, max_hits: maxHits });
}

// ── Library: search + detail tools (see legal/law-source/uk) ─────────────────

export interface UkCaseLawSearchHit {
  /** TNA judgment slug, e.g. "uksc/2024/12" — the id for judgment_get_* and citations_network. */
  uri: string;
  title: string;
  /** Full court name, e.g. "United Kingdom Supreme Court" (not the slug). */
  court: string | null;
  published: string | null;
  updated: string | null;
  identifiers: { type: string; value: string; slug?: string }[];
  xml_url: string | null;
  pdf_url: string | null;
}

export interface UkCaseLawSearchResult {
  results: UkCaseLawSearchHit[];
  page: number;
  has_more: boolean;
}

/** Full-text UK case-law search via TNA Find Case Law. `query: "*"` acts as match-all (used for
 * court-filtered browse). `court` is a slug like "uksc" / "ewca/civ"; `page` is 1-indexed. */
export async function caseLawSearch(args: {
  query: string;
  court?: string;
  page?: number;
  limit?: number;
}): Promise<UkCaseLawSearchResult> {
  return callTool<UkCaseLawSearchResult>("case_law_search", {
    query: args.query,
    ...(args.court ? { court: args.court } : {}),
    ...(args.page ? { page: args.page } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  });
}

export interface UkLegislationSearchHit {
  title: string;
  /** legislation.gov.uk type code, e.g. "ukpga", "uksi". */
  type: string;
  year: number | null;
  number: number | null;
  score: number | null;
  /** Canonical legislation.gov.uk URL. */
  url: string;
}

export interface UkLegislationSearchResult {
  results: UkLegislationSearchHit[];
  total: number;
}

/** Title search over UK Acts & SIs (legislation.gov.uk). No pagination upstream — `limit` caps
 * at 50. `type`/`year` are exact-match filters. */
export async function legislationSearch(args: {
  query: string;
  type?: string;
  year?: number;
  limit?: number;
}): Promise<UkLegislationSearchResult> {
  return callTool<UkLegislationSearchResult>("legislation_search", {
    query: args.query,
    ...(args.type ? { type: args.type } : {}),
    ...(typeof args.year === "number" ? { year: args.year } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  });
}

export interface UkJudgmentIndexResult {
  paragraphs: { eId: string; preview: string }[];
}

/** Paragraph navigation index for one judgment — `{ eId, preview }` per paragraph. */
export async function judgmentGetIndex(slug: string): Promise<UkJudgmentIndexResult> {
  return callTool<UkJudgmentIndexResult>("judgment_get_index", { slug });
}

export interface UkLegislationTocResult {
  type: string;
  year: number;
  number: number;
  offset: number;
  limit: number;
  returned: number;
  total_items: number;
  has_more: boolean;
  /** Flat "id: title" strings, e.g. "part-1: Preliminary". */
  items: string[];
}

/** Structural table of contents for a UK Act or SI. Paginated via `offset`/`limit`. */
export async function legislationGetToc(args: {
  type: string;
  year: number;
  number: number;
  offset?: number;
  limit?: number;
}): Promise<UkLegislationTocResult> {
  return callTool<UkLegislationTocResult>("legislation_get_toc", {
    type: args.type,
    year: args.year,
    number: args.number,
    ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
  });
}

export interface UkLegislationSectionResult {
  title: string | null;
  section_number: string | null;
  content: string;
  content_truncated: boolean;
  in_force: boolean | null;
  extent: string[];
  version_date: string | null;
}

/** Parsed text of one section of a UK Act or SI, with territorial extent + in-force status.
 * `section` is a bare id ("1", "part-1", "part-2-chapter-1"), not "section-1". */
export async function legislationGetSection(args: {
  type: string;
  year: number;
  number: number;
  section: string;
  maxChars?: number;
}): Promise<UkLegislationSectionResult> {
  return callTool<UkLegislationSectionResult>("legislation_get_section", {
    type: args.type,
    year: args.year,
    number: args.number,
    section: args.section,
    ...(typeof args.maxChars === "number" ? { max_chars: args.maxChars } : {}),
  });
}
