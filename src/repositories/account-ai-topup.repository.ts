import { AccountAiTopUpStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import AccountLimitsSvc from "../services/account-limits.service";

export interface NewAccountAiTopUp {
  userId: string;
  topUpAmountUsd: number;
  feeAmountUsd: number;
  totalChargedUsd: number;
  provider: string;
  externalId: string | null;
  status: AccountAiTopUpStatus;
}

export default class AccountAiTopUpRepo {
  static async create(data: NewAccountAiTopUp) {
    return prisma.accountAiTopUp.create({ data });
  }

  static async setExternalId(id: string, externalId: string) {
    await prisma.accountAiTopUp.update({ where: { id }, data: { externalId } });
  }

  static async findById(id: string) {
    return prisma.accountAiTopUp.findUnique({ where: { id } });
  }

  /** Only this account's own. */
  static async findForUser(id: string, userId: string) {
    return prisma.accountAiTopUp.findFirst({ where: { id, userId } });
  }

  /** An open (PENDING, with a checkout already created) top-up on this account, if any — reused
   * instead of starting a second one when the lawyer re-opens the modal. */
  static async findOpenForUser(userId: string) {
    return prisma.accountAiTopUp.findFirst({ where: { userId, status: "PENDING", externalId: { not: null } }, orderBy: { createdAt: "desc" } });
  }

  /**
   * Settles a PENDING top-up, once: the update only matches while it's still PENDING, so a webhook
   * and the app polling at the same moment can't both apply it. A paid top-up grants the account's
   * AI allowance (AccountLimitsSvc.grantExtraAllowance) in the same transaction. Returns whether
   * this call settled it.
   */
  static async settle(id: string, outcome: { paid: true } | { paid: false; reason: string }): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.accountAiTopUp.updateMany({
        where: { id, status: "PENDING" },
        data: outcome.paid ? { status: "SUCCEEDED", grantedAt: new Date() } : { status: "FAILED", failureReason: outcome.reason },
      });
      if (count !== 1) return false;
      if (outcome.paid) {
        const topUp = await tx.accountAiTopUp.findUniqueOrThrow({ where: { id }, select: { userId: true, topUpAmountUsd: true } });
        await AccountLimitsSvc.grantExtraAllowance(topUp.userId, topUp.topUpAmountUsd, tx);
      }
      return true;
    });
  }

  /** Marks an unpaid-and-abandoned PENDING top-up expired, e.g. from a checkout.session.expired
   * webhook. No allowance change. */
  static async expire(id: string, reason: string): Promise<boolean> {
    const { count } = await prisma.accountAiTopUp.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED", failureReason: reason } });
    return count === 1;
  }
}
