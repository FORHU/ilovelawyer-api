import ParticipantRepo from "../repositories/participant.repository";
import ChatRepo from "../repositories/chat.repository";
import HttpError from "../utils/http-error";

export default class ParticipantSvc {
  static async list(userId: string, conversationId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }
    return ParticipantRepo.list(conversationId);
  }

  static async remove(userId: string, conversationId: string, targetUserId: string) {
    const conversation = await ChatRepo.findConversationById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new HttpError("Conversation not found", 404);
    }
    const exists = await ParticipantRepo.exists(conversationId, targetUserId);
    if (!exists) throw new HttpError("Participant not found", 404);
    return ParticipantRepo.remove(conversationId, targetUserId);
  }
}
