import prisma from "../lib/prisma";
import { OrganizationRole, OrganizationMemberStatus, Prisma } from "@prisma/client";
import OrganizationMemberRepo from "./organization-member.repository";
import { getStableProxyFileUrl } from "../utils/s3";

export default class OrganizationInviteRepo {
  /** The user's outstanding invite, if any (userId is unique — one at a time). The organization
   * carries its tenant code: the app activates it straight from this record on accept, and
   * can't without one (see toActiveOrg). */
  static async findForUser(userId: string) {
    return prisma.organizationInvite.findUnique({
      where: { userId },
      include: { organization: { include: { tenant: { select: { code: true } } } } },
    });
  }

  /** Same `user` shape as OrganizationMemberRepo.list, so the two can share one members list. */
  static async list(organizationId: string) {
    const invites = await prisma.organizationInvite.findMany({
      where: { organizationId },
      include: {
        user: { select: { id: true, name: true, email: true, username: true, avatar: { select: { s3Key: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return invites.map(({ user: { avatar, ...user }, ...invite }) => ({
      ...invite,
      user: { ...user, avatarUrl: avatar?.s3Key ? getStableProxyFileUrl(avatar.s3Key) : null },
    }));
  }

  static async create(organizationId: string, userId: string, role: OrganizationRole) {
    return prisma.organizationInvite.create({
      data: { organizationId, userId, role },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
    });
  }

  static async delete(userId: string) {
    return prisma.organizationInvite.delete({ where: { userId } });
  }

  /** Moves the user into the inviting organization in one transaction: their current membership
   * (if any) goes the same way OrganizationMemberRepo.remove takes it, the invite is used up,
   * and they join with the invited role. `andThen` runs in the same transaction. */
  static async accept(
    invite: { organizationId: string; userId: string; role: OrganizationRole },
    current: { organizationId: string } | null,
    andThen?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    return prisma.$transaction(async (tx) => {
      if (current) await OrganizationMemberRepo.removeIn(tx, current.organizationId, invite.userId);
      if (andThen) await andThen(tx);
      await tx.organizationInvite.delete({ where: { userId: invite.userId } });
      return tx.organizationMember.create({
        data: {
          organizationId: invite.organizationId,
          userId: invite.userId,
          role: invite.role,
          status: OrganizationMemberStatus.ACCEPTED,
        },
      });
    });
  }
}
