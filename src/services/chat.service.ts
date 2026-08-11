import { createHash } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseSvc from "./case.service";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, RelatedCase } from "../utils/chatWonder";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import { extractTimeline, extractMindMap, stripStructuredBlocks } from "../utils/response-parser";

const TITLE_CACHE_TTL    = 60 * 60 * 24 * 7; // 7 days
const RESPONSE_CACHE_TTL = 60 * 60 * 24;     // 24 hours
const TITLE_MAX_CHARS    = 60;                // max title length (matches frontend truncation)
const TITLE_INPUT_CHARS  = 500;              // how much of the user message to feed the title prompt

function messageHash(text: string): string {
  return createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

function titleCacheKey(userMessage: string): string {
  return `title:prompt:${messageHash(userMessage.slice(0, 500))}`;
}

function responseCacheKey(userMessage: string, resolvedContext: string, caseDocumentId?: string): string {
  return `chat:response:${messageHash(userMessage.trim().toLowerCase() + resolvedContext + (caseDocumentId ?? ""))}`;
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
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    return ChatRepo.updateConsultation(consultationId, title);
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

    return ChatRepo.listMessagesByConsultation(consultationId);
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
  ) {
    const consultation = await ChatRepo.findConsultationWithCase(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }

    const needsTitle = consultation.title === null;
    const userMessage = await ChatRepo.createMessage(consultationId, "user", userInput, userId);

    if (needsTitle) {
      ChatSvc.generateAndSaveTitle(consultationId, userInput).catch(() => {});
    }

    // Re-derived from the live Case row on every message (not cached on the consultation),
    // so edits to the Case's fields are picked up immediately rather than going stale.
    const caseContext = consultation.case ? CaseSvc.formatForAiContext(consultation.case) : "";
    const resolvedContext = [caseContext, documentContext].filter(Boolean).join("\n\n");

    // If the client didn't attach a document to this specific message, fall back to the most
    // recently attached document in this consultation — so a file attached in an earlier turn
    // stays groundable in later ones instead of only ever answering for the turn it was sent in.
    // Deliberately scoped to consultationId only (not caseId) — case-linked consultations keep
    // today's explicit-only behavior.
    let effectiveCaseDocumentId = caseDocumentId;
    if (!effectiveCaseDocumentId) {
      const recentDoc = await DocumentRepo.findMostRecentByConsultation(consultationId);
      if (recentDoc) effectiveCaseDocumentId = recentDoc.id;
    }

    const cacheKey = responseCacheKey(userInput, resolvedContext, effectiveCaseDocumentId);
    const cached = await redis.get<{ content: string; relatedCases: RelatedCase[] }>(cacheKey);

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    if (cached) {
      onChunk(cached.content);
      fullResponse = cached.content;
      relatedCases = cached.relatedCases;
    } else {
      const result = await ChatSvc.streamWithSessionRetry(sessionId, userInput, onChunk, resolvedContext, onSessionRotated, effectiveCaseDocumentId);
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
    caseDocumentId?: string,
  ) {
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, caseDocumentId);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await getChatWonderSessionId();
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, caseDocumentId);
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
