import { LawyerClientProfile, LawyerVerificationStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** What the admin verification queue shows beside the profile: who the lawyer is and their firm
 * (a user is in at most one organization). */
const ADMIN_ROW_INCLUDE = {
  user: {
    select: {
      name: true,
      email: true,
      organizationMemberships: { select: { organization: { select: { name: true } } } },
    },
  },
} satisfies Prisma.LawyerClientProfileInclude;

export type AdminLawyerProfileRow = Prisma.LawyerClientProfileGetPayload<{ include: typeof ADMIN_ROW_INCLUDE }>;

export default class LawyerProfileRepo {
  static async find(userId: string) {
    return prisma.lawyerClientProfile.findUnique({ where: { userId } });
  }

  static async upsert(userId: string, data: Omit<Prisma.LawyerClientProfileUncheckedCreateInput, "userId">) {
    return prisma.lawyerClientProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  /** An admin's verify/reject decision — only the fields that decision touches. Verifying also
   * records the jurisdictions the admin confirmed. Returns the admin queue's row. */
  static async setVerification(
    userId: string,
    data: Pick<LawyerClientProfile, "verificationStatus" | "verificationNote" | "verifiedAt"> &
      Partial<Pick<LawyerClientProfile, "qualifiedJurisdictions">>
  ) {
    return prisma.lawyerClientProfile.update({ where: { userId }, data, include: ADMIN_ROW_INCLUDE });
  }

  /** The admin verification queue (#506) for one status, oldest submission first. */
  static async listForAdmin({ status, page, limit }: { status: LawyerVerificationStatus; page: number; limit: number }) {
    const where = { verificationStatus: status };
    const [data, total] = await prisma.$transaction([
      prisma.lawyerClientProfile.findMany({
        where,
        include: ADMIN_ROW_INCLUDE,
        orderBy: [{ submittedAt: { sort: "asc", nulls: "last" } }, { userId: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lawyerClientProfile.count({ where }),
    ]);
    return { data, total };
  }

  /** Candidates for matching (#509): verified lawyers, minus anyone already excluded from this
   * request. Accepting, not paused, enabled-by-org, capacity, practice area and jurisdiction are
   * checked in ClientRequestMatchingSvc.matches — the single source of truth for the rule, so it
   * stays unit-testable without a database. */
  static async findVerified(excludeUserIds: string[]) {
    return prisma.lawyerClientProfile.findMany({
      where: { verificationStatus: "VERIFIED", userId: { notIn: excludeUserIds } },
      select: { userId: true, acceptingRequests: true, enabledByOrganization: true, pausedUntil: true, practiceAreas: true, qualifiedJurisdictions: true },
    });
  }

  /** Where to email these lawyers (#510's client request emails). */
  static async findEmails(userIds: string[]) {
    if (userIds.length === 0) return [];
    return prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
  }

  /** The lawyer's role and the tenant they work on: their organization's, else their own. */
  static async findLawyerTenant(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        tenant: { select: { code: true } },
        organizationMemberships: { select: { organization: { select: { tenant: { select: { code: true } } } } } },
      },
    });
    if (!user) return null;
    return { role: user.role, tenantCode: user.organizationMemberships[0]?.organization.tenant.code ?? user.tenant?.code ?? null };
  }
}
