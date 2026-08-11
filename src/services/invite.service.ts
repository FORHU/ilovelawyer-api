import InviteRepo from "../repositories/invite.repository";
import ParticipantRepo from "../repositories/participant.repository";
import ChatRepo from "../repositories/chat.repository";
import HttpError from "../utils/http-error";

const INVITE_TTL_HOURS = 48;

export default class InviteSvc {
  static async create(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
    return InviteRepo.create(consultationId, userId, expiresAt);
  }

  static async getById(id: string) {
    const invite = await InviteRepo.findById(id);
    if (!invite) throw new HttpError("Invite not found", 404);
    return invite;
  }

  static async listByConsultation(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    return InviteRepo.listByConsultation(consultationId);
  }

  static async accept(userId: string, inviteId: string) {
    const invite = await InviteRepo.findById(inviteId);
    if (!invite) throw new HttpError("Invite not found", 404);
    if (invite.expiresAt < new Date()) throw new HttpError("Invite has expired", 410);

    await ParticipantRepo.add(invite.consultationId, userId);
    return { consultationId: invite.consultationId };
  }

  static async delete(userId: string, inviteId: string) {
    const invite = await InviteRepo.findById(inviteId);
    if (!invite) throw new HttpError("Invite not found", 404);
    if (invite.createdBy !== userId) throw new HttpError("Forbidden", 403);
    return InviteRepo.delete(inviteId);
  }
}
