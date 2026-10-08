import InviteRepo from "../repositories/invite.repository";
import ParticipantRepo from "../repositories/participant.repository";
import ChatRepo from "../repositories/chat.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";

const INVITE_TTL_HOURS = 48;
const SHARE_CASE_ONLY_MESSAGE = "Only case consultations can be shared";

export default class InviteSvc {
  static async create(userId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.userId !== userId) {
      throw new HttpError("Consultation not found", 404);
    }
    // A standalone Consultation is private to its creator — only a Case's can be shared.
    if (!consultation.caseId) throw new HttpError(SHARE_CASE_ONLY_MESSAGE, 400);

    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
    const invite = await InviteRepo.create(consultationId, userId, expiresAt);
    await SecurityAuditSvc.record({
      action: "consultation.invite_created",
      actorId: userId,
      organizationId: consultation.organizationId ?? undefined,
      targetType: "invite",
      targetId: invite.id,
      payload: { consultationId, expiresAt: expiresAt.toISOString() },
    });
    return invite;
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
    // Also refuses invites created before sharing was limited to Case consultations.
    const consultation = await ChatRepo.findConsultationById(invite.consultationId);
    if (!consultation) throw new HttpError("Invite not found", 404);
    if (!consultation.caseId) throw new HttpError(SHARE_CASE_ONLY_MESSAGE, 400);

    await ParticipantRepo.add(invite.consultationId, userId);
    await SecurityAuditSvc.record({
      action: "consultation.invite_accepted",
      actorId: userId,
      targetType: "invite",
      targetId: inviteId,
      payload: { consultationId: invite.consultationId, invitedBy: invite.createdBy },
    });
    return { consultationId: invite.consultationId };
  }

  static async delete(userId: string, inviteId: string) {
    const invite = await InviteRepo.findById(inviteId);
    if (!invite) throw new HttpError("Invite not found", 404);
    if (invite.createdBy !== userId) throw new HttpError("Forbidden", 403);
    const deleted = await InviteRepo.delete(inviteId);
    await SecurityAuditSvc.record({
      action: "consultation.invite_deleted",
      actorId: userId,
      targetType: "invite",
      targetId: inviteId,
      payload: { consultationId: invite.consultationId },
    });
    return deleted;
  }
}
