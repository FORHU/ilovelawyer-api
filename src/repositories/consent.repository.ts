import { ConsentPurpose } from "@prisma/client";
import prisma from "../lib/prisma";

export default class ConsentRepo {
  static async findByUser(userId: string) {
    return prisma.consent.findMany({ where: { userId } });
  }

  /** Terms of Service lives on the user row, not in Consent — see ConsentSvc.list. */
  static async findTerms(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { termsAcceptedAt: true, termsVersion: true } });
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
