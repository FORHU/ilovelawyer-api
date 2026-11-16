import { PaymentPlan, PaymentPlanType, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { TenantCode, asTenantCode } from "../types/tenant-code";
import { PLAN_CURRENCIES, type PlanCurrency, currencyOfTiers, isPlanCurrency, legacyFeeUsd, planPrice } from "../constants/payment-plan.constants";
import { TENANT_SETTING_KEYS } from "../constants/tenant-settings.constants";
import { expirePaymentPlanCheckout } from "../payments/payment-plan-subscription-provider";
import PaymentPlanSubscriptionRepo from "../repositories/payment-plan-subscription.repository";

/** Why an open plan checkout was closed when its site's currency changed. */
const CURRENCY_CHANGED_REASON = "This plan's price changed currency. Nothing was charged; choose your plan again.";

const TIER_CURRENCY_SELECT = { tenantId: true, priceMinor: true, currency: true, feeUsd: true, level: true } as const;

export interface PaymentPlanInput {
  code: string;
  name: string;
  /** Shown to the lawyer on the plan picker. */
  description?: string;
  /** Admin-only — never returned to a lawyer. */
  adminNotes?: string;
  level?: number;
  /** The monthly fee in the site's currency's smallest unit (cents; whole won on KR). The currency
   * is the site's (PaymentPlanSvc.siteCurrency); it changes only through changeCurrency. */
  priceMinor: number;
  /** In US dollars on every site: it measures AI cost. */
  includedAllowanceUsd: number;
  caseLimit: number;
  /** Client requests a lawyer can take on per calendar month; 0 = unlimited. */
  clientRequestLimit?: number;
}

/** `code` is set once at create: it's the stable slug signup and upgrades refer to. */
export type PaymentPlanPatch = Partial<Omit<PaymentPlanInput, "code">>;

function validateNumbers(input: { priceMinor?: number; includedAllowanceUsd?: number; caseLimit?: number; clientRequestLimit?: number }, currency: PlanCurrency) {
  if (input.priceMinor !== undefined) {
    const { exponent, maxMinor } = PLAN_CURRENCIES[currency];
    if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) {
      throw new HttpError(exponent === 0 ? `Fee must be a whole number of ${currency}` : "Fee can't be negative", 400, "PRICE_OUT_OF_RANGE");
    }
    if (input.priceMinor > maxMinor) throw new HttpError(`Fee can be at most ${maxMinor / 10 ** exponent} ${currency}`, 400, "PRICE_OUT_OF_RANGE");
  }
  if (input.includedAllowanceUsd !== undefined && input.includedAllowanceUsd < 0) throw new HttpError("Included AI allowance can't be negative", 400);
  if (input.caseLimit !== undefined && (!Number.isInteger(input.caseLimit) || input.caseLimit < 0)) {
    throw new HttpError("Case limit must be a non-negative whole number", 400);
  }
  if (input.clientRequestLimit !== undefined && (!Number.isInteger(input.clientRequestLimit) || input.clientRequestLimit < 0)) {
    throw new HttpError("Client request limit must be a non-negative whole number", 400);
  }
}

/**
 * Admin-editable B2B subscription tiers (Standard/Pro/Max are placeholders), one row per
 * (tenant, planType, code). Real columns on a dedicated table rather than a TenantSetting Json
 * blob, so a User can hold a real FK (User.paymentPlanId) and admin CRUD doesn't need to
 * hand-roll ids/ordering inside an array.
 *
 * Tiers are never hard-deleted (setActive only): a lawyer's User.paymentPlanId and every
 * PaymentPlanSubscription row must stay valid even after a tier is retired from new signups.
 */
export default class PaymentPlanSvc {
  /** The currency a site's lawyers are charged in, plans and AI top-ups alike: the one its tiers are
   * priced in, or its local default (pesos on PH, won on KR) when it has none yet. */
  static async siteCurrency(tenantId: string, tenantCode: TenantCode): Promise<PlanCurrency> {
    const tiers = await prisma.paymentPlan.findMany({ where: { tenantId, planType: "B2B_SUBSCRIPTION" }, select: TIER_CURRENCY_SELECT });
    return currencyOfTiers(tiers, tenantCode);
  }

  /** Every site's currency at once, by tenant id, for the admin's lists. */
  static async siteCurrencies(tenants: { id: string; code: string }[]): Promise<Map<string, PlanCurrency>> {
    const tiers = await prisma.paymentPlan.findMany({ where: { planType: "B2B_SUBSCRIPTION", tenantId: { in: tenants.map((t) => t.id) } }, select: TIER_CURRENCY_SELECT });
    return new Map(tenants.map((t) => [t.id, currencyOfTiers(tiers.filter((p) => p.tenantId === t.id), asTenantCode(t.code))]));
  }

  static async listForTenant(tenantId: string, planType: PaymentPlanType = "B2B_SUBSCRIPTION"): Promise<PaymentPlan[]> {
    return prisma.paymentPlan.findMany({ where: { tenantId, planType }, orderBy: { level: "asc" } });
  }

  /** The tier a new lawyer starts on: the tenant's lowest-level active B2B tier, or null when the
   * tenant has none. Until checkout-at-signup exists this is never charged — without it a new
   * lawyer would have no tier, and no tier means a locked account (AccountLimitsSvc). */
  static async defaultIdForTenant(tenantId: string): Promise<string | null> {
    const plan = await prisma.paymentPlan.findFirst({
      where: { tenantId, planType: "B2B_SUBSCRIPTION", isActive: true },
      orderBy: { level: "asc" },
      select: { id: true },
    });
    return plan?.id ?? null;
  }

  /** The same tier (by code) in another tenant, falling back to that tenant's default — for a
   * lawyer moved between tenants, whose old tier belongs to the tenant they left. */
  static async equivalentIdInTenant(paymentPlanId: string | null, tenantId: string): Promise<string | null> {
    const current = paymentPlanId ? await prisma.paymentPlan.findUnique({ where: { id: paymentPlanId }, select: { tenantId: true, planType: true, code: true } }) : null;
    if (current?.tenantId === tenantId) return paymentPlanId;
    if (current) {
      const match = await prisma.paymentPlan.findUnique({
        where: { tenantId_planType_code: { tenantId, planType: current.planType, code: current.code } },
        select: { id: true, isActive: true },
      });
      if (match?.isActive) return match.id;
    }
    return PaymentPlanSvc.defaultIdForTenant(tenantId);
  }

  /** The admin Settings page: every Tenant's tiers, in level order. */
  static async listForAdmin(planType: PaymentPlanType = "B2B_SUBSCRIPTION") {
    const [tenants, plans] = await Promise.all([
      TenantRepo.listAll(),
      prisma.paymentPlan.findMany({
        where: { planType },
        orderBy: [{ tenantId: "asc" }, { level: "asc" }],
        include: { updatedBy: { select: { name: true, email: true } } },
      }),
    ]);
    return tenants.map((tenant) => {
      const code = asTenantCode(tenant.code);
      const tiers = plans.filter((p) => p.tenantId === tenant.id);
      return {
        code,
        name: tenant.name,
        // The site's currency: what its tiers are priced in, and what a new tier is priced in.
        planCurrency: currencyOfTiers(tiers, code),
        paymentPlans: tiers.map((p) => {
            const price = planPrice(p);
            return { ...p, priceMinor: price.amountMinor, currency: price.currency };
          }),
      };
    });
  }

  static async create(code: TenantCode, input: PaymentPlanInput, adminId: string): Promise<PaymentPlan> {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    if (!input.code.trim() || !input.name.trim()) throw new HttpError("Code and name are required", 400);
    const currency = await PaymentPlanSvc.siteCurrency(tenant.id, code);
    validateNumbers(input, currency);

    // No level given (the admin "Add tier" form doesn't ask): rank it above every existing tier,
    // so it never ties with one — upgrades compare levels.
    const level =
      input.level ??
      ((await prisma.paymentPlan.aggregate({ where: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION" }, _max: { level: true } }))._max.level ?? -1) + 1;

    let plan: PaymentPlan;
    try {
      plan = await prisma.paymentPlan.create({
        data: {
          tenantId: tenant.id,
          planType: "B2B_SUBSCRIPTION",
          code: input.code.trim(),
          name: input.name.trim(),
          description: input.description?.trim() || null,
          adminNotes: input.adminNotes?.trim() || null,
          level,
          priceMinor: input.priceMinor,
          currency,
          feeUsd: legacyFeeUsd(input.priceMinor, currency),
          includedAllowanceUsd: input.includedAllowanceUsd,
          caseLimit: input.caseLimit,
          clientRequestLimit: input.clientRequestLimit ?? 0,
          updatedById: adminId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(`A tier with code "${input.code}" already exists for ${code}`, 409);
      }
      throw err;
    }

    await SecurityAuditSvc.record({
      action: "admin.settings.payment_plan_created",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { planId: plan.id, ...input, currency, level },
    });
    return plan;
  }

  static async update(planId: string, patch: PaymentPlanPatch, adminId: string): Promise<PaymentPlan> {
    const before = await prisma.paymentPlan.findUnique({ where: { id: planId }, include: { tenant: { select: { code: true } } } });
    // The client app's B2C rows share this table; they're edited through ClientPricingSvc.
    if (!before || before.planType !== "B2B_SUBSCRIPTION") throw new HttpError("Unknown subscription tier", 404);
    const currency = await PaymentPlanSvc.siteCurrency(before.tenantId, asTenantCode(before.tenant.code));
    validateNumbers(patch, currency);

    const plan = await prisma.paymentPlan.update({
      where: { id: planId },
      data: {
        name: patch.name?.trim(),
        description: patch.description !== undefined ? patch.description.trim() || null : undefined,
        adminNotes: patch.adminNotes !== undefined ? patch.adminNotes.trim() || null : undefined,
        level: patch.level,
        // A price edit also sets the currency, so a tier the payment_plan_currency migration missed
        // is put right the first time it's edited.
        ...(patch.priceMinor !== undefined ? { priceMinor: patch.priceMinor, currency, feeUsd: legacyFeeUsd(patch.priceMinor, currency) } : {}),
        includedAllowanceUsd: patch.includedAllowanceUsd,
        caseLimit: patch.caseLimit,
        clientRequestLimit: patch.clientRequestLimit,
        updatedById: adminId,
      },
    });

    await SecurityAuditSvc.record({
      action: "admin.settings.payment_plan_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: before.tenant.code,
      payload: { planId, from: before, to: patch.priceMinor !== undefined ? { ...patch, currency } : patch },
    });
    return plan;
  }

  /**
   * Moves a site's lawyers to another currency: every tier (hidden ones too, so a site never mixes
   * currencies) is repriced at once, at the prices the admin gives. Each tier then gets a Stripe Price
   * in the new currency at its next checkout (PaymentPlanStripeSyncSvc mints one when the currency
   * differs).
   *
   * Refused while any lawyer on the site has a live subscription: Stripe can't move a subscription to
   * another currency, so their plan changes would fail. Open checkouts are closed (they'd charge the
   * old currency), and the site's account top-up fee (a fixed one is an amount in the old currency)
   * and exchange rate go back to the new currency's defaults, for the admin to set again.
   */
  static async changeCurrency(code: TenantCode, currency: string, prices: { planId: string; priceMinor: number }[], adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    if (!isPlanCurrency(currency)) throw new HttpError(`${currency} isn't a currency lawyers can be charged in`, 400, "CURRENCY_NOT_SUPPORTED");

    const tiers = await prisma.paymentPlan.findMany({ where: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION" } });
    const from = currencyOfTiers(tiers, code);
    if (currency === from) throw new HttpError(`${code} is already charged in ${currency}`, 400, "CURRENCY_UNCHANGED");

    const priceOf = new Map(prices.map((p) => [p.planId, p.priceMinor]));
    if (priceOf.size !== prices.length || tiers.length !== prices.length || tiers.some((t) => !priceOf.has(t.id))) {
      throw new HttpError(`Give a ${currency} price for every one of ${code}'s tiers, hidden ones included`, 400, "PRICES_INCOMPLETE");
    }
    for (const p of prices) validateNumbers({ priceMinor: p.priceMinor }, currency);

    const live = await prisma.paymentPlanSubscription.count({ where: { status: { in: ["ACTIVE", "PAST_DUE"] }, paymentPlan: { tenantId: tenant.id } } });
    if (live > 0) {
      throw new HttpError(
        `${live} ${live === 1 ? "lawyer" : "lawyers"} on ${code} ${live === 1 ? "has" : "have"} a live subscription in ${from}. Stripe can't move a subscription to another currency, so ${code} can change currency once none is live.`,
        409,
        "CURRENCY_LOCKED",
      );
    }

    const feeRow = await prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: tenant.id, key: TENANT_SETTING_KEYS.accountTopUpFee } } });
    const fixedFee = (feeRow?.value as { feeType?: unknown } | null)?.feeType === "FIXED";
    await prisma.$transaction([
      ...tiers.map((t) => {
        const priceMinor = priceOf.get(t.id)!;
        return prisma.paymentPlan.update({ where: { id: t.id }, data: {
            priceMinor,
            currency,
            feeUsd: legacyFeeUsd(priceMinor, currency),
            // The tier's Stripe Price is in the old currency: cleared, so the next checkout mints one in
            // the new currency even if the amount happens to be the same number.
            stripePriceAmountMinor: null,
            updatedById: adminId,
          },
        });
      }),
      prisma.tenantSetting.deleteMany({
        where: { tenantId: tenant.id, key: { in: [TENANT_SETTING_KEYS.accountTopUpRate, ...(fixedFee ? [TENANT_SETTING_KEYS.accountTopUpFee] : [])] } },
      }),
    ]);

    // After the reprice, so a checkout opened meanwhile can't be missed: it's closed here too.
    const open = await prisma.paymentPlanSubscription.findMany({
      where: { status: "PENDING", checkoutSessionId: { not: null }, paymentPlan: { tenantId: tenant.id } },
      select: { id: true, checkoutSessionId: true },
    });
    for (const row of open) {
      await expirePaymentPlanCheckout(row.checkoutSessionId!).catch((err) =>
        logger.warn("Stripe checkout could not be expired after a currency change", { subscriptionId: row.id, err: err instanceof Error ? err.message : String(err) }),
      );
      await PaymentPlanSubscriptionRepo.expire(row.id, CURRENCY_CHANGED_REASON);
    }

    await SecurityAuditSvc.record({
      action: "admin.settings.payment_plan_currency_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: {
        from,
        to: currency,
        prices: tiers.map((t) => ({ planId: t.id, code: t.code, from: planPrice(t), to: { amountMinor: priceOf.get(t.id)!, currency } })),
        topUpFeeReset: fixedFee,
        checkoutsClosed: open.length,
      },
    });
    return { currency, checkoutsClosed: open.length, topUpFeeReset: fixedFee };
  }

  /** Soft-disable/re-enable only — hides a tier from new signups/upgrades without ever deleting
   * the row, so existing lawyers on it (User.paymentPlanId) and their PaymentPlanSubscription rows
   * stay valid. */
  static async setActive(planId: string, isActive: boolean, adminId: string): Promise<PaymentPlan> {
    const before = await prisma.paymentPlan.findUnique({ where: { id: planId }, include: { tenant: { select: { code: true } } } });
    // The client app's B2C rows share this table; they're edited through ClientPricingSvc.
    if (!before || before.planType !== "B2B_SUBSCRIPTION") throw new HttpError("Unknown subscription tier", 404);

    const plan = await prisma.paymentPlan.update({ where: { id: planId }, data: { isActive, updatedById: adminId } });
    await SecurityAuditSvc.record({
      action: isActive ? "admin.settings.payment_plan_changed" : "admin.settings.payment_plan_deactivated",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: before.tenant.code,
      payload: { planId, isActive },
    });
    return plan;
  }
}
