import { createHash } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import LegalRagRepo from "../repositories/legal-rag.repository";
import { generateTitleViaWs, streamChatWonderMessage } from "../utils/chatWonder";
import { embedText } from "../utils/embedding";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";

const TITLE_CACHE_TTL    = 60 * 60 * 24 * 7; // 7 days
const RESPONSE_CACHE_TTL = 60 * 60 * 24;     // 24 hours
const CONTEXT_CACHE_TTL  = 60 * 60 * 6;      // 6 hours
const VECTOR_TOP_K       = 5;                 // chunks to retrieve per query
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

function contextCacheKey(userMessage: string): string {
  return `chat:context:${messageHash(userMessage.trim().toLowerCase())}`;
}

export default class ChatSvc {
  static async createConversation(userId: string, title?: string) {
    return ChatRepo.createConversation(userId, title);
  }

  static async listConversations(userId: string) {
    return ChatRepo.listConversations(userId);
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
    documentContext?: string,
  ) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }

    const needsTitle = conversation.title === null;
    const userMessage = await ChatRepo.createMessage(conversationId, "user", userInput, userId);

    if (needsTitle) {
      ChatSvc.generateAndSaveTitle(conversationId, userInput).catch(() => {});
    }

    // Retrieve context ourselves via vector search (falls back to caller-supplied context)
    const resolvedContext = documentContext ?? await ChatSvc.retrieveContext(userInput);

    const cacheKey = responseCacheKey(userInput, resolvedContext);
    const cached = await redis.get<string>(cacheKey);

    let fullResponse: string;
    if (cached) {
      onChunk(cached);
      fullResponse = cached;
    } else {
      fullResponse = await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext);
      redis.set(cacheKey, fullResponse, RESPONSE_CACHE_TTL);
    }

    await ChatRepo.createMessage(conversationId, "assistant", fullResponse, undefined, userMessage.id);
  }

  private static async retrieveContext(userInput: string): Promise<string> {
    const cacheKey = contextCacheKey(userInput);
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      console.log("[RAG] context cache hit");
      return cached;
    }

    try {
      console.log("[RAG] embedding query...");
      const embedding = await embedText(userInput);
      console.log("[RAG] vector search...");
      const chunks = await LegalRagRepo.searchByVector(embedding, VECTOR_TOP_K);
      console.log(`[RAG] retrieved ${chunks.length} chunks:`, chunks.map(c => c.title ?? c.category));
      if (!chunks.length) return "";

      const context = chunks
        .map((c, i) => `[${i + 1}] ${c.title ?? c.category}\n${c.chunk_text}`)
        .join("\n\n");

      redis.set(cacheKey, context, CONTEXT_CACHE_TTL);
      return context;
    } catch (err) {
      console.error("[RAG] retrieveContext failed:", (err as Error).message);
      return "";
    }
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
