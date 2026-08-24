import prisma from "../lib/prisma";
import { CasePermission, OrganizationMemberStatus } from "@prisma/client";

export default class OrganizationRepo {
  /** Creates the org and its first membership (creator as OWNER) atomically. */
  static async createWithOwner(userId: string, data: { name: string; slug: string }) {
    return prisma.organization.create({
      data: {
        ...data,
        createdById: userId,
        members: { create: { userId, role: "OWNER" } },
      },
      include: { members: true },
    });
  }

  static async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  static async findById(id: string) {
    return prisma.organization.findUnique({ where: { id } });
  }

  /** Orgs the given user is an ACCEPTED member of, with their role in each. A PENDING
   * invite doesn't count as belonging yet — see OrganizationMemberRepo.findPendingForUser. */
  static async listForUser(userId: string) {
    return prisma.organization.findMany({
      where: { members: { some: { userId, status: OrganizationMemberStatus.ACCEPTED } } },
      orderBy: { createdAt: "asc" },
      include: { members: { where: { userId, status: OrganizationMemberStatus.ACCEPTED }, select: { role: true } } },
    });
  }

  static async update(id: string, data: { name?: string; slug?: string }) {
    return prisma.organization.update({ where: { id }, data });
  }

  // ── Case access / audit (ADR: per-case sharing within an org — see CaseAccess/AuditEvent) ──

  static async attachCase(caseId: string, organizationId: string) {
    return prisma.case.update({ where: { id: caseId }, data: { organizationId } });
  }

  static async grantCaseAccess(caseId: string, userId: string, permission: CasePermission) {
    return prisma.caseAccess.upsert({
      where: { caseId_userId: { caseId, userId } },
      create: { caseId, userId, permission },
      update: { permission },
    });
  }

  static async listCaseAccess(caseId: string) {
    return prisma.caseAccess.findMany({
      where: { caseId },
      include: { user: { select: { id: true, email: true, name: true, username: true } } },
    });
  }

  static async listAudit(caseId: string) {
    return prisma.auditEvent.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  static async writeAudit(data: { caseId?: string; actorId?: string; action: string; payload?: object }) {
    return prisma.auditEvent.create({ data });
  }
}
