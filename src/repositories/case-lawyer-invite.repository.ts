import type { CaseLawyerInvite, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** Invites a client sends to bring their own lawyer onto a case — see CaseLawyerInvite in schema.prisma.
 * `tx` is optional: pass a transaction client to compose several calls into one `prisma.$transaction(...)`. */
export default class CaseLawyerInviteRepo {
  static async create(data: Prisma.CaseLawyerInviteUncheckedCreateInput, tx?: Prisma.TransactionClient): Promise<CaseLawyerInvite> {
    const db = tx ?? prisma;
    return db.caseLawyerInvite.create({ data });
  }

  /** The case's outstanding invite, if any. Only PENDING rows count; revoked, accepted and expired ones don't. */
  static async findPendingForCase(caseId: string): Promise<CaseLawyerInvite | null> {
    return prisma.caseLawyerInvite.findFirst({ where: { caseId, status: "PENDING" } });
  }

  /** The case's most recent invite of any status — the row to show as "the invite on this case",
   * once it's no longer necessarily PENDING. `createInvite` always revokes any still-PENDING row
   * before creating a new one (in the same transaction), and every other status-changing call
   * (`markAccepted`, `markExpired`, the standalone `revoke`) only ever touches an existing row in
   * place — none of them ever creates a new row — so a case's rows are strictly ordered by
   * `createdAt`: the newest `createdAt` is unambiguously the current invite, whatever its status,
   * and a brand-new PENDING invite created after an old ACCEPTED/REVOKED/EXPIRED one always sorts
   * ahead of it. */
  static async findLatestForCase(caseId: string): Promise<CaseLawyerInvite | null> {
    return prisma.caseLawyerInvite.findFirst({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async findByToken(token: string): Promise<CaseLawyerInvite | null> {
    return prisma.caseLawyerInvite.findUnique({ where: { token } });
  }

  /** Revokes every PENDING invite on the case. Other statuses are left as they are. */
  static async revokePendingForCase(caseId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? prisma;
    await db.caseLawyerInvite.updateMany({
      where: { caseId, status: "PENDING" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
  }

  /** Marks the invite ACCEPTED only while it's still PENDING, matching markExpired's guard — a
   * racing accept, revoke or lazy expiry can't be overwritten. Returns the count of rows actually
   * updated (0 or 1), so a caller can tell a genuine accept apart from a race that lost. */
  static async markAccepted(id: string, acceptedById: string, tx?: Prisma.TransactionClient): Promise<{ count: number }> {
    const db = tx ?? prisma;
    return db.caseLawyerInvite.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById },
    });
  }

  /** Marks the invite EXPIRED only while it's still PENDING. A no-op otherwise, so a racing accept
   * (or revoke) isn't overwritten by a stale expiry. */
  static async markExpired(id: string): Promise<void> {
    await prisma.caseLawyerInvite.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED" } });
  }
}
