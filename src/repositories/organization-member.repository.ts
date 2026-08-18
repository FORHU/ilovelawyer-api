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

  static async find(organizationId: string, userId: string) {
    return prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }

  /**
   * A user's earliest/default org membership — for contexts with no X-Organization-Id header
   * to resolve against, e.g. the Google Calendar webhook, which only carries a userId.
   */
  static async findPrimaryForUser(userId: string) {
    return prisma.organizationMember.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
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
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    });
  }

  static async remove(organizationId: string, userId: string) {
    return prisma.organizationMember.delete({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }
}
