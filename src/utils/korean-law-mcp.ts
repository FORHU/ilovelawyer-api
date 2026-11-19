import { KOREAN_LAW_MCP_API_KEY, KOREAN_LAW_MCP_URL } from "../config";
import HttpError from "./http-error";

// ── Korean Law MCP (mcp.gomdori.app/law) ─────────────────────────────────────
// Stateless JSON-RPC 2.0 over HTTP, like the UK Legal MCP (uk-legal-mcp.ts). Unlike it, every tool
// answers with one plain Korean text blob — no structuredContent, no JSON — so the KR Library
// parses that text (legal/law-source/kr/kr-law-parsers.ts). chat-wonder-v2-api's legal_kr persona
// calls the same server for the AI chat.

/** The MCP is unreachable (network error, timeout, 429/5xx) or answered with a JSON-RPC error:
 * the caller serves what it has stored, else 502. */
export class KoreanLawMcpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KoreanLawMcpUnavailableError";
  }
}

/** Statute full-text fills run several of these one after another, so keep each short. */
const TIMEOUT_MS = 20_000;
let requestId = 0;

/** A tool's answer text when it found nothing: `[NOT_FOUND] …`. Not an error — an empty result. */
export function isNotFound(text: string): boolean {
  return /^\s*\[NOT_FOUND\]/.test(text);
}

/** Calls one tool and returns its text. A `[NOT_FOUND]` answer comes back as text (see
 * isNotFound); any other `[CODE]` answer (bad parameters, upstream failure) is an error. */
export async function callKoreanLawTool(name: string, args: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(KOREAN_LAW_MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(KOREAN_LAW_MCP_API_KEY ? { apikey: KOREAN_LAW_MCP_API_KEY } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new KoreanLawMcpUnavailableError(err instanceof Error ? err.message : `Korean Law MCP ${name} request failed`);
  }
  if (res.status >= 500 || res.status === 429) throw new KoreanLawMcpUnavailableError(`Korean Law MCP responded ${res.status}`);
  if (!res.ok) throw new HttpError(`Korean Law MCP rejected the ${name} request (${res.status})`, 502);

  const payload = parsePayload(await res.text().catch(() => ""));
  if (!payload) throw new KoreanLawMcpUnavailableError(`Korean Law MCP returned an unreadable ${name} payload`);
  if (payload.error) throw new KoreanLawMcpUnavailableError(`Korean Law MCP ${name} error: ${payload.error.message ?? "unknown"}`);

  const content: { text?: unknown }[] = payload.result?.content ?? [];
  const text = content.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
  if (isNotFound(text)) return text;
  const failure = text.match(/^\s*\[([A-Z_]+)\]\s*(.*)/);
  if (payload.result?.isError || failure) {
    const code = failure?.[1] ?? "TOOL_ERROR";
    // Our own bad arguments are a bug here, not the caller's input: a 502 with the tool's reason.
    if (code === "INVALID_PARAMETER") throw new HttpError(`Korean Law MCP refused ${name}: ${failure?.[2] ?? ""}`.trim(), 502);
    throw new KoreanLawMcpUnavailableError(`Korean Law MCP ${name} failed: ${code}`);
  }
  return text;
}

/** The body is either plain JSON or a server-sent event stream with the JSON in a `data:` line. */
function parsePayload(body: string): { result?: { content?: { text?: unknown }[]; isError?: boolean }; error?: { message?: string } } | null {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
