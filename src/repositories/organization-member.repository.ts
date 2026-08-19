import prisma from "../lib/prisma";
import { OrganizationRole } from "@prisma/client";

export default class OrganizationMemberRepo {
  static async list(organizationId: string) {
    return prisma.organizationMember.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  /** userId is globally unique (a user belongs to at most one org), so this also verifies
   * the membership found actually belongs to the given organizationId. */
  static async find(organizationId: string, userId: string) {
    const membership = await prisma.organizationMember.findUnique({ where: { userId } });
    return membership && membership.organizationId === organizationId ? membership : null;
  }

  /**
   * A user's (guaranteed-singular) org membership — for contexts with no X-Organization-Id
   * header to resolve against, e.g. the Google Calendar webhook, which only carries a userId.
   */
  static async findAnyForUser(userId: string) {
    return prisma.organizationMember.findUnique({ where: { userId } });
  }

  static async countByRole(organizationId: string, role: OrganizationRole) {
    return prisma.organizationMember.count({ where: { organizationId, role } });
  }

  static async add(organizationId: string, userId: string, role: OrganizationRole) {
    return prisma.organizationMember.create({
      data: { organizationId, userId, role },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
    });
  }

  static async updateRole(organizationId: string, userId: string, role: OrganizationRole) {
    return prisma.organizationMember.update({
      where: { userId },
      data: { role },
    });
  }

  static async remove(organizationId: string, userId: string) {
    return prisma.organizationMember.delete({
      where: { userId },
    });
  }
}
