import axios from "axios";
import WebSocket from "ws";
import { CHAT_WONDER_API_URL, CHAT_WONDER_WS_URL } from "../config";
import HttpError from "./http-error";
import { SESSION_RETRIES, RETRY_DELAY_MS, LEGAL_TAG, MINDMAP_RULE, STRUCTURED_DATA_WAIT_MS } from "../constants/chatWonder.constants";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { embedText } from "./embedding";
import { parseStructuredDataPayload, MindMapItem, TimelineItem } from "./response-parser";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CaseDocumentGrounding {
  caseDocumentIds: string[];
  caseDocumentChunkIds?: string[];
}

/** Chunk ids to send Chat Wonder for a given (document, question) pair. Embeds the
 * user's question and ranks this document's chunks by cosine similarity — this is what
 * actually uses the `embedding` column each chunk was stored with. Falls back to every
 * chunk (unfiltered, chunkIndex order) if embedding/similarity search fails for any
 * reason — a degraded but still-correct result, never a broken chat turn. */
async function relevantChunkIdsFor(caseDocumentId: string, query: string): Promise<string[]> {
  try {
    const queryEmbedding = await embedText(query);
    return await DocumentChunkRepo.findRelevantByDocument(caseDocumentId, queryEmbedding);
  } catch {
    return DocumentChunkRepo.findIdsByDocument(caseDocumentId);
  }
}

function normalizeGrounding(
  grounding?: CaseDocumentGrounding | string,
): CaseDocumentGrounding | undefined {
  if (!grounding) return undefined;
  if (typeof grounding === "string") {
    return { caseDocumentIds: [grounding] };
  }
  if (!grounding.caseDocumentIds?.length) return undefined;
  return grounding;
}

export async function callChatWonderRest(
  prompt: string,
  sessionId: string,
  grounding?: CaseDocumentGrounding | string,
): Promise<{ response?: string; intermediate_response?: string; source_metadata?: unknown }> {
  const resolved = normalizeGrounding(grounding);
  const payload: {
    session_id: string;
    user_input: string;
    case_document_ids?: string[];
    case_document_chunk_ids?: string[];
  } = {
    session_id: sessionId,
    user_input: prompt,
  };
  // Lets Chat Wonder pull chunks itself via GET /api/v1/case-document/:caseDocumentId
  // instead of us inlining the full document text into the prompt. Chunk ids are ranked
  // by embedding similarity when not already provided — see relevantChunkIdsFor.
  // Always send case_document_ids (including []) so chat-wonder replaces session-scoped
  // active_case_documents instead of keeping docs from a previous case/consultation.
  payload.case_document_ids = resolved?.caseDocumentIds ?? [];
  if (resolved) {
    payload.case_document_chunk_ids =
      resolved.caseDocumentChunkIds ??
      (resolved.caseDocumentIds.length === 1
        ? await relevantChunkIdsFor(resolved.caseDocumentIds[0], prompt)
        : []);
  }

  const { data } = await axios.post(`${CHAT_WONDER_API_URL}/chat`, payload);
  return data;
}

export async function getChatWonderSessionId(): Promise<string> {
  for (let attempt = 1; attempt <= SESSION_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(`${CHAT_WONDER_API_URL}/session-id`);
      if (!data?.session_id) {
        throw new Error("Chat Wonder returned no session_id");
      }
      return data.session_id;
    } catch {
      if (attempt < SESSION_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new HttpError("Could not initialize chat session. Chat Wonder may be unreachable.", 503);
}

export interface RelatedCase {
  type: string;
  title: string | null;
  url: string | null;
  case_number: string | null;
  ra_number: string | null;
  year: unknown;
  snippet: string | null;
  relevance: number | null;
  vetted: boolean;
}

function stripLegalTag(input: string): string {
  const lower = input.toLowerCase();
  if (!lower.startsWith(LEGAL_TAG)) return input;
  return input.slice(LEGAL_TAG.length).trimStart();
}

function withLegalTag(input: string): string {
  return `${LEGAL_TAG} ${stripLegalTag(input)}`;
}

export async function generateTitleViaWs(prompt: string): Promise<string> {
  const sessionId = await getChatWonderSessionId();

  return new Promise((resolve) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let settled = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(""), 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "chat",
        user_input: prompt,
        session_id: sessionId,
        use_full_legal_chain: false,
      }));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      const msg = typeof event.data === "string" ? event.data : String(event.data);
      if (msg === "__END__" || msg.endsWith("__END__")) {
        const content = msg.endsWith("__END__") ? msg.slice(0, -"__END__".length) : "";
        if (content) accumulated += content;
        clearTimeout(timeout);
        finish(accumulated.trim());
        return;
      }
      accumulated += msg;
    };

    ws.onerror = () => { clearTimeout(timeout); finish(""); };
    ws.onclose  = () => { clearTimeout(timeout); finish(accumulated.trim()); };
  });
}

export interface ChatWonderStreamResult {
  content: string;
  /** Related cases Chat Wonder itself resolved via its own juris.ph MCP tool calls
   * (search_jurisprudence/search_republic_acts/get_case/get_republic_act), already
   * deduped and ranked server-side (vetted get_* entries outranking raw search rows —
   * see chat-wonder-v2-api's legal_citations.py::select_related_cases). Sent as a
   * dedicated [RELATED_CASES] frame; empty for non-legal-persona replies. */
  relatedCases: RelatedCase[];
  /** From Chat Wonder's post-`__END__` `[STRUCTURED_DATA]` frame (legal persona). */
  mindMap?: MindMapItem;
  timeline?: TimelineItem[];
}

export function streamChatWonderMessage(
  sessionId: string,
  userInput: string,
  onChunk: (text: string) => void,
  documentContext?: string,
  grounding?: CaseDocumentGrounding | string,
  /** Mind Map is case-only (ilovelawyer-app/CONTEXT.md) — MINDMAP_RULE is only appended to
   * user_input when this is set, so chat-wonder is never told the tag format for a general
   * (no-Case) Consultation. */
  caseId?: string,
): Promise<ChatWonderStreamResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let sourcesDropped = false;
    let settled = false;
    let relatedCases: RelatedCase[] = [];
    let structuredMindMap: MindMapItem | undefined;
    let structuredTimeline: TimelineItem[] | undefined;
    let postEndTimer: ReturnType<typeof setTimeout> | undefined;
    const resolved = normalizeGrounding(grounding);
    // Kicked off alongside the WS connect so the chunk ids are ready (or close to it) by
    // the time onopen fires, instead of waiting on this serially after the socket is up.
    // When chunk ids are already supplied (case-scoped ranking), reuse them; otherwise
    // rank a single document's chunks against userInput — see relevantChunkIdsFor.
    const chunkIdsPromise = resolved
      ? resolved.caseDocumentChunkIds !== undefined
        ? Promise.resolve(resolved.caseDocumentChunkIds)
        : resolved.caseDocumentIds.length === 1
          ? relevantChunkIdsFor(resolved.caseDocumentIds[0], userInput)
          : Promise.resolve<string[]>([])
      : Promise.resolve<string[]>([]);

    const finish = () => {
      if (settled) return;
      settled = true;
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve({
        content: accumulated,
        relatedCases,
        mindMap: structuredMindMap,
        timeline: structuredTimeline,
      });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(err);
    };

    const armPostEndWait = () => {
      if (postEndTimer) return;
      postEndTimer = setTimeout(() => finish(), STRUCTURED_DATA_WAIT_MS);
    };

    ws.onopen = () => {
      chunkIdsPromise
        .then((chunkIds) => {
          const payload: {
            type: string;
            user_input: string;
            session_id: string;
            use_full_legal_chain: boolean;
            document_context?: string;
            case_document_ids?: string[];
            case_document_chunk_ids?: string[];
          } = {
            type: "chat",
            user_input: withLegalTag(userInput) + (caseId ? MINDMAP_RULE : ""),
            session_id: sessionId,
            use_full_legal_chain: false,
          };
          if (documentContext) {
            payload.document_context = documentContext;
          }
          // Always send case_document_ids (including []) so chat-wonder replaces
          // session-scoped active_case_documents instead of keeping prior-case docs.
          // chat-wonder ChatRequest only reads the plural field — singular is ignored.
          payload.case_document_ids = resolved?.caseDocumentIds ?? [];
          if (resolved) {
            payload.case_document_chunk_ids = chunkIds;
          }
          ws.send(JSON.stringify(payload));
        })
        .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    };

    ws.onmessage = (event) => {
      if (settled) return;

      let message = typeof event.data === "string" ? event.data : String(event.data);

      // Legal persona: `__END__` unlocks the text stream, then a second LLM call
      // emits `[STRUCTURED_DATA]` (timeline + mind map) and `[DONE]` (the_server.py).
      // Closing on `__END__` used to drop the map even though /message already had text.
      if (message === "[DONE]" || message.trim() === "[DONE]") {
        finish();
        return;
      }

      const structuredIdx = message.indexOf("[STRUCTURED_DATA]");
      if (structuredIdx !== -1) {
        let payload = message.slice(structuredIdx + "[STRUCTURED_DATA]".length);
        const doneIdx = payload.indexOf("[DONE]");
        if (doneIdx !== -1) payload = payload.slice(0, doneIdx);
        const parsed = parseStructuredDataPayload(payload);
        if (parsed.mindMap) structuredMindMap = parsed.mindMap;
        if (parsed.timeline) structuredTimeline = parsed.timeline;
        if (doneIdx !== -1) finish();
        return;
      }

      if (message === "__END__") {
        armPostEndWait();
        return;
      }

      // Chat Wonder sends these as plain streamed text, not a distinct protocol frame —
      // without this check they'd be silently appended to the answer and shown to the
      // user as if the AI had said "[Error] Unknown session." Must reject, not resolve,
      // so callers can detect this and retry with a fresh session_id instead of
      // displaying it as a real response.
      if (message.startsWith("[Error]")) {
        fail(new Error(message.replace(/^\[Error\]\s*/, "")));
        return;
      }

      // Note whether this frame carries the terminator so it can still get its
      // [RELATED_CASES]/[Sources] stripped below instead of being flushed raw —
      // Chat Wonder often ships the tag and __END__ together in the final frame.
      const isFinal = message.endsWith("__END__");
      if (isFinal) message = message.slice(0, -"__END__".length);

      // Chat Wonder's own MCP-grounded related cases, sent as a dedicated frame right
      // before __END__ (see the_server.py's /chat-stream handler). Must be captured
      // before the sourcesDropped blanking below, which would otherwise silently
      // swallow it since this frame always arrives right after [Sources].
      const relatedIdx = message.indexOf("[RELATED_CASES]");
      if (relatedIdx !== -1) {
        try {
          relatedCases = JSON.parse(message.slice(relatedIdx + "[RELATED_CASES]".length));
        } catch {
          // malformed frame — leave relatedCases as whatever it was (usually [])
        }
        message = message.slice(0, relatedIdx);
      }

      if (sourcesDropped) {
        message = "";
      } else {
        const idx = message.indexOf("[Sources]");
        if (idx !== -1) {
          sourcesDropped = true;
          message = message.slice(0, idx);
        }
      }

      if (message) {
        accumulated += message;
        onChunk(message);
      }

      if (isFinal) armPostEndWait();
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      if (postEndTimer) clearTimeout(postEndTimer);
      reject(new HttpError("Chat Wonder connection error", 503));
    };

    ws.onclose = () => {
      finish();
    };
  });
}
