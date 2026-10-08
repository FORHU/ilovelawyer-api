import ParticipantRepo from "../repositories/participant.repository";
import ChatRepo from "../repositories/chat.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";

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
    const removed = await ParticipantRepo.remove(consultationId, targetUserId);
    await SecurityAuditSvc.record({
      action: "consultation.participant_removed",
      actorId: userId,
      organizationId: consultation.organizationId ?? undefined,
      targetType: "user",
      targetId: targetUserId,
      payload: { consultationId },
    });
    return removed;
  }
}
