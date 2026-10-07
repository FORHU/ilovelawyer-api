import prisma from "../lib/prisma";
import { CasePermission, OrganizationRole, OrganizationMemberStatus, PackageSku } from "@prisma/client";

export default class OrganizationRepo {
  /** Creates the org and its first membership (creator as OWNER, ACCEPTED) atomically.
   * `tenantId` must already be trusted-resolved by the caller (see
   * resolveTenantCodeFromRequest / TenantRepo.findIdByCode) — this layer just persists
   * whatever it's given. `parkCurrent` first drops the creator's current membership — their
   * personal workspace, which stays behind as their portfolio. */
  static async create(
    createdById: string,
    name: string,
    slug: string,
    packageSku: PackageSku = "PROFESSIONAL",
    tenantId: string,
    isPersonal = false,
    { parkCurrent = false }: { parkCurrent?: boolean } = {},
  ) {
    return prisma.$transaction(async (tx) => {
      if (parkCurrent) await tx.organizationMember.deleteMany({ where: { userId: createdById } });
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
   * org through an invite (see OrganizationInviteRepo.accept). Its data is still there, so
   * skipping onboarding again (or leaving that org) brings it back. */
  static async findDormantPersonal(userId: string, tenantId?: string) {
    return prisma.organization.findFirst({
      where: { createdById: userId, isPersonal: true, members: { none: {} }, ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Puts the user back into their own personal workspace (as its OWNER). Same return shape as
   * create(). */
  static async activatePersonal(organizationId: string, userId: string, { addMember }: { addMember: boolean }) {
    return prisma.$transaction(async (tx) => {
      if (addMember) {
        await tx.organizationMember.create({
          data: { organizationId, userId, role: OrganizationRole.OWNER, status: OrganizationMemberStatus.ACCEPTED },
        });
      }
      return tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        include: { members: true, tenant: { select: { code: true } } },
      });
    });
  }

  /** The user's personal workspace in a tenant, whether or not they're currently in it — while
   * they belong to an organization it's their portfolio (see OrganizationSvc.getPortfolio). */
  static async findPersonal(userId: string, tenantId: string) {
    return prisma.organization.findFirst({
      where: { createdById: userId, isPersonal: true, tenantId },
      orderBy: { createdAt: "desc" },
      include: { tenant: { select: { code: true } } },
    });
  }

  /** A personal workspace for someone who's in an organization right now, so it has no member —
   * it's only their portfolio until they leave. */
  static async createPersonalWithoutMember(createdById: string, name: string, slug: string, tenantId: string) {
    return prisma.organization.create({
      data: { name, slug, packageSku: "SOLO", createdById, tenantId, isPersonal: true },
      include: { tenant: { select: { code: true } } },
    });
  }

  /** `id` if it is `userId`'s own personal workspace — which they can always open (their
   * portfolio), member or not. */
  static async findOwnPersonal(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: { id, isPersonal: true, createdById: userId },
      select: { id: true, tenant: { select: { code: true } } },
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

  /** Orgs the given user is an ACCEPTED member of, with their role in each. An invite
   * doesn't count as belonging yet — see OrganizationInviteRepo. */
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
