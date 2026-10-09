import prisma from "../lib/prisma";
import { getStableProxyFileUrl } from "../utils/s3";

const personSelect = { id: true, name: true, email: true, username: true, avatar: { select: { s3Key: true } } } as const;

function withAvatarUrl<T extends { avatar: { s3Key: string | null } | null }>({ avatar, ...user }: T) {
  return { ...user, avatarUrl: avatar?.s3Key ? getStableProxyFileUrl(avatar.s3Key) : null };
}

/** Read-only shares of portfolio cases (a portfolio is a user's personal workspace). They are
 * ordinary CaseAccess rows; what makes one a share is the case living in someone's portfolio. */
export default class CaseShareRepo {
  /** The case's portfolio facts, or null when it's an organization case (or doesn't exist). */
  static async findPortfolioCase(caseId: string) {
    return prisma.case.findFirst({
      where: { id: caseId, organization: { isPersonal: true } },
      select: { id: true, copiedFromCaseId: true, organization: { select: { createdById: true } } },
    });
  }

  /** The case if it's in `ownerId`'s own portfolio — only the owner shares a portfolio case. */
  static async findOwnedPortfolioCase(caseId: string, ownerId: string) {
    return prisma.case.findFirst({
      where: { id: caseId, organization: { isPersonal: true, createdById: ownerId } },
      select: {
        id: true,
        caseName: true,
        copiedFromCaseId: true,
        organizationId: true,
        organization: { select: { tenantId: true, createdBy: { select: { name: true, username: true } } } },
      },
    });
  }

  /** Who can be shared with: anyone registered, approved and not on the way out. */
  static async findRecipient(where: { id: string } | { email: string }) {
    const user = await prisma.user.findFirst({
      where: { ...where, approvalStatus: "ACTIVE", deletionRequestedAt: null },
      select: { ...personSelect, tenantId: true },
    });
    return user ? withAvatarUrl(user) : null;
  }

  /** The people a portfolio case is shared with, oldest share first. */
  static async listShares(caseId: string) {
    const rows = await prisma.caseAccess.findMany({
      where: { caseId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, permission: true, user: { select: personSelect } },
    });
    return rows.map(({ user, ...row }) => ({ ...row, user: withAvatarUrl(user) }));
  }

  /** Portfolio cases other people shared with `userId`. Copies of an organization's case are
   * left out even if a share was stored for one, since they can never be shared. */
  static async listSharedWith(userId: string) {
    const rows = await prisma.case.findMany({
      where: {
        status: "ACTIVE",
        copiedFromCaseId: null,
        organization: { isPersonal: true, createdById: { not: userId } },
        accesses: { some: { userId } },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        caseName: true,
        updatedAt: true,
        organizationId: true,
        parties: { select: { name: true } },
        accesses: { where: { userId }, select: { createdAt: true } },
        organization: { select: { createdBy: { select: personSelect } } },
      },
    });
    return rows.map(({ accesses, organization, ...row }) => ({
      ...row,
      sharedAt: accesses[0]?.createdAt ?? null,
      owner: organization ? withAvatarUrl(organization.createdBy) : null,
    }));
  }

  /** Removes `userId`'s share of a portfolio case. True when there was one. */
  static async removeShare(caseId: string, userId: string) {
    const result = await prisma.caseAccess.deleteMany({
      where: { caseId, userId, case: { organization: { isPersonal: true } } },
    });
    return result.count > 0;
  }
}
