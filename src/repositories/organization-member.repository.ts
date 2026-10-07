import prisma from "../lib/prisma";
import { OrganizationRole, OrganizationMemberStatus, Prisma } from "@prisma/client";
import { getStableProxyFileUrl } from "../utils/s3";

export default class OrganizationMemberRepo {
  /** Each member's `user` carries `avatarUrl` (null → the app shows initials), same as /me. */
  static async list(organizationId: string) {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: { select: { id: true, name: true, email: true, username: true, avatar: { select: { s3Key: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return members.map(({ user: { avatar, ...user }, ...member }) => ({
      ...member,
      user: { ...user, avatarUrl: avatar?.s3Key ? getStableProxyFileUrl(avatar.s3Key) : null },
    }));
  }

  /** userId is globally unique (a user belongs to at most one org), so this also verifies
   * the membership found actually belongs to the given organizationId. Invitations aren't
   * memberships — see OrganizationInviteRepo. Includes the organization's
   * tenant code so requireMembership can populate TenantContext without a second query. */
  static async find(organizationId: string, userId: string) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId },
      include: { organization: { select: { tenant: { select: { code: true } } } } },
    });
    return membership && membership.organizationId === organizationId ? membership : null;
  }

  /**
   * A user's (guaranteed-singular) org membership — for contexts with no X-Organization-Id
   * header to resolve against, e.g. the Google Calendar webhook, which only carries a userId.
   * Includes the organization's tenant code so login-time tenant-exclusivity checks
   * (see AuthSvc.assertTenantAccess) don't need a second query.
   */
  static async findAnyForUser(userId: string) {
    return prisma.organizationMember.findUnique({
      where: { userId },
      include: {
        organization: { select: { name: true, isPersonal: true, tenantId: true, tenant: { select: { code: true } } } },
      },
    });
  }

  static async countByRole(organizationId: string, role: OrganizationRole) {
    return prisma.organizationMember.count({ where: { organizationId, role } });
  }

  static async add(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    status: OrganizationMemberStatus = OrganizationMemberStatus.ACCEPTED,
  ) {
    return prisma.organizationMember.create({
      data: { organizationId, userId, role, status },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
    });
  }

  static async updateRole(organizationId: string, userId: string, role: OrganizationRole) {
    return prisma.organizationMember.update({
      where: { userId },
      data: { role },
    });
  }

  static async updateStatus(userId: string, status: OrganizationMemberStatus) {
    return prisma.organizationMember.update({
      where: { userId },
      data: { status },
    });
  }

  /** Also revokes the user's per-case grants (CaseAccess) on this org's cases — CaseAccess
   * honours those grants on its own, so they'd otherwise outlive the membership and keep
   * the case readable from whichever workspace the user lands in next. */
  /** `andThen` runs in the same transaction — e.g. queueing the leaver's portfolio copies. */
  static async remove(
    organizationId: string,
    userId: string,
    andThen?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    return prisma.$transaction(async (tx) => {
      const removed = await OrganizationMemberRepo.removeIn(tx, organizationId, userId);
      if (andThen) await andThen(tx);
      return removed;
    });
  }

  /** remove(), inside a transaction the caller already holds. */
  static async removeIn(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
    await tx.caseAccess.deleteMany({ where: { userId, case: { organizationId } } });
    return tx.organizationMember.delete({ where: { userId } });
  }
}
