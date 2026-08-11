import ParticipantRepo from "../repositories/participant.repository";
import ChatRepo from "../repositories/chat.repository";
import HttpError from "../utils/http-error";

export default class ParticipantSvc {
  static async list(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    return ParticipantRepo.list(consultationId);
  }

  static async remove(userId: string, consultationId: string, targetUserId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    const exists = await ParticipantRepo.exists(consultationId, targetUserId);
    if (!exists) throw new HttpError("Participant not found", 404);
    return ParticipantRepo.remove(consultationId, targetUserId);
  }
}
