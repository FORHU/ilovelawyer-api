import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { getStableProxyFileUrl } from "../utils/s3";

const personSelect = { id: true, name: true, email: true, username: true, avatar: { select: { s3Key: true } } } as const;

function withAvatarUrl<T extends { avatar: { s3Key: string | null } | null }>({ avatar, ...user }: T) {
  return { ...user, avatarUrl: avatar?.s3Key ? getStableProxyFileUrl(avatar.s3Key) : null };
}

/** A portfolio case: one in a lawyer's own workspace (no organization, docs/adr/0022), or in a
 * client-app account's personal workspace. Owned by `ownerId` when given. */
function portfolioWhere(ownerId?: Prisma.StringFilter | string): Prisma.CaseWhereInput {
  return {
    OR: [
      { organizationId: null, ...(ownerId ? { userId: ownerId } : { userId: { not: null } }) },
      { organization: { isPersonal: true, ...(ownerId ? { createdById: ownerId } : {}) } },
    ],
  };
}

const ownerSelect = { tenantId: true, name: true, username: true } as const;

/** Read-only shares of portfolio cases (see portfolioWhere). They are ordinary CaseAccess rows;
 * what makes one a share is the case living in someone's portfolio. */
export default class CaseShareRepo {
  /** The case's portfolio facts, or null when it's an organization case (or doesn't exist). */
  static async findPortfolioCase(caseId: string) {
    const record = await prisma.case.findFirst({
      where: { id: caseId, ...portfolioWhere() },
      select: { id: true, copiedFromCaseId: true, userId: true, organizationId: true, organization: { select: { createdById: true } } },
    });
    if (!record) return null;
    const ownerId = record.organizationId ? (record.organization?.createdById ?? null) : record.userId;
    return { id: record.id, copiedFromCaseId: record.copiedFromCaseId, ownerId };
  }

  /** The case if it's in `ownerId`'s own portfolio — only the owner shares a portfolio case. */
  static async findOwnedPortfolioCase(caseId: string, ownerId: string) {
    const record = await prisma.case.findFirst({
      where: { id: caseId, ...portfolioWhere(ownerId) },
      select: {
        id: true,
        caseName: true,
        copiedFromCaseId: true,
        organizationId: true,
        user: { select: ownerSelect },
        organization: { select: { tenantId: true, createdBy: { select: ownerSelect } } },
      },
    });
    if (!record) return null;
    const { user, organization, ...rest } = record;
    const owner = organization ? organization.createdBy : user;
    // The site the case is on: the organization's, or the lawyer's own for their own workspace.
    return { ...rest, tenantId: organization ? organization.tenantId : (user?.tenantId ?? null), ownerName: owner?.name || owner?.username || null };
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
        ...portfolioWhere({ not: userId }),
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
        user: { select: personSelect },
        organization: { select: { createdBy: { select: personSelect } } },
      },
    });
    return rows.map(({ accesses, organization, user, ...row }) => {
      const owner = organization ? organization.createdBy : user;
      // The X-Organization-Id the case opens with: the owner's own workspace (`user:<id>`, no
      // organization), or a client-era personal workspace's id.
      const workspaceId = row.organizationId ?? (owner ? `user:${owner.id}` : null);
      return { ...row, workspaceId, sharedAt: accesses[0]?.createdAt ?? null, owner: owner ? withAvatarUrl(owner) : null };
    });
  }

  /** Removes `userId`'s share of a portfolio case. True when there was one. */
  static async removeShare(caseId: string, userId: string) {
    const result = await prisma.caseAccess.deleteMany({
      where: { caseId, userId, case: portfolioWhere() },
    });
    return result.count > 0;
  }
}
