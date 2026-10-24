import { PaymentPlanSubscriptionStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import AccountLimitsSvc from "../services/account-limits.service";

/** A Stripe subscription's current billing period and flags, as stored on our row. */
export interface SubscriptionPeriod {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

/** Still paying (or being retried): the lawyer has a subscription and can't start a second one. */
const LIVE_STATUSES: PaymentPlanSubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];

/** One row per checkout attempt / Stripe subscription (PaymentPlanBillingSvc). Mirrors
 * AccountAiTopUpRepo: every state change is a conditional update, so a webhook and the app polling
 * at the same moment can't both apply it. */
export default class PaymentPlanSubscriptionRepo {
  static async create(data: { userId: string; paymentPlanId: string; stripePriceId: string }) {
    return prisma.paymentPlanSubscription.create({ data: { ...data, provider: "STRIPE", status: "PENDING" } });
  }

  static async setCheckoutSession(id: string, checkoutSessionId: string) {
    await prisma.paymentPlanSubscription.update({ where: { id }, data: { checkoutSessionId } });
  }

  static async findById(id: string) {
    return prisma.paymentPlanSubscription.findUnique({ where: { id } });
  }

  /** Only this lawyer's own. */
  static async findForUser(id: string, userId: string) {
    return prisma.paymentPlanSubscription.findFirst({ where: { id, userId }, include: { paymentPlan: { select: { code: true } } } });
  }

  static async findByStripeSubscriptionId(stripeSubscriptionId: string) {
    return prisma.paymentPlanSubscription.findUnique({ where: { stripeSubscriptionId } });
  }

  /** A checkout already opened and not yet paid or abandoned. */
  static async findOpenForUser(userId: string) {
    return prisma.paymentPlanSubscription.findFirst({ where: { userId, status: "PENDING", checkoutSessionId: { not: null } }, orderBy: { createdAt: "desc" } });
  }

  static async findLiveForUser(userId: string) {
    return prisma.paymentPlanSubscription.findFirst({ where: { userId, status: { in: LIVE_STATUSES } }, orderBy: { createdAt: "desc" } });
  }

  /** PENDING -> EXPIRED (abandoned, or replaced by a checkout for another tier). */
  static async expire(id: string, reason: string): Promise<boolean> {
    const { count } = await prisma.paymentPlanSubscription.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED", failureReason: reason } });
    return count === 1;
  }

  /** PENDING -> ACTIVE once the first month is paid: the lawyer moves onto the tier and a new
   * allowance period starts (AccountLimitsSvc.startAllowancePeriod), in one transaction. Once only. */
  static async activate(id: string, stripeSubscriptionId: string, period: SubscriptionPeriod, firstInvoiceId: string | null): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentPlanSubscription.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "ACTIVE", stripeSubscriptionId, ...period, lastPeriodInvoiceId: firstInvoiceId, failureReason: null },
      });
      if (count !== 1) return false;
      const row = await tx.paymentPlanSubscription.findUniqueOrThrow({ where: { id }, select: { userId: true, paymentPlanId: true } });
      await AccountLimitsSvc.startAllowancePeriod(row.userId, row.paymentPlanId, period.currentPeriodStart, tx);
      return true;
    });
  }

  /** A renewal was paid: the next allowance period starts. Fenced on the invoice, so a retried or
   * duplicated invoice.paid rolls the period at most once. */
  static async rollPeriod(id: string, invoiceId: string, period: SubscriptionPeriod): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentPlanSubscription.updateMany({
        where: { id, status: { in: LIVE_STATUSES }, OR: [{ lastPeriodInvoiceId: null }, { lastPeriodInvoiceId: { not: invoiceId } }] },
        data: { status: "ACTIVE", ...period, lastPeriodInvoiceId: invoiceId, failureReason: null },
      });
      if (count !== 1) return false;
      const row = await tx.paymentPlanSubscription.findUniqueOrThrow({ where: { id }, select: { userId: true, paymentPlanId: true } });
      await AccountLimitsSvc.startAllowancePeriod(row.userId, row.paymentPlanId, period.currentPeriodStart, tx);
      return true;
    });
  }

  /** ACTIVE -> PAST_DUE. True only on the transition, so the lawyer is told once, not per retry. */
  static async markPastDue(id: string, reason: string): Promise<boolean> {
    const { count } = await prisma.paymentPlanSubscription.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "PAST_DUE", failureReason: reason } });
    return count === 1;
  }

  /** Stripe's view of a live subscription (status, period, cancel-at-period-end, tier, and the Price
   * it bills when known). A tier change also moves the lawyer onto it, and lands a scheduled downgrade
   * once it's the tier the schedule was moving to. Never touches a PENDING row (activate does that)
   * or an ended one. */
  static async sync(id: string, data: { status: PaymentPlanSubscriptionStatus; paymentPlanId: string; stripePriceId?: string } & SubscriptionPeriod) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentPlanSubscription.updateMany({ where: { id, status: { in: LIVE_STATUSES } }, data });
      if (count !== 1) return;
      const row = await tx.paymentPlanSubscription.findUniqueOrThrow({ where: { id }, select: { userId: true, scheduledPaymentPlanId: true } });
      if (row.scheduledPaymentPlanId === data.paymentPlanId) {
        await tx.paymentPlanSubscription.update({ where: { id }, data: { scheduledPaymentPlanId: null, stripeScheduleId: null } });
      }
      if (LIVE_STATUSES.includes(data.status)) await tx.user.update({ where: { id: row.userId }, data: { paymentPlanId: data.paymentPlanId } });
    });
  }

  /** A downgrade the lawyer chose, to `scheduledPaymentPlanId` at the end of the period (or null and
   * null: they kept their tier, or upgraded instead). */
  static async setScheduledChange(id: string, scheduledPaymentPlanId: string | null, stripeScheduleId: string | null) {
    await prisma.paymentPlanSubscription.update({ where: { id }, data: { scheduledPaymentPlanId, stripeScheduleId } });
  }

  /** The subscription ended: the lawyer has no tier any more, which AccountLimitsSvc treats as a
   * read-only (locked) account. Once only. */
  static async cancel(id: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentPlanSubscription.updateMany({ where: { id, status: { in: LIVE_STATUSES } }, data: { status: "CANCELED" } });
      if (count !== 1) return false;
      const row = await tx.paymentPlanSubscription.findUniqueOrThrow({ where: { id }, select: { userId: true } });
      await tx.user.update({ where: { id: row.userId }, data: { paymentPlanId: null } });
      return true;
    });
  }
}
