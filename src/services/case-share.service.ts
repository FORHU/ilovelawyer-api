import CaseShareRepo from "../repositories/case-share.repository";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import { normalizeEmail } from "../utils/auth.utils";
import NotificationSvc from "./notification.service";
import SecurityAuditSvc from "./security-audit.service";
import logger from "../utils/logger";
import { emitToUser, removeUserFromCase } from "../lib/socket";

/** Tells the recipient's open tabs their shared cases changed: their "Shared with me" list
 * refreshes, and a tab that has this case open learns it's gone (see the app's socket handler). */
export const SHARED_CASES_CHANGED = "shared-cases:changed";

function shareEnded(caseId: string, userId: string) {
  // Their sockets leave the case room now, rather than keep receiving its live events.
  removeUserFromCase(userId, caseId);
  emitToUser(userId, SHARED_CASES_CHANGED, { caseId, shared: false });
}

/**
 * Sharing a portfolio case (a case in someone's personal workspace) with other registered users.
 * Unlike an organization case, which is shared among that organization's members, a portfolio case
 * goes to individual people the owner picks — and only to read:
 *  - only the owner shares it, and the share is always VIEW;
 *  - the recipient is a registered, approved user on the same site (tenant), never the owner;
 *  - a copy of an organization's case kept after leaving it is never shared — its client
 *    material belongs to that organization.
 * A recipient reaches the case as a guest of the owner's portfolio (see
 * resolveOrganizationAllowingGuests), where every write is refused.
 */
export default class CaseShareSvc {
  private static async loadShareable(caseId: string, ownerId: string) {
    const record = await CaseShareRepo.findOwnedPortfolioCase(caseId, ownerId);
    if (!record) throw new HttpError("Case not found or you can't share it", 404);
    if (record.copiedFromCaseId) {
      throw new HttpError("A copy of an organization's case can't be shared outside that organization", 400, "SHARE_COPY_NOT_ALLOWED");
    }
    return record;
  }

  private static async loadRecipient(where: { id: string } | { email: string }, ownerId: string, tenantId: string | undefined) {
    const user = await CaseShareRepo.findRecipient(where);
    // One answer for "no such user" and "a user on another site", so the lookup can't be used to
    // learn which addresses are registered elsewhere.
    if (!user || !tenantId || user.tenantId !== tenantId) {
      throw new HttpError("No registered user with that email", 404, "SHARE_NO_SUCH_USER");
    }
    if (user.id === ownerId) throw new HttpError("This is your own case", 400, "SHARE_SELF");
    const { tenantId: _tenantId, ...person } = user;
    return person;
  }

  /** The one user with exactly this email, for the share dialog to confirm before sharing. No
   * partial matching: this is not a way to browse who uses the app. */
  static async lookup(caseId: string, ownerId: string, email: string) {
    const record = await CaseShareSvc.loadShareable(caseId, ownerId);
    return CaseShareSvc.loadRecipient({ email: normalizeEmail(email) }, ownerId, record.organization?.tenantId);
  }

  static async grant(caseId: string, ownerId: string, userId: string, permission: string) {
    if (permission !== "VIEW") {
      throw new HttpError("A case from your portfolio can only be shared to view", 400, "SHARE_READ_ONLY");
    }
    const record = await CaseShareSvc.loadShareable(caseId, ownerId);
    const recipient = await CaseShareSvc.loadRecipient({ id: userId }, ownerId, record.organization?.tenantId);
    const access = await OrganizationRepo.grantCaseAccess(caseId, recipient.id, "VIEW");
    await OrganizationRepo.writeAudit({ caseId, actorId: ownerId, action: "case.grant_access", payload: { userId: recipient.id, permission: "VIEW", portfolio: true } });
    await SecurityAuditSvc.record({
      action: "case.access_granted",
      actorId: ownerId,
      organizationId: record.organizationId ?? null,
      targetType: "user",
      targetId: recipient.id,
      caseId,
      payload: { permission: "VIEW", portfolio: true },
    });

    const ownerName = record.organization?.createdBy.name || record.organization?.createdBy.username || "Someone";
    // No organizationId: the recipient isn't in the owner's portfolio, so the notification shows
    // wherever they are.
    await NotificationSvc.create({
      userId: recipient.id,
      type: "CASE_UPDATE",
      title: "A case was shared with you",
      message: `${ownerName} shared "${record.caseName}" with you to view`,
      link: "/homepage/case-portfolio?view=shared",
    }).catch((err) => logger.error("CaseShareSvc.grant: failed to create notification", { err, caseId, userId: recipient.id }));
    emitToUser(recipient.id, SHARED_CASES_CHANGED, { caseId, shared: true });

    return access;
  }

  /** The owner takes a share back. */
  static async revoke(caseId: string, ownerId: string, userId: string) {
    const record = await CaseShareRepo.findOwnedPortfolioCase(caseId, ownerId);
    if (!record) throw new HttpError("Case not found or you can't share it", 404);
    const removed = await CaseShareRepo.removeShare(caseId, userId);
    if (!removed) throw new HttpError("This case isn't shared with that person", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: ownerId, action: "case.revoke_access", payload: { userId, portfolio: true } });
    await SecurityAuditSvc.record({
      action: "case.access_revoked",
      actorId: ownerId,
      organizationId: record.organizationId ?? null,
      targetType: "user",
      targetId: userId,
      caseId,
      payload: { portfolio: true },
    });
    shareEnded(caseId, userId);
    await NotificationSvc.create({
      userId,
      type: "CASE_UPDATE",
      title: "A shared case was removed",
      message: `You no longer have access to "${record.caseName}"`,
    }).catch((err) => logger.error("CaseShareSvc.revoke: failed to create notification", { err, caseId, userId }));
  }

  /** The recipient drops a share they don't want. There's no accept step, so this is how they
   * keep their list to what they want. */
  static async leave(caseId: string, userId: string) {
    const removed = await CaseShareRepo.removeShare(caseId, userId);
    if (!removed) throw new HttpError("This case isn't shared with you", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "case.share_left", payload: { userId } });
    shareEnded(caseId, userId);
  }

  static async listShares(caseId: string) {
    return CaseShareRepo.listShares(caseId);
  }

  static async listSharedWithMe(userId: string) {
    return CaseShareRepo.listSharedWith(userId);
  }
}
