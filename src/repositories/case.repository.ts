import prisma from "../lib/prisma";
import { CaseStatus, ClientSide } from "@prisma/client";
import { getStableProxyFileUrl } from "../utils/s3";

/** The creator, for "Created by" — with whether they're still in the case's organization. */
function creatorSelect(organizationId: string) {
  return {
    select: {
      id: true,
      name: true,
      username: true,
      avatar: { select: { s3Key: true } },
      organizationMemberships: { where: { organizationId, status: "ACCEPTED" as const }, select: { id: true } },
    },
  };
}

type CreatorRow = {
  id: string;
  name: string | null;
  username: string;
  avatar: { s3Key: string | null } | null;
  organizationMemberships: { id: string }[];
};

/** Swaps the raw `user` relation for `createdBy`: null once the account is deleted, in which case
 * the row's createdByName still names them. */
function withCreator<T extends { user: CreatorRow | null }>({ user, ...row }: T) {
  return {
    ...row,
    createdBy: user
      ? {
          id: user.id,
          name: user.name || user.username,
          avatarUrl: user.avatar?.s3Key ? getStableProxyFileUrl(user.avatar.s3Key) : null,
          isMember: user.organizationMemberships.length > 0,
        }
      : null,
  };
}

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
  clientSide?: ClientSide | null;
  notes?: string;
  parties?: PartyInput[];
}

export default class CaseRepo {
  /**
   * userId is stamped for "created by" attribution only — every read/update/delete
   * below scopes by organizationId, since a Case is a shared org resource once created.
   * createdByName keeps the creator's name for after their account is gone.
   */
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    const { parties, ...caseFields } = data;
    const creator = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, username: true } });

    return prisma.case.create({
      data: {
        organizationId,
        userId,
        createdByName: creator?.name || creator?.username,
        ...caseFields,
        parties: parties ? { create: parties } : undefined,
      },
      include: { parties: true },
    });
  }

  /** `userId` scopes the joined "Last opened" (CaseView) to the requesting user — each row comes
   * back with a flat `lastOpenedAt` (null if this user has never opened that case) instead of the
   * raw `views` relation. */
  /** `createdBy` narrows to one creator's cases (the "Created by me" / per-member filter). */
  static async list(
    organizationId: string,
    userId: string,
    page: number,
    limit: number,
    search?: string,
    status: CaseStatus = "ACTIVE",
    createdBy?: string,
  ) {
    const skip = (page - 1) * limit;

    const where = {
      organizationId,
      status,
      ...(createdBy ? { userId: createdBy } : {}),
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
        include: {
          parties: true,
          views: { where: { userId }, select: { lastOpenedAt: true } },
          user: creatorSelect(organizationId),
        },
      }),
    ]);

    const data = rows.map(({ views, ...row }) => ({ ...withCreator(row), lastOpenedAt: views[0]?.lastOpenedAt ?? null }));
    return { total, data };
  }

  /** Records that `userId` just opened the case. Upsert on the (case, user) key. The caller has
   * already checked the case belongs to the organization. */
  static async markOpened(caseId: string, userId: string) {
    const now = new Date();
    return prisma.caseView.upsert({
      where: { caseId_userId: { caseId, userId } },
      create: { caseId, userId, lastOpenedAt: now },
      update: { lastOpenedAt: now },
    });
  }

  /** Stamps "something happened on this case" onto Case.updatedAt, which Case Portfolio shows as
   * "Last updated" and sorts by. Prisma's @updatedAt only fires when the Case row itself is
   * written, and most in-case work (documents, chat, decisions, events) writes to other tables —
   * so those write paths call this.
   * updateMany, not update, so a case deleted mid-flight is a silent no-op (same as markRefreshed).
   * The `lt` guard throttles it to at most one Case write per minute, so chatty paths (every chat
   * turn) don't hammer the row. Best-effort: callers must not let a failure here fail the user's
   * action — see CaseRepo.touchSafe. */
  static async touch(id: string) {
    const now = new Date();
    return prisma.case.updateMany({
      where: { id, updatedAt: { lt: new Date(now.getTime() - 60_000) } },
      data: { updatedAt: now },
    });
  }

  /** Fire-and-forget wrapper around touch for write paths — never throws or delays the caller. */
  static touchSafe(id: string | null | undefined) {
    if (!id) return;
    CaseRepo.touch(id).catch(() => {
      // Cosmetic timestamp — losing one bump must never fail the real write it rides along with.
    });
  }

  /**
   * For portfolio copies (rows with copiedFromCaseId): `copyVersion` numbers repeat copies of the
   * same original in order (leave, rejoin, leave again makes a second one) — null for the only
   * one. `original` is set while the user is back in the original's organization, so the copy
   * can link to it and say whether it has changed since the copy was made; null when they can't
   * open it there (not a member, or it was deleted). Other rows get null for both.
   */
  static async withCopyContext<
    T extends { id: string; organizationId: string | null; copiedFromCaseId: string | null; copiedAt: Date | null },
  >(rows: T[], userId: string) {
    const copies = rows.filter((r) => r.copiedFromCaseId && r.organizationId);
    if (copies.length === 0) return rows.map((r) => ({ ...r, copyVersion: null, original: null }));

    const sourceIds = [...new Set(copies.map((c) => c.copiedFromCaseId!))];
    const portfolioIds = [...new Set(copies.map((c) => c.organizationId!))];
    const [siblings, originals] = await Promise.all([
      prisma.case.findMany({
        where: { copiedFromCaseId: { in: sourceIds }, organizationId: { in: portfolioIds } },
        select: { id: true, copiedFromCaseId: true, organizationId: true },
        orderBy: [{ copiedAt: "asc" }, { createdAt: "asc" }],
      }),
      prisma.case.findMany({
        where: { id: { in: sourceIds }, organization: { members: { some: { userId, status: "ACCEPTED" } } } },
        select: { id: true, updatedAt: true, organization: { select: { name: true } } },
      }),
    ]);

    const groups = new Map<string, string[]>();
    for (const s of siblings) {
      const key = `${s.organizationId}:${s.copiedFromCaseId}`;
      groups.set(key, [...(groups.get(key) ?? []), s.id]);
    }
    const originalById = new Map(originals.map((o) => [o.id, o]));

    return rows.map((r) => {
      if (!r.copiedFromCaseId || !r.organizationId) return { ...r, copyVersion: null, original: null };
      const group = groups.get(`${r.organizationId}:${r.copiedFromCaseId}`) ?? [];
      const number = group.indexOf(r.id) + 1;
      const original = originalById.get(r.copiedFromCaseId);
      return {
        ...r,
        copyVersion: group.length > 1 && number > 0 ? { number, total: group.length } : null,
        original: original
          ? {
              id: original.id,
              organizationName: original.organization?.name ?? null,
              changedSinceCopy: !!r.copiedAt && original.updatedAt > r.copiedAt,
            }
          : null,
      };
    });
  }

  static async findById(id: string, organizationId: string) {
    const record = await prisma.case.findFirst({
      where: { id, organizationId },
      include: { parties: true, user: creatorSelect(organizationId) },
    });
    return record ? withCreator(record) : null;
  }

  /** Unscoped by organization — for background AI jobs that already hold a checked caseId. */
  static async findLanguage(id: string) {
    return prisma.case.findUnique({ where: { id }, select: { language: true } });
  }

  /** Unscoped, same as findLanguage — the case header a background AI prompt opens with. */
  static async findPromptHeader(id: string) {
    return prisma.case.findUnique({
      where: { id },
      select: { caseName: true, actionType: true, jurisdiction: true, ukJurisdiction: true },
    });
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
  /** Null until the case's first analysis refresh finishes (markRefreshed). */
  static async getLastRefreshedAt(id: string): Promise<Date | null> {
    const row = await prisma.case.findUnique({ where: { id }, select: { lastRefreshedAt: true } });
    return row?.lastRefreshedAt ?? null;
  }

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
  static async markAdverseSwept(id: string) {
    return prisma.case.updateMany({ where: { id }, data: { adverseSweptAt: new Date() } });
  }

  /** updateMany, not update — same case-deleted-mid-flight tolerance as markRefreshed above. */
  static async setFindingsFormatVersion(id: string, version: number) {
    return prisma.case.updateMany({ where: { id }, data: { findingsFormatVersion: version } });
  }

  /** Marks the case's findings outdated, so the next Terminal load regenerates them. */
  static async clearFindingsFormatVersion(id: string) {
    return prisma.case.updateMany({ where: { id }, data: { findingsFormatVersion: null } });
  }

  /** updateMany, not update — same case-deleted-mid-flight tolerance as markRefreshed above. */
  static async setReadySetFingerprint(id: string, fingerprint: string) {
    return prisma.case.updateMany({ where: { id }, data: { readySetFingerprint: fingerprint } });
  }
}
