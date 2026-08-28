import prisma from "../lib/prisma";
import { OrganizationRole, OrganizationMemberStatus } from "@prisma/client";

export default class OrganizationMemberRepo {
  static async list(organizationId: string) {
    return prisma.organizationMember.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  /** userId is globally unique (a user belongs to at most one org), so this also verifies
   * the membership found actually belongs to the given organizationId. Returns a membership
   * regardless of status (PENDING or ACCEPTED) — callers that need to gate on acceptance
   * (e.g. requireMembership) must check `.status` themselves. Includes the organization's
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
      include: { organization: { select: { tenant: { select: { code: true } } } } },
    });
  }

  /** The caller's own pending invite, if any — used by the accept/decline endpoints, which
   * aren't scoped to an already-known organizationId. */
  static async findPendingForUser(userId: string) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId },
      include: { organization: true },
    });
    return membership && membership.status === OrganizationMemberStatus.PENDING ? membership : null;
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

  static async remove(organizationId: string, userId: string) {
    return prisma.organizationMember.delete({
      where: { userId },
    });
  }
}
