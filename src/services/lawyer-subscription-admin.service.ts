import type { PaymentPlanSubscriptionStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { planCurrencyOf, planPrice } from "../constants/payment-plan.constants";
import type { TenantCode } from "../types/tenant-code";

/** The admin's filters on lawyers' plan subscriptions. ALL: everything but checkouts that were never
 * paid (abandoned or replaced, EXPIRED). ACTIVE: paying, with nothing changing. CHANGING: cancelling
 * or downgrading at the end of the period. ENDED: cancelled. PENDING: a checkout still open. */
export const LAWYER_SUBSCRIPTION_FILTERS = ["ALL", "ACTIVE", "PAST_DUE", "CHANGING", "ENDED", "PENDING"] as const;
export type LawyerSubscriptionFilter = (typeof LAWYER_SUBSCRIPTION_FILTERS)[number];

const PAYING: PaymentPlanSubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];
const OPEN_CHECKOUT: Prisma.PaymentPlanSubscriptionWhereInput = { status: "PENDING", checkoutSessionId: { not: null } };
const CHANGING: Prisma.PaymentPlanSubscriptionWhereInput = {
  status: { in: PAYING },
  OR: [{ cancelAtPeriodEnd: true }, { scheduledPaymentPlanId: { not: null } }],
};

const WHERE: Record<LawyerSubscriptionFilter, Prisma.PaymentPlanSubscriptionWhereInput> = {
  ALL: { OR: [{ status: { in: ["ACTIVE", "PAST_DUE", "CANCELED"] } }, OPEN_CHECKOUT] },
  ACTIVE: { status: "ACTIVE", cancelAtPeriodEnd: false, scheduledPaymentPlanId: null },
  PAST_DUE: { status: "PAST_DUE" },
  CHANGING,
  ENDED: { status: "CANCELED" },
  PENDING: OPEN_CHECKOUT,
};

/**
 * Lawyers' monthly plan subscriptions (PaymentPlanSubscription), for the admin's Lawyer
 * subscriptions page: who's on which plan, who's behind on payment, and who's cancelling or
 * downgrading, one site at a time. Read only. Fees are the plan's current monthly fee in the site's
 * plan currency (won on KR); a subscriber who joined before a fee change may still be charged their
 * old price by Stripe.
 */
/** Subscriptions to one site's tiers. */
const onSite = (tenant: TenantCode): Prisma.PaymentPlanSubscriptionWhereInput => ({ paymentPlan: { tenant: { code: tenant } } });

export default class LawyerSubscriptionAdminSvc {
  /** A page of one site's subscriptions, newest first, with the summary over all of that site's
   * (whatever the filter). */
  static async list(query: { tenant: TenantCode; status: LawyerSubscriptionFilter; page: number; limit: number }) {
    const where: Prisma.PaymentPlanSubscriptionWhereInput = { AND: [WHERE[query.status], onSite(query.tenant)] };
    const [total, rows, summary] = await Promise.all([
      prisma.paymentPlanSubscription.count({ where }),
      prisma.paymentPlanSubscription.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          paymentPlan: { select: { id: true, code: true, name: true, priceMinor: true, currency: true, feeUsd: true, tenant: { select: { code: true } } } },
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      LawyerSubscriptionAdminSvc.summary(query.tenant),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const scheduledIds = [...new Set(rows.map((r) => r.scheduledPaymentPlanId).filter((id): id is string => !!id))];
    const [memberships, scheduled] = await Promise.all([
      userIds.length
        ? prisma.organizationMember.findMany({ where: { userId: { in: userIds } }, select: { userId: true, organization: { select: { name: true, isPersonal: true } } } })
        : [],
      scheduledIds.length ? prisma.paymentPlan.findMany({ where: { id: { in: scheduledIds } }, select: { id: true, name: true } }) : [],
    ]);
    const firmOf = new Map(memberships.map((m) => [m.userId, m.organization.isPersonal ? null : m.organization.name]));
    const planName = new Map(scheduled.map((p) => [p.id, p.name]));

    return {
      total,
      page: query.page,
      pageSize: query.limit,
      summary,
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        lawyer: { id: r.user.id, name: r.user.name || r.user.email || null, firmName: firmOf.get(r.userId) ?? null },
        plan: { id: r.paymentPlan.id, code: r.paymentPlan.code, name: r.paymentPlan.name, price: planPrice(r.paymentPlan), tenantCode: r.paymentPlan.tenant.code },
        currentPeriodStart: r.currentPeriodStart,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        /** The lower plan it moves to at currentPeriodEnd, when the lawyer asked to downgrade. */
        scheduledPlan: r.scheduledPaymentPlanId ? { id: r.scheduledPaymentPlanId, name: planName.get(r.scheduledPaymentPlanId) ?? null } : null,
        failureReason: r.failureReason,
        provider: r.provider,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Across one site's subscriptions: how many are active, what they bill each month at today's
   * plan fees (in the site's plan currency, smallest unit), how many are past due, and how many are
   * cancelling or downgrading. */
  static async summary(tenant: TenantCode) {
    const site = onSite(tenant);
    const [byPlan, pastDue, changing] = await Promise.all([
      prisma.paymentPlanSubscription.groupBy({ by: ["paymentPlanId"], where: { AND: [{ status: "ACTIVE" }, site] }, _count: { _all: true } }),
      prisma.paymentPlanSubscription.count({ where: { AND: [{ status: "PAST_DUE" }, site] } }),
      prisma.paymentPlanSubscription.count({ where: { AND: [CHANGING, site] } }),
    ]);
    const plans = byPlan.length
      ? await prisma.paymentPlan.findMany({ where: { id: { in: byPlan.map((g) => g.paymentPlanId) } }, select: { id: true, priceMinor: true, currency: true, feeUsd: true } })
      : [];
    const currency = planCurrencyOf(tenant);
    // A tier priced in another currency (one the payment_plan_currency migration didn't reach)
    // can't be added in; it's left out rather than counted at the wrong value.
    const feeOf = new Map(plans.map((p) => [p.id, planPrice(p)]));
    const active = byPlan.reduce((n, g) => n + g._count._all, 0);
    const amountMinor = byPlan.reduce((sum, g) => {
      const price = feeOf.get(g.paymentPlanId);
      return price?.currency === currency ? sum + price.amountMinor * g._count._all : sum;
    }, 0);
    return { active, monthly: { amountMinor, currency }, pastDue, changing };
  }
}
