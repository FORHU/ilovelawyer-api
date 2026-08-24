import { createHash } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseSvc from "./case.service";
import DocumentChunkSvc from "./document-chunk.service";
import TranscriptionChunkSvc from "./transcription-chunk.service";
import { mapDocumentToDto } from "./document.service";
import DocumentRepo from "../repositories/document.repository";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, RelatedCase, CaseDocumentGrounding } from "../utils/chatWonder";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import { extractTimeline, extractMindMap, stripStructuredBlocks, MindMapItem, TimelineItem } from "../utils/response-parser";
import CaseTimelineSvc from "./case-timeline.service";
import { documentBelongsToScope } from "../utils/case-document-scope";

const TITLE_CACHE_TTL    = 60 * 60 * 24 * 7; // 7 days
const RESPONSE_CACHE_TTL = 60 * 15;          // 15 minutes
const TITLE_MAX_CHARS    = 60;                // max title length (matches frontend truncation)
const TITLE_INPUT_CHARS  = 500;              // how much of the user message to feed the title prompt
const CHAT_WONDER_SESSION_TTL_S = 60 * 60;   // match chat-wonder's in-memory session TTL

function chatWonderSessionKey(consultationId: string): string {
  return `chatwonder:session:${consultationId}`;
}

function messageHash(text: string): string {
  return createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

function titleCacheKey(userMessage: string): string {
  return `title:prompt:${messageHash(userMessage.slice(0, 500))}`;
}

/** Redis key for a cached chat-wonder reply.
 * Includes consultationId so two chats with the same prompt/docs don't share answers. */
function responseCacheKey(
  consultationId: string,
  userMessage: string,
  resolvedContext: string,
  groundingKey: string,
): string {
  return `chat:response:${messageHash(
    [consultationId, userMessage.trim().toLowerCase(), resolvedContext, groundingKey].join("\0"),
  )}`;
}

/** Compact fingerprint of which docs/chunks grounded this turn — part of responseCacheKey.
 * Built from the ranking result (doc ids + chunk ids), not stored separately in Redis. */
function groundingCacheKey(grounding?: CaseDocumentGrounding): string {
  if (!grounding?.caseDocumentIds.length) return "";
  return [
    grounding.caseDocumentIds.slice().sort().join(","),
    (grounding.caseDocumentChunkIds ?? []).join(","),
  ].join("|");
}

export default class ChatSvc {
  static async createConsultation(organizationId: string, userId: string, title?: string, caseId?: string) {
    if (caseId) {
      // Throws 404 if the case doesn't exist or isn't in this organization
      await CaseSvc.getById(caseId, organizationId);
    }
    return ChatRepo.createConsultation(organizationId, userId, title, caseId);
  }

  static async listConsultations(organizationId: string, caseId?: string) {
    return ChatRepo.listConsultations(organizationId, caseId);
  }

  static async renameConsultation(organizationId: string, consultationId: string, title: string) {
    await this.assertConsultationOwned(organizationId, consultationId);
    return ChatRepo.updateConsultation(consultationId, title);
  }

  static async assertConsultationOwned(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    return consultation;
  }

  static async deleteConsultation(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    return ChatRepo.deleteConsultation(consultationId);
  }

  static async listMessages(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

    const messages = await ChatRepo.listMessagesByConsultation(consultationId);
    return messages.map((m) => ({ ...m, documents: m.documents.map(mapDocumentToDto) }));
  }

  static async deleteMessage(organizationId: string, consultationId: string, messageId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    const message = await ChatRepo.findMessageById(messageId);
    if (!message || message.consultationId !== consultationId) {
      throw new HttpError("Message not found", 404);
    }
    return ChatRepo.deleteMessage(messageId);
  }

  static async sendMessage(
    organizationId: string,
    userId: string,
    consultationId: string,
    requestedSessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    documentContext?: string,
    onSessionRotated?: (newSessionId: string) => void,
    caseDocumentId?: string,
    caseId?: string,
    documentIds?: string[],
  ) {
    const consultation = await ChatRepo.findConsultationWithCase(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

    // Prefer consultation.caseId; allow per-message caseId for case-portfolio chats
    // whose consultation was created without a case link.
    let effectiveCaseId = consultation.caseId ?? undefined;
    if (!effectiveCaseId && caseId) {
      await CaseSvc.getById(caseId, organizationId); // ownership check
      effectiveCaseId = caseId;
    }

    // One Chat Wonder session per consultation. The client caches a single session_id for
    // the whole app; reusing it across cases leaks prior-case document text via session history.
    const sessionId = await ChatSvc.resolveChatWonderSession(consultationId);
    if (sessionId !== requestedSessionId) {
      onSessionRotated?.(sessionId);
    }

    const needsTitle = consultation.title === null;
    const userMessage = await ChatRepo.createMessage(consultationId, "user", userInput, userId);

    if (documentIds?.length) {
      await DocumentRepo.linkToMessage(documentIds, userMessage.id, organizationId, consultationId);
    }

    // content stays a stored empty string for a file-only send (see ADR) — everything the AI
    // and title generation actually see substitutes in a fixed stand-in instead.
    const effectiveUserInput = userInput.trim() ? userInput : ATTACHMENT_ONLY_PROMPT;

    if (needsTitle) {
      ChatSvc.generateAndSaveTitle(consultationId, effectiveUserInput).catch(() => {});
    }

    // Re-derived from the live Case row on every message (not cached on the consultation),
    // so edits to the Case's fields are picked up immediately rather than going stale.
    let caseRecord = consultation.case;
    if (!caseRecord && effectiveCaseId) {
      caseRecord = await CaseSvc.getById(effectiveCaseId, organizationId);
    }
    const caseContext = caseRecord ? CaseSvc.formatForAiContext(caseRecord) : "";

    // Grounding priority:
    // 1. Explicit caseDocumentId on this message (single-doc ranking) — only if it belongs
    //    to this consultation or case. A client-supplied id from another case must not rank.
    // 2. READY docs attached to this consultation (consultation-specific data source)
    // 3. Case id (consultation or message body) → rank READY docs under that case
    let grounding: CaseDocumentGrounding | undefined;
    const scopedDocumentId = await ChatSvc.scopedCaseDocumentId(
      caseDocumentId,
      userId,
      consultationId,
      effectiveCaseId,
    );
    if (scopedDocumentId) {
      grounding = await DocumentChunkSvc.relevantChunksForDocument(scopedDocumentId, userInput);
      if (!grounding.caseDocumentIds.length) grounding = undefined;
    } else {
      const consultationDocs = await DocumentChunkSvc.relevantChunksForConsultation(
        consultationId,
        userInput,
      );
      if (consultationDocs.caseDocumentIds.length) {
        grounding = consultationDocs;
      } else if (effectiveCaseId) {
        grounding = await DocumentChunkSvc.relevantChunksForCase(effectiveCaseId, userInput);
        if (!grounding.caseDocumentIds.length) grounding = undefined;
      }
    }

    // Inline ranked chunk text into document_context. Chat-wonder also receives case_document_ids
    // for its callback fetch, but that often fails in local/staging (ILOVELAWYER_API_BASE points
    // at production with a mismatched API key) — inlining keeps analysis working either way.
    const groundingContext = grounding
      ? await DocumentChunkSvc.formatGroundingContext(grounding, 12_000, {
          caseId: effectiveCaseId,
          consultationId,
        })
      : "";

    // Transcript grounding (ADR 0013): a parallel, independent lookup — never merged/ranked
    // together with Case Document grounding above. Same consultation → case priority shape, but
    // no per-message single-transcript equivalent to caseDocumentId (nothing analogous is sent).
    // Not part of `grounding`/CaseDocumentGrounding — chat-wonder's callback fetch only knows
    // about Documents, so transcript content is inlined into resolvedContext text only.
    const consultationTranscripts = await TranscriptionChunkSvc.relevantChunksForConsultation(
      consultationId,
      userInput,
    );
    let transcriptGrounding = consultationTranscripts.transcriptionIds.length
      ? consultationTranscripts
      : effectiveCaseId
        ? await TranscriptionChunkSvc.relevantChunksForCase(effectiveCaseId, userInput)
        : undefined;
    if (transcriptGrounding && !transcriptGrounding.transcriptionIds.length) transcriptGrounding = undefined;
    const transcriptContext = transcriptGrounding
      ? await TranscriptionChunkSvc.formatGroundingContext(transcriptGrounding)
      : "";

    const resolvedContext = [caseContext, documentContext, groundingContext, transcriptContext]
      .filter(Boolean)
      .join("\n\n");

    const cacheKey = responseCacheKey(
      consultationId,
      userInput,
      resolvedContext,
      groundingCacheKey(grounding),
    );
    const cached = await redis.get<{
      content: string;
      relatedCases: RelatedCase[];
      mindMap?: MindMapItem;
      timeline?: TimelineItem[];
    }>(cacheKey);
    // Map-generation turns used to cache text-only replies (the mind map arrives on a
    // later Chat Wonder frame). A hit without mindMap would keep the tab empty for TTL.
    const wantsMindMap = /visual strategy map|mind\s*map/i.test(userInput);
    const useCache = Boolean(cached) && (!wantsMindMap || cached?.mindMap);

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    let streamedMindMap: MindMapItem | undefined;
    let streamedTimeline: TimelineItem[] | undefined;
    if (useCache && cached) {
      onChunk(cached.content);
      fullResponse = cached.content;
      relatedCases = cached.relatedCases;
      streamedMindMap = cached.mindMap;
      streamedTimeline = cached.timeline;
    } else {
      const result = await ChatSvc.streamWithSessionRetry(
        consultationId,
        sessionId,
        userInput,
        onChunk,
        resolvedContext,
        onSessionRotated,
        grounding,
      );
      fullResponse = result.content;
      relatedCases = result.relatedCases;
      streamedMindMap = result.mindMap;
      streamedTimeline = result.timeline;
      redis.set(
        cacheKey,
        { content: fullResponse, relatedCases, mindMap: streamedMindMap, timeline: streamedTimeline },
        RESPONSE_CACHE_TTL,
      );
    }

    const timeline = streamedTimeline ?? extractTimeline(fullResponse);
    const mindMap = streamedMindMap ?? extractMindMap(fullResponse);
    const cleanedContent = stripStructuredBlocks(fullResponse);

    const assistantMessage = await ChatRepo.createMessage(
      consultationId,
      "assistant",
      cleanedContent,
      undefined,
      userMessage.id,
    );

    if (timeline) await ChatRepo.saveTimeline(assistantMessage.id, timeline);
    if (timeline && effectiveCaseId) {
      await CaseTimelineSvc.promoteFromAi(effectiveCaseId, timeline, userId).catch(() => {});
    }
    if (mindMap) await ChatRepo.saveMindMap(assistantMessage.id, mindMap);
    if (relatedCases.length) await ChatRepo.saveRelatedCases(assistantMessage.id, relatedCases);
  }

  /** Chat Wonder keeps sessions in memory and drops them on restart; the frontend caches
   * its session_id indefinitely (including across login/logout), so a "session_id not
   * recognized" rejection from streamChatWonderMessage is an expected, recoverable event
   * rather than a real failure. "Unknown session." is always the very first frame Chat
   * Wonder sends for this case (see the_server.py's chat_stream handler), before any real
   * content — so retrying from scratch here can't cause onChunk to double-emit content. */
  private static async streamWithSessionRetry(
    consultationId: string,
    sessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    resolvedContext: string,
    onSessionRotated?: (newSessionId: string) => void,
    grounding?: CaseDocumentGrounding,
    caseId?: string,
  ) {
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, grounding, caseId);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, grounding, caseId);
    }
  }

  /** One Chat Wonder session per consultation so case-document history cannot leak across cases. */
  private static async resolveChatWonderSession(consultationId: string): Promise<string> {
    const stored = await redis.get<string>(chatWonderSessionKey(consultationId));
    if (typeof stored === "string" && stored.length > 0) {
      await redis.set(chatWonderSessionKey(consultationId), stored, CHAT_WONDER_SESSION_TTL_S);
      return stored;
    }
    return ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
  }

  private static async storeChatWonderSession(consultationId: string, sessionId: string): Promise<string> {
    await redis.set(chatWonderSessionKey(consultationId), sessionId, CHAT_WONDER_SESSION_TTL_S);
    return sessionId;
  }

  /** Ignore a client-supplied document id unless it belongs to this consultation or case. */
  private static async scopedCaseDocumentId(
    caseDocumentId: string | undefined,
    userId: string,
    consultationId: string,
    caseId?: string,
  ): Promise<string | undefined> {
    if (!caseDocumentId) return undefined;
    const doc = await DocumentRepo.findById(caseDocumentId, userId);
    if (!doc) return undefined;
    if (!documentBelongsToScope(doc, { userId, consultationId, caseId })) return undefined;
    return doc.id;
  }

  static async getRelatedCases(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

    const message = await ChatRepo.findLatestAssistantMessage(consultationId);
    return message?.relatedCases?.items ?? [];
  }

  static buildTitlePrompt(userMessage: string): string {
    return (
      `Create a concise title for a Philippine legal consultation.\n` +
      `Format: [Legal Area]: [Specific Issue] — for example: "Philippine Labor Law: Illegal Dismissal", "Family Code: Custody Rights", "Criminal Law: Estafa"\n` +
      `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
      `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
      `Output only the title, nothing else.`
    );
  }

  static parseTitle(raw: string): string {
    return raw
      .split("\n")[0]
      .replace(/^["'""'']|["'""'']$/g, "")
      .replace(/\.$/, "")
      .trim()
      .slice(0, TITLE_MAX_CHARS);
  }

  private static async generateAndSaveTitle(
    consultationId: string,
    userMessage: string,
  ): Promise<void> {
    const cacheKey = titleCacheKey(userMessage);

    let title = await redis.get<string>(cacheKey);

    if (!title) {
      const raw = await generateTitleViaWs(ChatSvc.buildTitlePrompt(userMessage));
      if (!raw) return;
      title = ChatSvc.parseTitle(raw);
      if (!title) return;
      redis.set(cacheKey, title, TITLE_CACHE_TTL);
    }

    await ChatRepo.updateConsultation(consultationId, title);
  }
}
