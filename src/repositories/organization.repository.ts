import prisma from "../lib/prisma";
import { CasePermission, OrganizationRole, OrganizationMemberStatus, PackageSku } from "@prisma/client";

export default class OrganizationRepo {
  /** Creates the org and its first membership (creator as OWNER, ACCEPTED) atomically.
   * `tenantId` must already be trusted-resolved by the caller (see
   * resolveTenantCodeFromRequest / TenantRepo.findIdByCode) — this layer just persists
   * whatever it's given. */
  static async create(
    createdById: string,
    name: string,
    slug: string,
    packageSku: PackageSku = "PROFESSIONAL",
    tenantId: string,
    isPersonal = false,
  ) {
    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name, slug, packageSku, createdById, tenantId, isPersonal },
      });
      await tx.organizationMember.create({
        data: { organizationId: org.id, userId: createdById, role: OrganizationRole.OWNER, status: OrganizationMemberStatus.ACCEPTED },
      });
      return tx.organization.findUniqueOrThrow({
        where: { id: org.id },
        include: { members: true, tenant: { select: { code: true } } },
      });
    });
  }

  /** A personal workspace the user created but no longer belongs to — they joined another
   * org through an invite (see OrganizationMemberRepo.replaceWithInvite). Its data is still
   * there, so skipping onboarding again (or declining that invite) brings it back. */
  static async findDormantPersonal(userId: string, tenantId?: string) {
    return prisma.organization.findFirst({
      where: { createdById: userId, isPersonal: true, members: { none: {} }, ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Puts the user back into their own personal workspace (as its OWNER). `promote` also
   * turns it into a real organization in the same transaction — name, slug and plan replace
   * the personal placeholders, and everything already in it (cases, consultations, ...)
   * carries over. Same return shape as create(). */
  static async activatePersonal(
    organizationId: string,
    userId: string,
    { addMember, promote }: { addMember: boolean; promote?: { name: string; slug: string; packageSku: PackageSku } },
  ) {
    return prisma.$transaction(async (tx) => {
      if (addMember) {
        await tx.organizationMember.create({
          data: { organizationId, userId, role: OrganizationRole.OWNER, status: OrganizationMemberStatus.ACCEPTED },
        });
      }
      if (promote) {
        await tx.organization.update({ where: { id: organizationId }, data: { ...promote, isPersonal: false } });
      }
      return tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        include: { members: true, tenant: { select: { code: true } } },
      });
    });
  }

  static async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  static async findById(id: string) {
    return prisma.organization.findUnique({ where: { id } });
  }

  static async findByIdForUser(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: { id, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, username: true } } } },
        tenant: { select: { code: true } },
      },
    });
  }

  /** Orgs the given user is an ACCEPTED member of, with their role in each. A PENDING
   * invite doesn't count as belonging yet — see OrganizationMemberRepo.findPendingForUser. */
  static async listForUser(userId: string) {
    return prisma.organization.findMany({
      where: { members: { some: { userId, status: OrganizationMemberStatus.ACCEPTED } } },
      orderBy: { createdAt: "asc" },
      include: {
        members: { where: { userId, status: OrganizationMemberStatus.ACCEPTED }, select: { role: true } },
        tenant: { select: { code: true } },
      },
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
