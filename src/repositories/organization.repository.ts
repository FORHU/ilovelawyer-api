import prisma from "../lib/prisma";
import { CasePermission, OrgRole, PackageSku } from "@prisma/client";

export default class OrganizationRepo {
  static async create(createdById: string, name: string, slug: string, packageSku: PackageSku = "PROFESSIONAL") {
    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name, slug, packageSku, createdById },
      });
      await tx.organizationMember.create({
        data: { organizationId: org.id, userId: createdById, role: "OWNER" },
      });
      return tx.organization.findUniqueOrThrow({
        where: { id: org.id },
        include: { members: true },
      });
    });
  }

  static async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  static async findById(id: string) {
    return prisma.organization.findUnique({ where: { id } });
  }

  static async listForUser(userId: string) {
    return prisma.organization.findMany({
      where: { members: { some: { userId } } },
      include: { members: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findByIdForUser(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: { id, members: { some: { userId } } },
      include: { members: { include: { user: { select: { id: true, email: true, name: true, username: true } } } } },
    });
  }

  static async addMember(organizationId: string, userId: string, role: OrgRole) {
    return prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, role },
      update: { role },
    });
  }

  static async removeMember(organizationId: string, userId: string) {
    return prisma.organizationMember.deleteMany({ where: { organizationId, userId } });
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

  static async attachCase(caseId: string, organizationId: string) {
    return prisma.case.update({ where: { id: caseId }, data: { organizationId } });
  }
}
