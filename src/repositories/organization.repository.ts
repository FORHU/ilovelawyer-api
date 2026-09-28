import prisma from "../lib/prisma";
import { emitToCase } from "../lib/socket";
import { toAuditEntry } from "../utils/case-team";
import logger from "../utils/logger";
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
  ) {
    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name, slug, packageSku, createdById, tenantId },
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
      include: { actor: { select: { id: true, email: true, name: true, username: true } } },
    });
  }

  static async writeAudit(data: { caseId?: string; actorId?: string; action: string; payload?: object }) {
    const row = await prisma.auditEvent.create({
      data,
      include: { actor: { select: { id: true, email: true, name: true, username: true } } },
    });
    // Live push to everyone viewing the case's Terminal (Team & Audit's "Live"). Best-effort —
    // the row is already saved and a client that misses this reconciles from the snapshot.
    if (row.caseId) {
      try {
        emitToCase(row.caseId, "audit:new", toAuditEntry(row));
      } catch (err) {
        logger.warn("writeAudit: audit:new push failed", { err, caseId: row.caseId });
      }
    }
    return row;
  }
}
