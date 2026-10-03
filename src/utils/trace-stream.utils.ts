/** Event types chat-wonder's scoped trace stream may carry for a customer. Mirrors its own
 * allowlist (_USER_TRACE_TYPES in the_server.py) on purpose: this side re-checks, so an older or
 * misconfigured chat-wonder that streams something more can never reach the log. */
export const USER_TRACE_TYPES: ReadonlySet<string> = new Set([
  "request",
  "cognition",
  "action",
  "retrieval",
  "control",
  "memory",
]);

/** Longest summary stored. Chat-wonder's summaries run to a few paragraphs at most; this only
 * bounds a runaway one. */
export const MAX_TRACE_SUMMARY_CHARS = 4000;

/** Incremental parser for a `text/event-stream` body. Network chunks do not respect event
 * boundaries, so a half-received event is held until the rest arrives. Only `data:` fields are
 * kept (chat-wonder sends nothing else); one event's several data lines join with "\n". */
export class SseParser {
  private buffer = "";

  /** Feeds one chunk, returns the payload of each event it completed. */
  feed(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const payloads: string[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) payloads.push(data);
      boundary = this.buffer.indexOf("\n\n");
    }
    return payloads;
  }
}

export interface ParsedTraceEvent {
  type: string;
  summary: string;
  createdAt: Date;
}

export type ParsedStreamPayload = { kind: "connected" } | { kind: "event"; event: ParsedTraceEvent } | { kind: "ignore" };

/** Classifies one SSE payload from the scoped stream. An event is kept only when it is stamped
 * with exactly this turn's id: sessions are shared between collaborators, so an event for another
 * turn on the same session (or from a chat-wonder build that does not stamp turns) is not ours to
 * attribute to this user, and is dropped rather than guessed at. */
export function parseStreamPayload(raw: string, turnId: string): ParsedStreamPayload {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (!payload || typeof payload !== "object") return { kind: "ignore" };
  if (payload.type === "connected") return { kind: "connected" };
  if (payload.turn_id !== turnId) return { kind: "ignore" };
  if (typeof payload.type !== "string" || !USER_TRACE_TYPES.has(payload.type)) return { kind: "ignore" };
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (!summary) return { kind: "ignore" };
  const ts = typeof payload.ts === "number" && Number.isFinite(payload.ts) ? new Date(payload.ts * 1000) : new Date();
  return {
    kind: "event",
    event: { type: payload.type, summary: summary.slice(0, MAX_TRACE_SUMMARY_CHARS), createdAt: ts },
  };
}

const PROMPT_TITLE_MAX_CHARS = 80;

/** One-line label for a turn in the pane's pager: the question the user asked, flattened and cut.
 * Falls back to a numbered label when the message is gone or blank. */
export function promptTitle(content: string | undefined | null, turnNumber: number): string {
  const flat = (content ?? "")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return `Turn ${turnNumber}`;
  return flat.length > PROMPT_TITLE_MAX_CHARS ? `${flat.slice(0, PROMPT_TITLE_MAX_CHARS - 1).trimEnd()}…` : flat;
}
