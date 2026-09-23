import axios from "axios";
import WebSocket from "ws";
import { CHAT_WONDER_API_URL, CHAT_WONDER_WS_URL } from "../config";
import HttpError from "./http-error";
import logger from "./logger";
import { TenantCode } from "../types/tenant-code";
import {
  SESSION_RETRIES,
  RETRY_DELAY_MS,
  LEGAL_TAG,
  LEGAL_TAG_UK,
  MINDMAP_RULE,
  STRUCTURED_DATA_WAIT_MS,
  CHAT_WONDER_SESSION_TIMEOUT_MS,
  CHAT_WONDER_REST_TIMEOUT_MS,
  CASE_FULL_TEXT_INLINE_CHARS,
  OMIT_EMBEDDING_RANKING,
} from "../constants";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DocumentRepo from "../repositories/document.repository";
import { registerTurnDocuments } from "../services/case-document-callback-scope.service";
import { embedText } from "./embedding";
import {
  parseStructuredDataPayload,
  parseAudioOverviewPayload,
  parseReasoningPayload,
  parseDecisionsPayload,
  parseTraceFrame,
  MindMapItem,
  TimelineItem,
  AudioOverviewTurn,
  ReasoningExplanation,
  DecisionRecordsPayload,
  TraceStep,
} from "./response-parser";

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

/** Every attached document's id/name/category, regardless of whether its chunks were selected
 * into this turn's context — see docs/adr/0005. Lets chat-wonder-v2-api tell the model an
 * exhibit exists (and fetch it on demand via get_case_document) even when it didn't make the
 * relevance/budget cut. Best-effort: a lookup failure returns [] rather than failing the turn. */
async function manifestFor(caseDocumentIds: string[]): Promise<{ id: string; name: string; category: string | null }[]> {
  if (!caseDocumentIds.length) return [];
  try {
    const docs = await DocumentRepo.findManifestByIds(caseDocumentIds);
    return docs.map((d) => ({ id: d.id, name: d.name, category: d.category ?? null }));
  } catch (err) {
    logger.warn("Chat Wonder case document manifest lookup failed", { err });
    return [];
  }
}

/** Every attached document's full text when the whole case fits CASE_FULL_TEXT_INLINE_CHARS,
 * else [] (chat-wonder then relies on the manifest + on-demand get_case_document as before).
 * Best-effort like manifestFor: a lookup failure returns []. */
export async function fullTextsFor(
  caseDocumentIds: string[],
  manifest: { id: string; name: string; category: string | null }[],
): Promise<{ id: string; name: string; text: string }[]> {
  if (!caseDocumentIds.length) return [];
  try {
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(caseDocumentIds);
    let total = 0;
    for (const t of texts.values()) total += t.length;
    if (total === 0 || total > CASE_FULL_TEXT_INLINE_CHARS) {
      logger.info("Chat Wonder case documents not inlined whole", { documents: texts.size, chars: total, limit: CASE_FULL_TEXT_INLINE_CHARS });
      return [];
    }
    const names = new Map(manifest.map((m) => [m.id, m.name]));
    return caseDocumentIds
      .filter((id) => texts.has(id))
      .map((id) => ({ id, name: names.get(id) ?? "", text: texts.get(id) as string }));
  } catch (err) {
    logger.warn("Chat Wonder case document full-text lookup failed", { err });
    return [];
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
  // Routes to chat-wonder-v2-api's `legal_uk` persona (its own UK tool whitelist and prompt)
  // instead of the PH-only default — see the_server.py::process_persona.
  tenantCode?: TenantCode,
): Promise<{ response?: string; intermediate_response?: string; source_metadata?: unknown }> {
  const resolved = normalizeGrounding(grounding);
  const payload: {
    session_id: string;
    user_input: string;
    case_document_ids?: string[];
    case_document_chunk_ids?: string[];
    case_document_manifest?: { id: string; name: string; category: string | null }[];
    // Wire field name is `jurisdiction` — chat-wonder-v2-api's own contract (the_server.py::
    // process_persona), unrelated to our internal TenantCode rename.
    jurisdiction?: TenantCode;
  } = {
    session_id: sessionId,
    user_input: prompt,
  };
  if (tenantCode) payload.jurisdiction = tenantCode;
  // Lets Chat Wonder pull chunks itself via GET /api/v1/case-document/:caseDocumentId
  // instead of us inlining the full document text into the prompt. Chunk ids are ranked
  // by embedding similarity when not already provided — see relevantChunkIdsFor.
  // Always send case_document_ids (including []) so chat-wonder replaces session-scoped
  // active_case_documents instead of keeping docs from a previous case/consultation.
  payload.case_document_ids = resolved?.caseDocumentIds ?? [];
  // Chat Wonder reads these back through GET /api/v1/case-document/:id - remember exactly which
  // ids we handed it, so that callback can refuse any other id (case-document-callback-scope).
  await registerTurnDocuments(payload.case_document_ids);
  if (resolved) {
    const chunkIds = OMIT_EMBEDDING_RANKING
      ? []
      : resolved.caseDocumentChunkIds ??
        (resolved.caseDocumentIds.length === 1
          ? await relevantChunkIdsFor(resolved.caseDocumentIds[0], prompt)
          : []);
    if (chunkIds.length) payload.case_document_chunk_ids = chunkIds;
    payload.case_document_manifest = await manifestFor(resolved.caseDocumentIds);
  }

  logger.info("Chat Wonder REST payload", { url: `${CHAT_WONDER_API_URL}/chat`, ...payload });
  const { data } = await axios.post(`${CHAT_WONDER_API_URL}/chat`, payload, {
    timeout: CHAT_WONDER_REST_TIMEOUT_MS,
  });
  if (data?.usage) logger.info("Chat Wonder usage", data.usage);
  return data;
}

export async function getChatWonderSessionId(): Promise<string> {
  for (let attempt = 1; attempt <= SESSION_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(`${CHAT_WONDER_API_URL}/session-id`, {
        timeout: CHAT_WONDER_SESSION_TIMEOUT_MS,
      });
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

/** AI-assigned category for an uploaded case document — a short, free-form label Chat
 * Wonder picks itself (no fixed taxonomy, never user-supplied). Best-effort: any failure
 * (Chat Wonder unreachable, malformed response) returns null rather than throwing, so a
 * categorization miss never fails the extraction pipeline that calls this alongside it. */
export async function categorizeDocument(text: string, filename: string): Promise<string | null> {
  try {
    const { data } = await axios.post(`${CHAT_WONDER_API_URL}/api/legal/categorize-document`, {
      text,
      filename,
    });
    const category = typeof data?.category === "string" ? data.category.trim() : "";
    return category || null;
  } catch (err) {
    logger.warn("Chat Wonder document categorization failed", { err, filename });
    return null;
  }
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
  if (lower.startsWith(LEGAL_TAG_UK)) return input.slice(LEGAL_TAG_UK.length).trimStart();
  if (lower.startsWith(LEGAL_TAG)) return input.slice(LEGAL_TAG.length).trimStart();
  return input;
}

// Picks the tag directly instead of relying on the separate `jurisdiction` payload field —
// the_server.py::process_persona checks this tag first, before its jurisdiction fallback, so
// this alone determines legal vs. legal_uk with no dependency on that field being read correctly.
function withLegalTag(input: string, tenantCode?: TenantCode): string {
  const tag = tenantCode === "UK" ? LEGAL_TAG_UK : LEGAL_TAG;
  return `${tag} ${stripLegalTag(input)}`;
}

/** Thrown by generateTitleViaWs for a genuine transport failure (timeout or socket error),
 * as opposed to resolving "" when Chat Wonder legitimately produced no content — lets the
 * caller log/handle the two cases differently instead of conflating them. */
export class TitleGenerationError extends Error {
  constructor(public readonly reason: "timeout" | "socket_error", message: string) {
    super(message);
    this.name = "TitleGenerationError";
  }
}

export async function generateTitleViaWs(prompt: string): Promise<string> {
  const sessionId = await getChatWonderSessionId();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let settled = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    };

    const fail = (reason: "timeout" | "socket_error", message: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new TitleGenerationError(reason, message));
    };

    const timeout = setTimeout(() => fail("timeout", "Chat Wonder title generation timed out after 30s"), 30_000);

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

    ws.onerror = () => { clearTimeout(timeout); fail("socket_error", "Chat Wonder title WS errored"); };
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
  /** From Chat Wonder's post-`__END__` `[AUDIO_OVERVIEW_DATA]` frame — only present when the
   * turn's user_input matched the_server.py's `_wants_audio_overview` trigger check. */
  audioOverview?: AudioOverviewTurn[];
  /** From Chat Wonder's post-`__END__` `{"type":"reasoning",...}` typed message (legal/legal_uk
   * only) — absent whenever that turn made no tool calls, or generation failed silently on
   * chat-wonder's side. Absence is the normal case for many turns, not an error. */
  reasoning?: ReasoningExplanation;
  /** From Chat Wonder's post-`__END__` `{"type":"decisions",...}` typed message (legal/legal_uk
   * only) — Decision Records (differentiation program, Phase 1), already verified server-side.
   * Absent whenever the turn produced no legal-analysis conclusions worth recording, or
   * generation failed silently. Absence is the normal case for many turns, not an error. */
  decisions?: DecisionRecordsPayload;
  /** From Chat Wonder's pre-`__END__` `[GENERATED_FILE_DATA]` frame (legal persona only) — the
   * raw drafted text from a successful generate_legal_document/draft_pleading tool call, not yet
   * rendered to a file. Rendering happens here, in-process, via GeneratedDocumentExportSvc — see
   * #71. Absent on every turn that didn't draft a document. */
  draftedDocument?: {
    content: string;
    format: "docx" | "pdf";
    documentType?: string;
    documentName?: string;
  };
  /** Persisted counterpart of the live-only `[TRACE]` research/verification steps (see the
   * onmessage handling below) — merged from start/result frame pairs the same way the
   * frontend's extractTraceSteps merges them live, so a later replay matches what was shown
   * while streaming. Empty (not absent) for a turn that made no tool calls. */
  researchSteps: TraceStep[];
}

/** Thrown by streamChatWonderMessage when its AbortSignal fires — the user pressed Stop. Not a
 * failure: callers (ChatSvc.processChatGenerationJob) treat it as a normal end of the turn. */
export class GenerationCancelledError extends Error {
  constructor() {
    super("Generation cancelled");
    this.name = "GenerationCancelledError";
  }
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
  // Selects LEGAL_TAG vs. LEGAL_TAG_UK in withLegalTag below — not forwarded as a payload
  // field (see that function's comment for why the tag alone is enough).
  tenantCode?: TenantCode,
  /** Aborting closes the Chat Wonder socket and rejects with GenerationCancelledError. Closing
   * the socket is the only stop signal Chat Wonder gets from here. */
  signal?: AbortSignal,
  /** Fired once, when the answer text is complete (Chat Wonder's `__END__` frame) - BEFORE the
   * post-answer extras (timeline, mind map, reasoning, decisions) that can take many more
   * seconds and that this promise still waits for. Lets the UI tell "text done, analysis still
   * finishing" apart from "still writing the answer". Never throws into the stream. */
  onAnswerComplete?: () => void,
): Promise<ChatWonderStreamResult> {
  if (signal?.aborted) return Promise.reject(new GenerationCancelledError());
  return new Promise((resolve, reject) => {
    const streamStartedAt = Date.now();
    logger.info("Chat Wonder: WS connecting", { sessionId, url: CHAT_WONDER_WS_URL });
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let sourcesDropped = false;
    let settled = false;
    let relatedCases: RelatedCase[] = [];
    let structuredMindMap: MindMapItem | undefined;
    let structuredTimeline: TimelineItem[] | undefined;
    let audioOverviewTurns: AudioOverviewTurn[] | undefined;
    let reasoningExplanation: ReasoningExplanation | undefined;
    let decisionRecords: DecisionRecordsPayload | undefined;
    let draftedDocument: ChatWonderStreamResult["draftedDocument"];
    const researchSteps = new Map<string, TraceStep>();
    let postEndTimer: ReturnType<typeof setTimeout> | undefined;
    let payloadSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let endFrameAt: number | undefined;
    const resolved = normalizeGrounding(grounding);
    // Kicked off alongside the WS connect so the chunk ids are ready (or close to it) by
    // the time onopen fires, instead of waiting on this serially after the socket is up.
    // When chunk ids are already supplied (case-scoped ranking), reuse them; otherwise
    // rank a single document's chunks against userInput — see relevantChunkIdsFor.
    const chunkIdsPromise =
      OMIT_EMBEDDING_RANKING || !resolved
        ? Promise.resolve<string[]>([])
        : resolved.caseDocumentChunkIds !== undefined
          ? Promise.resolve(resolved.caseDocumentChunkIds)
          : resolved.caseDocumentIds.length === 1
            ? relevantChunkIdsFor(resolved.caseDocumentIds[0], userInput)
            : Promise.resolve<string[]>([]);
    const manifestPromise = manifestFor(resolved?.caseDocumentIds ?? []);

    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      logger.info("Chat Wonder: stream finished", {
        sessionId,
        totalMs: Date.now() - streamStartedAt,
        connectToSendMs: payloadSentAt ? payloadSentAt - streamStartedAt : undefined,
        timeToFirstChunkMs: firstChunkAt ? firstChunkAt - streamStartedAt : undefined,
        timeToEndFrameMs: endFrameAt ? endFrameAt - streamStartedAt : undefined,
        structuredDataWaitMs: endFrameAt ? Date.now() - endFrameAt : undefined,
        contentChars: accumulated.length,
      });
      resolve({
        content: accumulated,
        relatedCases,
        mindMap: structuredMindMap,
        timeline: structuredTimeline,
        audioOverview: audioOverviewTurns,
        reasoning: reasoningExplanation,
        decisions: decisionRecords,
        draftedDocument,
        researchSteps: Array.from(researchSteps.values()),
      });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      const streamLog = {
        sessionId,
        totalMs: Date.now() - streamStartedAt,
        connectToSendMs: payloadSentAt ? payloadSentAt - streamStartedAt : undefined,
        timeToFirstChunkMs: firstChunkAt ? firstChunkAt - streamStartedAt : undefined,
      };
      if (err instanceof GenerationCancelledError) logger.info("Chat Wonder: stream cancelled by user", streamLog);
      else logger.error("Chat Wonder: stream failed", { ...streamLog, err });
      reject(err);
    };

    const onAbort = () => fail(new GenerationCancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });

    const armPostEndWait = () => {
      if (postEndTimer) return;
      endFrameAt = Date.now();
      try {
        onAnswerComplete?.();
      } catch (err) {
        logger.warn("Chat Wonder: onAnswerComplete threw, continuing", { sessionId, err });
      }
      logger.info("Chat Wonder: __END__ frame received, waiting for structured data", {
        sessionId,
        timeToEndFrameMs: endFrameAt - streamStartedAt,
        structuredDataWaitBudgetMs: STRUCTURED_DATA_WAIT_MS,
      });
      postEndTimer = setTimeout(() => finish(), STRUCTURED_DATA_WAIT_MS);
    };

    ws.onopen = () => {
      Promise.all([chunkIdsPromise, manifestPromise])
        .then(async ([chunkIds, manifest]) => {
          // Before the payload goes out: Chat Wonder may call back for these ids at once.
          await registerTurnDocuments(resolved?.caseDocumentIds ?? []);
          const fullTexts = resolved ? await fullTextsFor(resolved.caseDocumentIds, manifest) : [];
          const payload: {
            type: string;
            user_input: string;
            session_id: string;
            use_full_legal_chain: boolean;
            document_context?: string;
            case_document_ids?: string[];
            case_document_chunk_ids?: string[];
            case_document_manifest?: { id: string; name: string; category: string | null }[];
            case_document_texts?: { id: string; name: string; text: string }[];
          } = {
            type: "chat",
            user_input: withLegalTag(userInput, tenantCode) + (caseId ? MINDMAP_RULE : ""),
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
            if (chunkIds.length) payload.case_document_chunk_ids = chunkIds;
            payload.case_document_manifest = manifest;
            if (fullTexts.length) payload.case_document_texts = fullTexts;
          }
          // document_context / case_document_texts can be the full text of the whole case —
          // logged as lengths, not inline, so one chatty turn doesn't blow up combined.log.
          payloadSentAt = Date.now();
          logger.info("Chat Wonder WS payload", {
            url: CHAT_WONDER_WS_URL,
            ...payload,
            document_context: payload.document_context ? `[${payload.document_context.length} chars]` : undefined,
            case_document_texts: payload.case_document_texts
              ? `[${payload.case_document_texts.length} docs, ${payload.case_document_texts.reduce((n, d) => n + d.text.length, 0)} chars]`
              : undefined,
            connectToSendMs: payloadSentAt - streamStartedAt,
          });
          ws.send(JSON.stringify(payload));
        })
        .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    };

    ws.onmessage = (event) => {
      if (settled) return;

      let message = typeof event.data === "string" ? event.data : String(event.data);

      // The typed-envelope frames on this socket — the whole message is valid JSON on its
      // own (see chat-wonder-v2-api's the_server.py, the "reasoning"/"decisions" send_text
      // calls), unlike every other frame here which is a `[TAG]`-prefixed string. Must be
      // checked before any of the string-based branches below, since JSON.parse would throw
      // (and is caught) for all of those.
      let typedEnvelope: any = null;
      try {
        typedEnvelope = JSON.parse(message);
      } catch {
        typedEnvelope = null;
      }
      if (typedEnvelope && typedEnvelope.type === "reasoning") {
        const parsed = parseReasoningPayload(typedEnvelope.data);
        if (parsed) reasoningExplanation = parsed;
        return;
      }
      if (typedEnvelope && typedEnvelope.type === "decisions") {
        const parsed = parseDecisionsPayload(typedEnvelope.data);
        if (parsed) decisionRecords = parsed;
        return;
      }
      if (typedEnvelope && typedEnvelope.type === "usage") {
        logger.info("Chat Wonder usage", typedEnvelope.data);
        return;
      }

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

      // Only ever sent when this turn's input matched the_server.py's audio-overview
      // trigger check — absent on every other legal turn, unlike STRUCTURED_DATA above.
      const audioOverviewIdx = message.indexOf("[AUDIO_OVERVIEW_DATA]");
      if (audioOverviewIdx !== -1) {
        let payload = message.slice(audioOverviewIdx + "[AUDIO_OVERVIEW_DATA]".length);
        const doneIdx = payload.indexOf("[DONE]");
        if (doneIdx !== -1) payload = payload.slice(0, doneIdx);
        audioOverviewTurns = parseAudioOverviewPayload(payload);
        if (doneIdx !== -1) finish();
        return;
      }

      // Legal persona only, sent as its own frame before __END__ (see the_server.py's
      // /chat-stream handler, alongside [TAILOR_DATA]/[MAPS_DATA] for other personas) —
      // never mixed into the answer text, so no [DONE]-stripping needed here.
      const generatedFileIdx = message.indexOf("[GENERATED_FILE_DATA]");
      if (generatedFileIdx !== -1) {
        const payload = message.slice(generatedFileIdx + "[GENERATED_FILE_DATA]".length);
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed.content === "string") {
            draftedDocument = {
              content: parsed.content,
              format: parsed.format === "pdf" ? "pdf" : "docx",
              documentType: parsed.document_type,
              documentName: parsed.document_name,
            };
          }
        } catch {
          // malformed frame — leave draftedDocument unset
        }
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
      //
      // But only while nothing has arrived. the_server.py's chat_stream wraps the whole
      // turn — including the post-__END__ timeline/mind-map/reasoning generation — in one
      // try, and sends "[Error] ..." for any exception in it. Rejecting at that point threw
      // away a reply the user had already watched stream in: ChatSvc.processChatGenerationJob
      // never reached ChatSvc.persistAssistantTurn, so the turn vanished from history on the
      // next page load. Once there is content, treat the frame as a warning and resolve with
      // what we have — the answer is real even if the extras behind it failed.
      if (message.startsWith("[Error]")) {
        const detail = message.replace(/^\[Error\]\s*/, "");
        if (accumulated.trim().length === 0) {
          fail(new Error(detail));
        } else {
          logger.warn("Chat Wonder sent [Error] after reply content; keeping the reply", {
            sessionId,
            detail,
            contentLength: accumulated.length,
          });
          finish();
        }
        return;
      }

      // Glass-box research-trace frames (see the_server.py's/legal_responses_chain.py's
      // '[TRACE]' yields, sent as their own standalone WS message each, never mixed with prose).
      // Forwarded via onChunk so the app's live trace UI can render them as they arrive, and
      // still deliberately excluded from `accumulated` — they aren't part of the AI's answer and
      // must never survive into the persisted transcript (unlike [MINDMAP]/[TIMELINE], which the
      // frontend strips only for the *live* bubble because the backend's own response-parser
      // still needs to see them once to extract structured data before persisting the rest).
      // They ARE captured separately below into `researchSteps`, merging each tool call's
      // 'start'/'result' frame pair by id — this is the persisted counterpart of the live-only
      // trace UI (see ChatWonderStreamResult.researchSteps).
      if (message.startsWith("[TRACE]")) {
        onChunk(message);
        const frame = parseTraceFrame(message);
        if (frame) {
          const existing = researchSteps.get(frame.id);
          if (frame.phase === "start") {
            researchSteps.set(frame.id, {
              id: frame.id,
              tool: frame.tool ?? existing?.tool ?? "",
              label: frame.label ?? existing?.label ?? "",
              count: existing?.count,
              status: "active",
            });
          } else if (frame.phase === "result" && existing) {
            researchSteps.set(frame.id, { ...existing, count: frame.count, status: "done" });
          }
        }
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
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          logger.info("Chat Wonder: first content chunk received", {
            sessionId,
            timeToFirstChunkMs: firstChunkAt - streamStartedAt,
          });
        }
        accumulated += message;
        onChunk(message);
      }

      if (isFinal) armPostEndWait();
    };

    ws.onerror = () => {
      if (settled) return;
      // Same reasoning as the [Error]-frame handler above: a socket-level error after the
      // reply has already streamed to and rendered in the client must not throw that reply
      // away — the user watched it arrive, and rejecting here means
      // ChatSvc.processChatGenerationJob never reaches ChatSvc.persistAssistantTurn, so the
      // turn vanishes from history for good.
      if (accumulated.trim().length === 0) {
        settled = true;
        if (postEndTimer) clearTimeout(postEndTimer);
        reject(new HttpError("Chat Wonder connection error", 503));
      } else {
        logger.warn("Chat Wonder socket error after reply content; keeping the reply", {
          sessionId,
          contentLength: accumulated.length,
        });
        finish();
      }
    };

    ws.onclose = () => {
      finish();
    };
  });
}
