import prisma from "../lib/prisma";
import { CaseStatus } from "@prisma/client";

export interface PartyInput {
  name: string;
  designation: string;
  descriptor?: string | null;
}

export interface CaseData {
  caseName?: string;
  actionType?: string;
  jurisdiction?: string;
  ukJurisdiction?: string;
  notes?: string;
  parties?: PartyInput[];
}

export default class CaseRepo {
  /**
   * userId is stamped for "created by" audit purposes only — every read/update/delete
   * below scopes by organizationId, since a Case is a shared org resource once created.
   */
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    const { parties, ...caseFields } = data;

    return prisma.case.create({
      data: {
        organizationId,
        userId,
        ...caseFields,
        parties: parties ? { create: parties } : undefined,
      },
      include: { parties: true },
    });
  }

  static async list(organizationId: string, page: number, limit: number, search?: string, status: CaseStatus = "ACTIVE") {
    const skip = (page - 1) * limit;

    const where = {
      organizationId,
      status,
      ...(search
        ? {
            OR: [
              { caseName: { contains: search, mode: "insensitive" as const } },
              { parties: { some: { name: { contains: search, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.case.count({ where }),
      prisma.case.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: "desc" },
        include: { parties: true },
      }),
    ]);

    return { total, data: rows };
  }

  static async findById(id: string, organizationId: string) {
    return prisma.case.findFirst({ where: { id, organizationId }, include: { parties: true } });
  }

  /** Unscoped by organization — for background AI jobs that already hold a checked caseId. */
  static async findLanguage(id: string) {
    return prisma.case.findUnique({ where: { id }, select: { language: true } });
  }

  static async update(id: string, organizationId: string, data: CaseData) {
    const { parties, ...caseFields } = data;

    const existing = await prisma.case.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!existing) return false;

    await prisma.$transaction(async (tx) => {
      await tx.case.update({ where: { id }, data: caseFields });

      if (parties) {
        await tx.party.deleteMany({ where: { caseId: id } });
        if (parties.length > 0) {
          await tx.party.createMany({ data: parties.map((p) => ({ ...p, caseId: id })) });
        }
      }
    });

    return true;
  }

  static async delete(id: string, organizationId: string) {
    const result = await prisma.case.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }

  /** Archiving is a pure visibility flag (see CaseStatus on the schema) — this is the one place
   * that flips it. Find-then-update (not updateMany) since this is a genuine user-initiated
   * action with a real 404 to report, not a best-effort background write like markRefreshed
   * below, which deliberately tolerates a case having vanished mid-flight. */
  static async setStatus(id: string, organizationId: string, status: CaseStatus) {
    const existing = await prisma.case.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!existing) return null;
    return prisma.case.update({ where: { id }, data: { status }, include: { parties: true } });
  }

  /** Stamped at the end of a full CaseRefreshSvc.refresh run — not scoped by organizationId
   * since the caller already went through CaseAccess.assertCanEdit for this caseId.
   * updateMany (not update) so a case deleted mid-refresh (a real race — the automatic
   * post-extraction trigger runs up to 45s after the corpus change that scheduled it, and the
   * Chat Wonder calls upstream of this can themselves run for tens of seconds) is a silent
   * no-op rather than a P2025 throw; nothing meaningful to stamp on a row that's already gone. */
  static async markRefreshed(id: string) {
    return prisma.case.updateMany({ where: { id }, data: { lastRefreshedAt: new Date() } });
  }

  /** Whether the case still exists at all — no organizationId/access scoping, since callers here
   * (case-refresh.service.ts, case-post-extraction.ts) already resolved access earlier, or are
   * acting on a caseId derived from a document event rather than client input, and just need to
   * know if the row is still there before doing more work on it. */
  static async exists(id: string): Promise<boolean> {
    const row = await prisma.case.findUnique({ where: { id }, select: { id: true } });
    return !!row;
  }

  /** Used by the post-extraction auto-trigger (case-post-extraction.ts) to skip a redundant
   * caseRefresh run when the case's READY document set hasn't actually changed since the last
   * one. Not scoped by organizationId — same reasoning as markRefreshed above. */
  static async getReadySetFingerprint(id: string): Promise<string | null> {
    const row = await prisma.case.findUnique({ where: { id }, select: { readySetFingerprint: true } });
    return row?.readySetFingerprint ?? null;
  }

  /** updateMany, not update — same case-deleted-mid-flight tolerance as markRefreshed above. */
  static async setReadySetFingerprint(id: string, fingerprint: string) {
    return prisma.case.updateMany({ where: { id }, data: { readySetFingerprint: fingerprint } });
  }
}
