import { createHash } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseSvc from "./case.service";
import DocumentChunkSvc from "./document-chunk.service";
import { mapDocumentToDto } from "./document.service";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, RelatedCase, CaseDocumentGrounding } from "../utils/chatWonder";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import { extractTimeline, extractMindMap, stripStructuredBlocks } from "../utils/response-parser";

const TITLE_CACHE_TTL    = 60 * 60 * 24 * 7; // 7 days
const RESPONSE_CACHE_TTL = 60 * 15;          // 15 minutes
const TITLE_MAX_CHARS    = 60;                // max title length (matches frontend truncation)
const TITLE_INPUT_CHARS  = 500;              // how much of the user message to feed the title prompt

// Used in place of the user's message text (title generation, AI prompt, cache key) when a
// message carries attachments but no typed text — content itself stays a stored empty string
// (see ADR: locale-independent "no content" signal for the frontend to render nothing), so this
// fixed, non-localized stand-in is what the AI actually sees instead.
const ATTACHMENT_ONLY_PROMPT = "The user attached one or more documents without any additional message. Review the attached document(s) and respond accordingly.";

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
  static async createConsultation(userId: string, title?: string, caseId?: string) {
    if (caseId) {
      // Throws 404 if the case doesn't exist or isn't owned by this user
      await CaseSvc.getById(caseId, userId);
    }
    return ChatRepo.createConsultation(userId, title, caseId);
  }

  static async listConsultations(userId: string, caseId?: string) {
    return ChatRepo.listConsultations(userId, caseId);
  }

  static async renameConsultation(userId: string, consultationId: string, title: string) {
    await this.assertConsultationOwned(userId, consultationId);
    return ChatRepo.updateConsultation(consultationId, title);
  }

  static async assertConsultationOwned(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    return consultation;
  }

  static async deleteConsultation(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    return ChatRepo.deleteConsultation(consultationId);
  }

  static async listMessages(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }

    const messages = await ChatRepo.listMessagesByConsultation(consultationId);
    return messages.map((m) => ({ ...m, documents: m.documents.map(mapDocumentToDto) }));
  }

  static async deleteMessage(userId: string, consultationId: string, messageId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    const message = await ChatRepo.findMessageById(messageId);
    if (!message || message.consultationId !== consultationId) {
      throw new HttpError("Message not found", 404);
    }
    return ChatRepo.deleteMessage(messageId);
  }

  static async sendMessage(
    userId: string,
    consultationId: string,
    sessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    documentContext?: string,
    onSessionRotated?: (newSessionId: string) => void,
    caseDocumentId?: string,
    caseId?: string,
    documentIds?: string[],
  ) {
    const consultation = await ChatRepo.findConsultationWithCase(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }

    // Prefer consultation.caseId; allow per-message caseId for case-portfolio chats
    // whose consultation was created without a case link.
    let effectiveCaseId = consultation.caseId ?? undefined;
    if (!effectiveCaseId && caseId) {
      await CaseSvc.getById(caseId, userId); // ownership check
      effectiveCaseId = caseId;
    }

    const needsTitle = consultation.title === null;
    const userMessage = await ChatRepo.createMessage(consultationId, "user", userInput, userId);

    if (documentIds?.length) {
      await DocumentRepo.linkToMessage(documentIds, userMessage.id, userId, consultationId);
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
      caseRecord = await CaseSvc.getById(effectiveCaseId, userId);
    }
    const caseContext = caseRecord ? CaseSvc.formatForAiContext(caseRecord) : "";

    // Grounding priority:
    // 1. Explicit caseDocumentId on this message (single-doc ranking)
    // 2. READY docs attached to this consultation (consultation-specific data source)
    // 3. Case id (consultation or message body) → rank READY docs under that case
    let grounding: CaseDocumentGrounding | undefined;
    if (caseDocumentId) {
      grounding = await DocumentChunkSvc.relevantChunksForDocument(caseDocumentId, userInput);
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
      ? await DocumentChunkSvc.formatGroundingContext(grounding)
      : "";
    const resolvedContext = [caseContext, documentContext, groundingContext].filter(Boolean).join("\n\n");

    const cacheKey = responseCacheKey(
      consultationId,
      userInput,
      resolvedContext,
      groundingCacheKey(grounding),
    );
    const cached = await redis.get<{ content: string; relatedCases: RelatedCase[] }>(cacheKey);

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    if (cached) {
      onChunk(cached.content);
      fullResponse = cached.content;
      relatedCases = cached.relatedCases;
    } else {
      const result = await ChatSvc.streamWithSessionRetry(sessionId, userInput, onChunk, resolvedContext, onSessionRotated, grounding);
      fullResponse = result.content;
      relatedCases = result.relatedCases;
      redis.set(cacheKey, { content: fullResponse, relatedCases }, RESPONSE_CACHE_TTL);
    }

    const timeline = extractTimeline(fullResponse);
    const mindMap = extractMindMap(fullResponse);
    const cleanedContent = stripStructuredBlocks(fullResponse);

    const assistantMessage = await ChatRepo.createMessage(
      consultationId,
      "assistant",
      cleanedContent,
      undefined,
      userMessage.id,
    );

    if (timeline) await ChatRepo.saveTimeline(assistantMessage.id, timeline);
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
    sessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    resolvedContext: string,
    onSessionRotated?: (newSessionId: string) => void,
    grounding?: CaseDocumentGrounding,
  ) {
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, grounding);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await getChatWonderSessionId();
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, grounding);
    }
  }

  static async getRelatedCases(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
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
