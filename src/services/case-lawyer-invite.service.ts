import crypto from "crypto";
import type { CaseLawyerInviteStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import CaseLawyerInviteRepo from "../repositories/case-lawyer-invite.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import { CASE_LAWYER_INVITE_EXPIRY_MS } from "../constants/case-lawyer-invite.constants";

/** The invite as the client app reads it (InviteStatusDto in the contract): just enough to show
 * where it stands, never the token (that's only ever handed back once, at creation). */
export interface InviteStatusDto {
  status: CaseLawyerInviteStatus;
  email: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/** Sends the lawyer their invite email. A no-op for now — Task 9 replaces this with the real send
 * (the link/email invite content and delivery aren't this task's job). */
async function sendInviteEmail(_invite: { token: string; email: string }): Promise<void> {}

/**
 * A client inviting their own lawyer onto a case (client-invites-own-lawyer): a link or email
 * invite, superseding any still-pending one on the case, so a case ever has at most one live
 * invite. Blocked once the case already has an ENGAGED lawyer through the marketplace flow.
 */
export default class CaseLawyerInviteSvc {
  /** A shareable link invite: the client sends the token themselves. */
  static async createLinkInvite(clientId: string, caseId: string): Promise<{ token: string; expiresAt: Date }> {
    return CaseLawyerInviteSvc.createInvite(clientId, caseId, null);
  }

  /** An invite emailed straight to the lawyer. Email delivery is stubbed (sendInviteEmail) until
   * Task 9 wires it up. */
  static async createEmailInvite(clientId: string, caseId: string, email: string): Promise<{ token: string; expiresAt: Date }> {
    const invite = await CaseLawyerInviteSvc.createInvite(clientId, caseId, email);
    await sendInviteEmail({ token: invite.token, email });
    return invite;
  }

  /** Revokes any pending invite on the case and creates the new one in its place, in one
   * transaction, so the case never has two live invites even if this races. */
  private static async createInvite(clientId: string, caseId: string, email: string | null): Promise<{ token: string; expiresAt: Date }> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    await CaseLawyerInviteSvc.assertNoLiveLawyer(caseId);
    const invite = await prisma.$transaction(async (tx) => {
      await CaseLawyerInviteRepo.revokePendingForCase(caseId, tx);
      return CaseLawyerInviteRepo.create({ caseId, clientId, email, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + CASE_LAWYER_INVITE_EXPIRY_MS) }, tx);
    });
    return { token: invite.token, expiresAt: invite.expiresAt };
  }

  /** The case's current invite, however it stands — null once there's never been one, or the only
   * one has been revoked, accepted or expired (findPendingForCase only sees PENDING rows; showing
   * the client their invite's outcome once it's no longer pending is a gap left for later). */
  static async getCurrentForCase(clientId: string, caseId: string): Promise<InviteStatusDto | null> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    const invite = await CaseLawyerInviteRepo.findPendingForCase(caseId);
    if (!invite) return null;
    return { status: invite.status, email: invite.email, expiresAt: invite.expiresAt, acceptedAt: invite.acceptedAt, revokedAt: invite.revokedAt };
  }

  /** Revokes the case's pending invite. 404 INVITE_NOT_FOUND when there was none to revoke. */
  static async revoke(clientId: string, caseId: string): Promise<void> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    const pending = await CaseLawyerInviteRepo.findPendingForCase(caseId);
    if (!pending) throw new HttpError("There's no pending invite to revoke.", 404, "INVITE_NOT_FOUND");
    await CaseLawyerInviteRepo.revokePendingForCase(caseId);
  }

  /** 404 when the case isn't the client's own (matches ClientRequestSvc/ClientCaseSvc's "Case not
   * found" convention for a client reaching for a case that isn't theirs). */
  private static async assertOwnsCase(clientId: string, caseId: string): Promise<void> {
    const row = await prisma.case.findFirst({ where: { id: caseId, userId: clientId }, select: { id: true } });
    if (!row) throw new HttpError("Case not found", 404);
  }

  /** 409 CASE_HAS_LAWYER when the case already has a lawyer engaged on it through the marketplace
   * flow (ClientRequestRepo.findEngagedLawyerForCase — the same "is anyone live on this case"
   * check the marketplace flow itself relies on). */
  private static async assertNoLiveLawyer(caseId: string): Promise<void> {
    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    if (engaged) throw new HttpError("This case already has a lawyer. End that engagement before inviting another.", 409, "CASE_HAS_LAWYER");
  }
}
