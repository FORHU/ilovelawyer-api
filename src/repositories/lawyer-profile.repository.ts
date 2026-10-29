import { LawyerClientProfile, LawyerPhRegistration, LawyerUkRegistration, LawyerVerificationStatus, PracticeArea, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { LawyerCountry } from "../constants/lawyer-application.constants";
import { PRACTICE_AREAS_INCLUDE, toPracticeAreaRefs, type PracticeAreaRef } from "./practice-area.repository";

/** The PH registration fields, all null until the lawyer fills them in. */
export interface PhRegistrationFields {
  rollNumber: string | null;
  ibpChapter: string | null;
  ibpMembershipNumber: string | null;
  mcleNumber: string | null;
  mclePeriod: string | null;
}

/** The UK registration fields, flat on the profile as the client hand-off code reads them. */
export interface UkRegistrationFields {
  regulator: string | null;
  registrationNumber: string | null;
  qualifiedJurisdictions: string[];
}

const REGISTRATIONS = { ukRegistration: true, phRegistration: true, ...PRACTICE_AREAS_INCLUDE } satisfies Prisma.LawyerClientProfileInclude;

/** What the admin queue shows beside the application: who the lawyer is and their firm, details
 * included (a user is in at most one organization). */
const ADMIN_ROW_INCLUDE = {
  ...REGISTRATIONS,
  user: {
    select: {
      name: true,
      email: true,
      organizationMemberships: {
        select: {
          organization: {
            select: {
              name: true,
              isPersonal: true,
              phone: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              postcode: true,
              firmRegulator: true,
              firmRegistrationNumber: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.LawyerClientProfileInclude;

/** A profile row with its country's registration folded in: the UK fields flat (the client hand-off
 * code reads them that way) and the PH ones under `ph`, and its practice areas in picker order.
 * Storage keeps one table per country; this is the shape every caller works with. */
function flatten<
  T extends { ukRegistration: LawyerUkRegistration | null; phRegistration: LawyerPhRegistration | null; practiceAreas: { practiceArea: PracticeArea }[] },
>(row: T) {
  const { ukRegistration: uk, phRegistration: ph, practiceAreas, ...rest } = row;
  return {
    ...rest,
    practiceAreas: toPracticeAreaRefs(practiceAreas),
    regulator: uk?.regulator ?? null,
    registrationNumber: uk?.registrationNumber ?? null,
    qualifiedJurisdictions: uk?.qualifiedJurisdictions ?? [],
    ph: {
      rollNumber: ph?.rollNumber ?? null,
      ibpChapter: ph?.ibpChapter ?? null,
      ibpMembershipNumber: ph?.ibpMembershipNumber ?? null,
      mcleNumber: ph?.mcleNumber ?? null,
      mclePeriod: ph?.mclePeriod ?? null,
    } satisfies PhRegistrationFields,
  };
}

export type LawyerProfileRow = LawyerClientProfile & UkRegistrationFields & { ph: PhRegistrationFields; practiceAreas: PracticeAreaRef[] };
export type AdminLawyerProfileRow = ReturnType<typeof flatten<Prisma.LawyerClientProfileGetPayload<{ include: typeof ADMIN_ROW_INCLUDE }>>>;

/** Everything a lawyer's save writes: the shared profile fields and their country's registration. */
export type LawyerProfileData = Omit<LawyerProfileRow, "userId" | "createdAt" | "updatedAt">;

function registrationWrites(country: LawyerCountry, data: UkRegistrationFields & { ph: PhRegistrationFields }) {
  if (country === "PH") {
    return { phRegistration: { upsert: { create: { ...data.ph }, update: { ...data.ph } } } };
  }
  const uk = { regulator: data.regulator, registrationNumber: data.registrationNumber, qualifiedJurisdictions: data.qualifiedJurisdictions };
  return { ukRegistration: { upsert: { create: uk, update: uk } } };
}

export default class LawyerProfileRepo {
  static async find(userId: string): Promise<LawyerProfileRow | null> {
    const row = await prisma.lawyerClientProfile.findUnique({ where: { userId }, include: REGISTRATIONS });
    return row && flatten(row);
  }

  /** Saves the shared fields, the registration of the profile's own country, and the practice areas
   * (replacing the ones it had). */
  static async upsert(userId: string, data: LawyerProfileData): Promise<LawyerProfileRow> {
    // firstVerifiedAt is markFirstVerified's alone: a save that read the profile before an admin
    // verified it mustn't write it back empty.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { regulator, registrationNumber, qualifiedJurisdictions, ph, practiceAreas, firstVerifiedAt, ...base } = data;
    const country = base.country as LawyerCountry;
    const registration = { regulator, registrationNumber, qualifiedJurisdictions, ph };
    // Created bare, then the registration and areas written in the same transaction: a nested write
    // needs the parent row to exist, and an update-path write covers both a new and an existing profile.
    const row = await prisma.$transaction(async (tx) => {
      await tx.lawyerClientProfile.upsert({ where: { userId }, create: { userId, ...base }, update: base });
      return tx.lawyerClientProfile.update({
        where: { userId },
        data: {
          ...registrationWrites(country, registration),
          practiceAreas: { deleteMany: {}, create: practiceAreas.map((a) => ({ practiceAreaId: a.id })) },
        },
        include: REGISTRATIONS,
      });
    });
    return flatten(row);
  }

  /** An admin's decision — only the fields it touches. Approving a UK application also records the
   * jurisdictions the admin confirmed. Returns the admin queue's row. */
  /** Records the application's first verification, once (verify before plan, PlanGateSvc). */
  static async markFirstVerified(userId: string, at: Date) {
    await prisma.lawyerClientProfile.updateMany({ where: { userId, firstVerifiedAt: null }, data: { firstVerifiedAt: at } });
  }

  static async setVerification(
    userId: string,
    data: Pick<LawyerClientProfile, "verificationStatus" | "verificationNote" | "verifiedAt">,
    confirmedJurisdictions?: string[]
  ) {
    const row = await prisma.lawyerClientProfile.update({
      where: { userId },
      data: {
        ...data,
        ...(confirmedJurisdictions
          ? { ukRegistration: { upsert: { create: { qualifiedJurisdictions: confirmedJurisdictions }, update: { qualifiedJurisdictions: confirmedJurisdictions } } } }
          : {}),
      },
      include: ADMIN_ROW_INCLUDE,
    });
    return flatten(row);
  }

  /** The admin queue (#506) for one site and status, oldest submission first. */
  static async listForAdmin({ country, status, page, limit }: { country: LawyerCountry; status: LawyerVerificationStatus; page: number; limit: number }) {
    const where = { country, verificationStatus: status };
    const [rows, total] = await prisma.$transaction([
      prisma.lawyerClientProfile.findMany({
        where,
        include: ADMIN_ROW_INCLUDE,
        orderBy: [{ submittedAt: { sort: "asc", nulls: "last" } }, { userId: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lawyerClientProfile.count({ where }),
    ]);
    return { data: rows.map(flatten), total };
  }

  /** Candidates for matching (#509): verified UK lawyers, minus anyone already excluded from this
   * request. Accepting, not paused, enabled-by-org, capacity, practice area and jurisdiction are
   * checked in ClientRequestMatchingSvc.matches — the single source of truth for the rule, so it
   * stays unit-testable without a database. `openCount` comes from countOpenForLawyers below. */
  static async findVerified(excludeUserIds: string[]) {
    const rows = await prisma.lawyerClientProfile.findMany({
      where: { country: "UK", verificationStatus: "VERIFIED", userId: { notIn: excludeUserIds } },
      select: {
        userId: true,
        acceptingRequests: true,
        enabledByOrganization: true,
        pausedUntil: true,
        capacityLimit: true,
        practiceAreas: { select: { practiceArea: { select: { caseArea: true, isActive: true } } } },
        ukRegistration: { select: { qualifiedJurisdictions: true } },
      },
    });
    const openCounts = await LawyerProfileRepo.countOpenForLawyers(rows.map((r) => r.userId));
    return rows.map(({ ukRegistration, practiceAreas, ...r }) => ({
      ...r,
      practiceAreas: practiceAreas.map((a) => a.practiceArea),
      qualifiedJurisdictions: ukRegistration?.qualifiedJurisdictions ?? [],
      openCount: openCounts.get(r.userId) ?? 0,
    }));
  }

  /** How many open client requests (#514) each of these lawyers is holding: one they've joined and
   * not yet left (an open claim, on a ROUTED or CONFIRMED request; several lawyers in phase 5), or
   * one they're engaged on (ENGAGED; CLOSED doesn't count, even though the claim's outcome stays
   * ENGAGED). A claim that ended any other way isn't counted. Used by ClientRequestMatchingSvc.matches
   * for the capacity rule. */
  static async countOpenForLawyers(lawyerIds: string[]): Promise<Map<string, number>> {
    if (lawyerIds.length === 0) return new Map();
    const rows = await prisma.clientRequestClaim.groupBy({
      by: ["lawyerId"],
      where: {
        lawyerId: { in: lawyerIds },
        OR: [
          { outcome: null, request: { status: { in: ["ROUTED", "CONFIRMED"] } } },
          { outcome: "ENGAGED", request: { status: "ENGAGED" } },
        ],
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.lawyerId, r._count._all]));
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
