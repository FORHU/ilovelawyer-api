import { Prisma, SecurityAuditOutcome } from "@prisma/client";
import prisma from "../lib/prisma";

export interface SecurityAuditFilter {
  /** undefined = every organization (platform admins); null = only rows with no organization. */
  organizationId?: string | null;
  actorId?: string;
  caseId?: string;
  /** An exact action, or a prefix ending in "." ("auth.") for a whole group. */
  action?: string;
  outcome?: SecurityAuditOutcome;
  from?: Date;
  to?: Date;
}

function toWhere(filter: SecurityAuditFilter): Prisma.SecurityAuditEventWhereInput {
  const where: Prisma.SecurityAuditEventWhereInput = {};
  if (filter.organizationId !== undefined) where.organizationId = filter.organizationId;
  if (filter.actorId) where.actorId = filter.actorId;
  if (filter.caseId) where.caseId = filter.caseId;
  if (filter.action) where.action = filter.action.endsWith(".") ? { startsWith: filter.action } : filter.action;
  if (filter.outcome) where.outcome = filter.outcome;
  if (filter.from || filter.to) where.createdAt = { ...(filter.from && { gte: filter.from }), ...(filter.to && { lt: filter.to }) };
  return where;
}

/** Newest first; the id breaks ties between rows written in the same millisecond. */
const ORDER: Prisma.SecurityAuditEventOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

export default class SecurityAuditRepo {
  static async create(data: Prisma.SecurityAuditEventUncheckedCreateInput) {
    return prisma.securityAuditEvent.create({ data });
  }

  /** The actor's email (snapshotted onto the row) and the one organization they belong to. */
  static async findUserAuditInfo(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        organizationMemberships: { select: { organizationId: true, organization: { select: { tenant: { select: { code: true } } } } } },
      },
    });
  }

  static async findUserIdByEmail(email: string) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    return user?.id ?? null;
  }

  static async findOrganizationTenantCode(organizationId: string) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { tenant: { select: { code: true } } } });
    return org?.tenant.code ?? null;
  }

  /** One page, newest first. `cursor` is the last id of the previous page. */
  static async list(filter: SecurityAuditFilter, take: number, cursor?: string) {
    return prisma.securityAuditEvent.findMany({
      where: toWhere(filter),
      orderBy: ORDER,
      take,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /** Deletes up to `take` rows older than `cutoff`, oldest first; returns how many went. The
   * database refuses any row younger than the retention floor (see the migration's trigger). */
  static async deleteOlderThan(cutoff: Date, take: number): Promise<number> {
    const rows = await prisma.securityAuditEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
      take,
    });
    if (!rows.length) return 0;
    const { count } = await prisma.securityAuditEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return count;
  }
}
