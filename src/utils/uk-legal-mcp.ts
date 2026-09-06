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

  const structured = payload.result?.structuredContent;
  if (structured !== undefined) return structured as T;

  // Fallback for a server that only returns the text-content form — content[0].text is itself
  // a JSON string (mirrors the Python client's unwrap_tool_result).
  const text = payload.result?.content?.[0]?.text;
  if (typeof text === "string") {
    const parsed = JSON.parse(text) as T;
    return parsed;
  }
  throw new UkLegalMcpUnavailableError(`UK Legal MCP ${name} returned no usable content`);
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
