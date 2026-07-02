import ChatRepo from "../repositories/chat.repository";
import { streamChatWonderMessage } from "../utils/chatWonder";
import HttpError from "../utils/http-error";

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

    const userMessage = await ChatRepo.createMessage(conversationId, "user", userInput, userId);

    const fullResponse = await streamChatWonderMessage(sessionId, userInput, onChunk, documentContext);

    await ChatRepo.createMessage(conversationId, "assistant", fullResponse, undefined, userMessage.id);
  }
}
