import prisma from "../lib/prisma";
import { DELETION_BLOCKING_REQUEST_STATUSES } from "../constants/client-request.constants";

const OPEN_CLAIMS = { where: { outcome: null }, select: { outcome: true, quotedAt: true } } as const;

/** What the Support Actions read about one client (SupportActionSvc, DeletionBlockSvc). */
export default class SupportActionRepo {
  /** The client's requests that block deleting their account, oldest first. */
  static async deletionBlockingRequests(clientId: string) {
    return prisma.clientRequest.findMany({
      where: { clientId, status: { in: [...DELETION_BLOCKING_REQUEST_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, caseId: true, status: true, case: { select: { caseName: true } }, claims: OPEN_CLAIMS },
    });
  }

  /** The client's latest requests, any status, newest first. */
  static async recentRequests(clientId: string, take: number) {
    return prisma.clientRequest.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        caseId: true,
        status: true,
        routingExpiresAt: true,
        pickByAt: true,
        case: { select: { caseName: true } },
        claims: { where: { OR: [{ outcome: null }, { outcome: "ENGAGED" }] }, orderBy: { claimedAt: "asc" }, select: { outcome: true, quotedAt: true, lawyer: { select: { name: true } } } },
      },
    });
  }

  /** The client's payments since `since`, newest first. */
  static async recentPayments(userId: string, since: Date, take: number) {
    return prisma.clientPayment.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, kind: true, status: true, amountMinor: true, currency: true, credits: true, caseId: true, failureReason: true, createdAt: true, externalId: true, case: { select: { caseName: true } } },
    });
  }

  /** Chat credits left on each of the client's active cases. */
  static async creditsByCase(workspaceId: string) {
    return prisma.case.findMany({
      where: { organizationId: workspaceId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, caseName: true, clientCredits: true },
    });
  }

  static async emailOf(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { email: true, password: true, provider: true } });
  }
}
