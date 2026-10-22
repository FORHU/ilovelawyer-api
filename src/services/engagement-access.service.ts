import OrganizationRepo from "../repositories/organization.repository";
import SecurityAuditSvc from "./security-audit.service";
import { SHARED_CASES_CHANGED } from "./case-share.service";
import { emitToUser, removeUserFromCase } from "../lib/socket";

export interface Engagement {
  requestId: string;
  caseId: string;
  lawyerId: string;
}

/**
 * The read-only access an engaged lawyer has on the client's case (#514, ADR 0016): a VIEW
 * CaseAccess grant, same as CaseShareSvc makes for a portfolio share, except the system makes it
 * once the client's per-case fee is paid rather than the case owner choosing to share. Revoked
 * the same way a share is revoked — on close (#519) or reassignment — by either side ending the
 * engagement, not by the lawyer.
 */
export default class EngagementAccessSvc {
  static async grant(engagement: Engagement & { organizationId: string }) {
    const { requestId, caseId, lawyerId, organizationId } = engagement;
    await OrganizationRepo.grantCaseAccess(caseId, lawyerId, "VIEW");
    await SecurityAuditSvc.record({
      action: "case.access_granted",
      actorId: null,
      organizationId,
      targetType: "user",
      targetId: lawyerId,
      caseId,
      payload: { permission: "VIEW", requestId, engagement: true },
    });
    emitToUser(lawyerId, SHARED_CASES_CHANGED, { caseId, shared: true });
  }

  /** Returns whether there was a grant to take back. */
  static async revoke(engagement: Engagement): Promise<boolean> {
    const { requestId, caseId, lawyerId } = engagement;
    const removed = await OrganizationRepo.revokeCaseAccess(caseId, lawyerId);
    if (!removed) return false;
    await SecurityAuditSvc.record({
      action: "case.access_revoked",
      actorId: null,
      organizationId: null,
      targetType: "user",
      targetId: lawyerId,
      caseId,
      payload: { requestId, engagement: true },
    });
    // Their sockets leave the case room now, rather than keep receiving its live events.
    removeUserFromCase(lawyerId, caseId);
    emitToUser(lawyerId, SHARED_CASES_CHANGED, { caseId, shared: false });
    return true;
  }
}
