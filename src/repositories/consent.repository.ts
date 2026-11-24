import { ConsentPurpose } from "@prisma/client";
import prisma from "../lib/prisma";

export default class ConsentRepo {
  static async findByUser(userId: string) {
    return prisma.consent.findMany({ where: { userId } });
  }

  static async find(userId: string, purpose: ConsentPurpose) {
    return prisma.consent.findUnique({ where: { userId_purpose: { userId, purpose } } });
  }

  /** Terms of Service lives on the user row, not in Consent — see ConsentSvc.list. */
  static async findTerms(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { termsAcceptedAt: true, termsVersion: true, role: true } });
  }

  /** The account's role: a client account ("USER") is asked for SENSITIVE_INFO, a lawyer's is not. */
  static async findRole(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role ?? null;
  }

  /** Documents this person added that are waiting to be indexed: what was held back while they
   * could not run AI (DocumentExtractionSvc), queued again once they can. */
  static async findPendingDocumentIds(userId: string) {
    const rows = await prisma.document.findMany({ where: { userId, ragStatus: "PENDING" }, select: { id: true } });
    return rows.map((row) => row.id);
  }

  /** Granting stamps a fresh grantedAt and clears any withdrawal; withdrawing keeps grantedAt and
   * stamps withdrawnAt, so the row still says when the user first agreed. */
  static async set(userId: string, purpose: ConsentPurpose, granted: boolean, version: string, source: string, now = new Date()) {
    return prisma.consent.upsert({
      where: { userId_purpose: { userId, purpose } },
      create: { userId, purpose, version, source, grantedAt: now, withdrawnAt: granted ? null : now },
      update: granted ? { version, source, grantedAt: now, withdrawnAt: null } : { withdrawnAt: now, source },
    });
  }
}
