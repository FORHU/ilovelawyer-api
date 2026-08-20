import prisma from "../lib/prisma";
import { OrgRole } from "@prisma/client";

export default class OrganizationMemberRepo {
  static async list(organizationId: string) {
    return prisma.organizationMember.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
      orderBy: { joinedAt: "asc" },
    });
  }

  static async find(organizationId: string, userId: string) {
    return prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }

  /**
   * A user's first org membership — for contexts with no X-Organization-Id header to resolve
   * against, e.g. the Google Calendar webhook, which only carries a userId. A user can belong
   * to more than one org, so this is a best-effort pick (oldest membership), not a guarantee.
   */
  static async findAnyForUser(userId: string) {
    return prisma.organizationMember.findFirst({ where: { userId }, orderBy: { joinedAt: "asc" } });
  }

  static async countByRole(organizationId: string, role: OrgRole) {
    return prisma.organizationMember.count({ where: { organizationId, role } });
  }

  static async add(organizationId: string, userId: string, role: OrgRole) {
    return prisma.organizationMember.create({
      data: { organizationId, userId, role },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
    });
  }

  static async updateRole(organizationId: string, userId: string, role: OrgRole) {
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
