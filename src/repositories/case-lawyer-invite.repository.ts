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

  static async markAccepted(id: string, acceptedById: string, tx?: Prisma.TransactionClient): Promise<CaseLawyerInvite> {
    const db = tx ?? prisma;
    return db.caseLawyerInvite.update({
      where: { id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById },
    });
  }

  static async markExpired(id: string): Promise<void> {
    await prisma.caseLawyerInvite.update({ where: { id }, data: { status: "EXPIRED" } });
  }
}
