import ChatRepo from "../repositories/chat.repository";
import { streamChatWonderMessage } from "../utils/chatWonder";
import HttpError from "../utils/http-error";

export default class ChatSvc {
  static async createConversation(userId: string, title?: string) {
    return ChatRepo.createConversation(userId, title);
  }

  static async listMessages(userId: string, conversationId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }

    return ChatRepo.listMessagesByConversation(conversationId);
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

    const userMessage = await ChatRepo.createMessage(conversationId, "user", userInput, userId);

    const fullResponse = await streamChatWonderMessage(sessionId, userInput, onChunk, documentContext);

    await ChatRepo.createMessage(conversationId, "assistant", fullResponse, undefined, userMessage.id);
  }
}
