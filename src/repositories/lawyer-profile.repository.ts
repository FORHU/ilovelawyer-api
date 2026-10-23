import { LawyerClientProfile, LawyerPhRegistration, LawyerUkRegistration, LawyerVerificationStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { LawyerCountry } from "../constants/lawyer-application.constants";

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

const REGISTRATIONS = { ukRegistration: true, phRegistration: true } satisfies Prisma.LawyerClientProfileInclude;

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
 * code reads them that way) and the PH ones under `ph`. Storage keeps one table per country; this
 * is the shape every caller works with. */
function flatten<T extends { ukRegistration: LawyerUkRegistration | null; phRegistration: LawyerPhRegistration | null }>(row: T) {
  const { ukRegistration: uk, phRegistration: ph, ...rest } = row;
  return {
    ...rest,
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

export type LawyerProfileRow = LawyerClientProfile & UkRegistrationFields & { ph: PhRegistrationFields };
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

  /** Saves the shared fields and the registration of the profile's own country. */
  static async upsert(userId: string, data: LawyerProfileData): Promise<LawyerProfileRow> {
    const { regulator, registrationNumber, qualifiedJurisdictions, ph, ...base } = data;
    const country = base.country as LawyerCountry;
    const registration = { regulator, registrationNumber, qualifiedJurisdictions, ph };
    // Created bare, then the registration upserted in the same write: a nested `upsert` needs the
    // parent row to exist, and an update-path write covers both a new and an existing profile.
    const row = await prisma.$transaction(async (tx) => {
      await tx.lawyerClientProfile.upsert({ where: { userId }, create: { userId, ...base }, update: base });
      return tx.lawyerClientProfile.update({ where: { userId }, data: registrationWrites(country, registration), include: REGISTRATIONS });
    });
    return flatten(row);
  }

  /** An admin's decision — only the fields it touches. Approving a UK application also records the
   * jurisdictions the admin confirmed. Returns the admin queue's row. */
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
   * stays unit-testable without a database. */
  static async findVerified(excludeUserIds: string[]) {
    const rows = await prisma.lawyerClientProfile.findMany({
      where: { country: "UK", verificationStatus: "VERIFIED", userId: { notIn: excludeUserIds } },
      select: {
        userId: true,
        acceptingRequests: true,
        enabledByOrganization: true,
        pausedUntil: true,
        practiceAreas: true,
        ukRegistration: { select: { qualifiedJurisdictions: true } },
      },
    });
    return rows.map(({ ukRegistration, ...r }) => ({ ...r, qualifiedJurisdictions: ukRegistration?.qualifiedJurisdictions ?? [] }));
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
