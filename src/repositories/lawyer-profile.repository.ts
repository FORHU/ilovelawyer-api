import { LawyerClientProfile, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export default class LawyerProfileRepo {
  static async find(userId: string) {
    return prisma.lawyerClientProfile.findUnique({ where: { userId } });
  }

  static async upsert(userId: string, data: Omit<Prisma.LawyerClientProfileUncheckedCreateInput, "userId">) {
    return prisma.lawyerClientProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  /** An admin's verify/reject decision — only the fields that decision touches. */
  static async setVerification(
    userId: string,
    data: Pick<LawyerClientProfile, "verificationStatus" | "verificationNote" | "verifiedAt">
  ) {
    return prisma.lawyerClientProfile.update({ where: { userId }, data });
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
