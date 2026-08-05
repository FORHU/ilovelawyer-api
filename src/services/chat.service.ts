import { createHash } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import CaseSvc from "./case.service";
import LegalRagRepo from "../repositories/legal-rag.repository";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, RelatedCase } from "../utils/chatWonder";
import UserDocumentChunkRepo from "../repositories/user-document-chunk.repository";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import { extractTimeline, extractMindMap, stripStructuredBlocks } from "../utils/response-parser";
import { embedText } from "../utils/embedding";
import logger from "../utils/logger";

const DOCUMENT_RAG_LIMIT = 8;
const DOCUMENT_RAG_MIN_SIMILARITY = 0.3;

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

function responseCacheKey(userMessage: string, resolvedContext: string): string {
  return `chat:response:${messageHash(userMessage.trim().toLowerCase() + resolvedContext)}`;
}

export default class ChatSvc {
  static async createConversation(userId: string, title?: string, caseId?: string) {
    if (caseId) {
      // Throws 404 if the case doesn't exist or isn't owned by this user
      await CaseSvc.getById(caseId, userId);
    }
    return ChatRepo.createConversation(userId, title, caseId);
  }

  static async listConversations(userId: string, caseId?: string) {
    return ChatRepo.listConversations(userId, caseId);
  }

  static async renameConversation(userId: string, conversationId: string, title: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }
    return ChatRepo.updateConversation(conversationId, title);
  }

  static async deleteConversation(userId: string, conversationId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }
    return ChatRepo.deleteConversation(conversationId);
  }

  static async listMessages(userId: string, conversationId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }

    return ChatRepo.listMessagesByConversation(conversationId);
  }

  static async deleteMessage(userId: string, conversationId: string, messageId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }
    const message = await ChatRepo.findMessageById(messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new HttpError("Message not found", 404);
    }
    return ChatRepo.deleteMessage(messageId);
  }

  static async sendMessage(
    userId: string,
    conversationId: string,
    sessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    onSessionRotated?: (newSessionId: string) => void,
  ) {
    const conversation = await ChatRepo.findConversationWithCase(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }

    const needsTitle = conversation.title === null;
    const userMessage = await ChatRepo.createMessage(conversationId, "user", userInput, userId);

    if (needsTitle) {
      ChatSvc.generateAndSaveTitle(conversationId, userInput).catch(() => {});
    }

    // Both re-derived fresh on every message (never cached on the conversation), so edits to
    // the Case or newly-extracted documents are picked up immediately rather than going stale.
    const caseContext = conversation.case ? CaseSvc.formatForAiContext(conversation.case) : "";
    const documentRagContext = conversation.case
      ? await ChatSvc.buildDocumentRagContext(userId, conversation.caseId as string, userInput)
      : "";
    const resolvedContext = [caseContext, documentRagContext].filter(Boolean).join("\n\n");

    const cacheKey = responseCacheKey(userInput, resolvedContext);
    const cached = await redis.get<{ content: string; relatedCases: RelatedCase[] }>(cacheKey);

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    if (cached) {
      onChunk(cached.content);
      fullResponse = cached.content;
      relatedCases = cached.relatedCases;
    } else {
      const result = await ChatSvc.streamWithSessionRetry(sessionId, userInput, onChunk, resolvedContext, onSessionRotated);
      fullResponse = result.content;
      relatedCases = await ChatSvc.resolveRelatedCases(result.relatedQueries);
      redis.set(cacheKey, { content: fullResponse, relatedCases }, RESPONSE_CACHE_TTL);
    }

    const timeline = extractTimeline(fullResponse);
    const mindMap = extractMindMap(fullResponse);
    const cleanedContent = stripStructuredBlocks(fullResponse);

    const assistantMessage = await ChatRepo.createMessage(
      conversationId,
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
  ) {
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await getChatWonderSessionId();
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext);
    }
  }

  /** Retrieves the Case's linked documents' chunks most relevant to the user's latest message
   * and formats them the same way the old client-supplied documentContext was shaped. A
   * document with no chunk rows (extraction still PENDING, or FAILED) simply contributes
   * nothing here — no status check needed. A retrieval failure (embedding API down, etc.)
   * degrades to no document context rather than failing the whole chat message — same
   * "never surfaced to the user" handling the extraction pipeline itself uses. */
  static async buildDocumentRagContext(userId: string, caseId: string, userInput: string): Promise<string> {
    try {
      const embedding = await embedText(userInput);
      const chunks = await UserDocumentChunkRepo.vectorSearch(caseId, userId, embedding, {
        limit: DOCUMENT_RAG_LIMIT,
        minSimilarity: DOCUMENT_RAG_MIN_SIMILARITY,
      });

      return chunks.map((chunk) => `From "${chunk.doc_name}":\n${chunk.chunk_text}`).join("\n\n");
    } catch (err) {
      logger.error("Document RAG retrieval failed", { err, caseId, userId });
      return "";
    }
  }

  /** Resolves the citation terms Chat Wonder surfaced via [RELATED_QUERIES] against the
   * legal document store. Terms that don't match a known document are dropped rather than
   * fabricated into a result. */
  static async resolveRelatedCases(terms: string[]): Promise<RelatedCase[]> {
    // A bare term like "Republic Act" (no number — the model dropped it, or emitted a
    // topic word despite the prompt's rules) has no anchor to a specific document: an
    // ILIKE lookup against it matches every RA-type row in the table, and the DB's
    // year-DESC tiebreak then surfaces whichever happens to be newest — unrelated to
    // what was actually discussed. Only resolve terms that carry a real identifier: a
    // number (article/section/RA/PD/GR) or a case-name pattern ("X v. Y").
    const isSpecificCitation = (term: string) => /\d/.test(term) || /\bvs?\.?\s+\S/i.test(term);

    const uniqueTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].filter(isSpecificCitation);
    if (!uniqueTerms.length) return [];

    const rows = await Promise.all(uniqueTerms.map((term) => LegalRagRepo.findForRelatedTerm(term)));

    const cases: RelatedCase[] = [];
    const seenIds = new Set<string>();
    rows.forEach((row, i) => {
      if (!row) return;
      const id = row.id.toString();
      if (seenIds.has(id)) return; // same document matched by more than one term
      seenIds.add(id);

      const raMatch = uniqueTerms[i].match(/republic act\s+(?:no\.?\s*)?(\d+)/i);
      cases.push({
        type: row.category,
        title: row.title,
        url: row.source_url,
        case_number: row.case_no,
        ra_number: raMatch ? raMatch[1] : null,
        year: row.year,
        snippet: row.concise_summary ? row.concise_summary.slice(0, 240) : null,
        relevance: null,
        vetted: true,
      });
    });

    return cases;
  }

  static async getRelatedCases(userId: string, conversationId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }

    const message = await ChatRepo.findLatestAssistantMessage(conversationId);
    return message?.relatedCases?.items ?? [];
  }

  static buildTitlePrompt(userMessage: string): string {
    return (
      `Create a concise title for a Philippine legal conversation.\n` +
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
    conversationId: string,
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

    await ChatRepo.updateConversation(conversationId, title);
  }
}
