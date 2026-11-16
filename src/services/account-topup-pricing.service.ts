import TenantSettingRepo from "../repositories/tenant-setting.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { TenantCode, asTenantCode } from "../types/tenant-code";
import { TENANT_SETTING_KEYS, ACCOUNT_TOPUP_FEE_DEFAULT } from "../constants/tenant-settings.constants";
import { PLAN_CURRENCIES, type PlanCurrency, toMajor } from "../constants/payment-plan.constants";
import PaymentPlanSvc from "./payment-plan.service";
import { ACCOUNT_TOPUP_TERMS, AI_CREDIT_RATE_DEFAULT, AI_CREDIT_RATE_LIMITS } from "../constants/account-topup.constants";

export type AccountTopUpFeeType = "FIXED" | "PERCENT";

export interface AccountTopUpFee {
  feeType: AccountTopUpFeeType;
  /** FIXED: an amount in the site's currency (dollars; won on KR). PERCENT: 0-100. */
  feeAmount: number;
}

/** What a lawyer on one site can top up: in their site's currency, major units. */
export interface AccountTopUpTerms {
  currency: PlanCurrency;
  minAmount: number;
  maxAmount: number;
  /** The amounts the lawyer app offers as buttons. */
  presets: number[];
}

/** A top-up's figures, in the smallest unit of `currency`, plus the AI usage it buys in dollars. */
export interface AccountTopUpQuoteMinor {
  currency: PlanCurrency;
  amountMinor: number;
  feeMinor: number;
  totalMinor: number;
  /** The AI usage added to the account, in US dollars (extraAiAllowanceUsd). */
  creditUsd: number;
  /** The same fee and total in US dollars, for the AccountAiTopUp row's dollar columns. */
  feeUsd: number;
  totalUsd: number;
}

/** What the lawyer app shows: the same figures in major units of `currency` (₩30,000 is 30000). */
export interface AccountTopUpQuote {
  currency: PlanCurrency;
  topUpAmount: number;
  feeAmount: number;
  totalCharged: number;
  creditUsd: number;
}

/** A saved fee or rate records the currency it was set in. One set in another currency (the site has
 * since changed currency) doesn't apply: the default does. A row from before currencies were
 * recorded applies to the currency the site has now. */
function sameCurrency(value: Record<string, unknown>, currency: PlanCurrency): boolean {
  return value.currency === undefined || value.currency === currency;
}

function isAccountTopUpFee(value: unknown, currency: PlanCurrency): value is AccountTopUpFee {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // A percentage reads the same in any currency.
  return (
    (v.feeType === "FIXED" || v.feeType === "PERCENT") &&
    typeof v.feeAmount === "number" &&
    Number.isFinite(v.feeAmount) &&
    v.feeAmount >= 0 &&
    (v.feeType === "PERCENT" || sameCurrency(v, currency))
  );
}

function isRate(value: unknown, currency: PlanCurrency): value is { perUsd: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.perUsd === "number" && Number.isFinite(v.perUsd) && v.perUsd > 0 && sameCurrency(v, currency);
}

function feeFromRow(value: unknown, currency: PlanCurrency): AccountTopUpFee {
  if (!isAccountTopUpFee(value, currency)) return defaultFee(currency);
  return { feeType: value.feeType, feeAmount: value.feeAmount };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function defaultFee(currency: PlanCurrency): AccountTopUpFee {
  return currency === "USD" ? ACCOUNT_TOPUP_FEE_DEFAULT : ACCOUNT_TOPUP_TERMS[currency].defaultFee;
}

function termsOf(currency: PlanCurrency): AccountTopUpTerms {
  const t = ACCOUNT_TOPUP_TERMS[currency];
  return { currency, minAmount: toMajor(t.minMinor, currency), maxAmount: toMajor(t.maxMinor, currency), presets: t.presetsMinor.map((p) => toMajor(p, currency)) };
}

/** "₩5,000" / "$5", for an error message. */
function formatAmount(amountMinor: number, currency: PlanCurrency): string {
  return toMajor(amountMinor, currency).toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 0 });
}

/**
 * The per-tenant terms of a lawyer's self-serve account AI top-up (AccountTopUpBillingSvc): the
 * currency (the site's lawyer currency, won on KR), the platform fee (TENANT_SETTING_KEYS
 * .accountTopUpFee), and, on a site that doesn't charge in dollars, how much of its currency buys $1
 * of AI usage (TENANT_SETTING_KEYS.accountTopUpRate). Both settings are TenantSetting rows; a tenant
 * with no row yet (no admin has saved one) falls back to a sane default rather than refusing to quote.
 *
 * The account's base AI allowance and per-account case limit don't live here — they come from the
 * lawyer's PaymentPlan tier (PaymentPlanSvc, AccountLimitsSvc).
 */
export default class AccountTopUpPricingSvc {
  static async fee(tenantId: string, currency: PlanCurrency): Promise<AccountTopUpFee> {
    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.accountTopUpFee);
    return feeFromRow(row?.value, currency);
  }

  /** How much of the site's currency buys $1 of AI usage: always 1 on a US-dollar site. */
  static async perUsd(tenantId: string, currency: PlanCurrency): Promise<number> {
    if (currency === "USD") return 1;
    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.accountTopUpRate);
    return isRate(row?.value, currency) ? (row!.value as { perUsd: number }).perUsd : AI_CREDIT_RATE_DEFAULT[currency];
  }

  /** The site's currency (the one its plans are in), from its id. */
  static async currencyOf(tenantId: string): Promise<PlanCurrency> {
    const tenant = await TenantRepo.findById(tenantId);
    if (!tenant) throw new HttpError("Unknown region", 404);
    return PaymentPlanSvc.siteCurrency(tenant.id, asTenantCode(tenant.code));
  }

  /** What a lawyer on this tenant can top up, for the lawyer app's amount picker. */
  static async terms(tenantId: string): Promise<AccountTopUpTerms> {
    return termsOf(await AccountTopUpPricingSvc.currencyOf(tenantId));
  }

  /** The admin's Payment plans pages: every Tenant's current top-up fee and rate, defaulted ones
   * included. */
  static async listForAdmin() {
    const [tenants, feeRows, rateRows] = await Promise.all([
      TenantRepo.listAll(),
      TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.accountTopUpFee),
      TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.accountTopUpRate),
    ]);
    const currencies = await PaymentPlanSvc.siteCurrencies(tenants);
    return tenants.map((tenant) => {
      const code = asTenantCode(tenant.code);
      const currency = currencies.get(tenant.id)!;
      // A row set in another currency doesn't apply, so it isn't credited to whoever saved it either.
      const feeRow = feeRows.find((r) => r.tenantId === tenant.id && isAccountTopUpFee(r.value, currency));
      const rateRow = currency === "USD" ? undefined : rateRows.find((r) => r.tenantId === tenant.id && isRate(r.value, currency));
      const fee = feeFromRow(feeRow?.value, currency);
      return {
        code,
        name: tenant.name,
        currency,
        feeType: fee.feeType,
        feeAmount: fee.feeAmount,
        feeUpdatedAt: feeRow?.updatedAt ?? null,
        feeUpdatedBy: feeRow?.updatedBy ?? null,
        // Null on a US-dollar site: there's nothing to convert.
        perUsd: currency === "USD" ? null : rateRow ? (rateRow.value as { perUsd: number }).perUsd : AI_CREDIT_RATE_DEFAULT[currency],
        rateUpdatedAt: rateRow?.updatedAt ?? null,
        rateUpdatedBy: rateRow?.updatedBy ?? null,
      };
    });
  }

  static async setFee(code: TenantCode, feeType: AccountTopUpFeeType, feeAmount: number, adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    const currency = await PaymentPlanSvc.siteCurrency(tenant.id, code);
    if (feeType === "PERCENT" && feeAmount > 100) throw new HttpError("A percentage fee can't exceed 100", 400);
    if (feeType === "FIXED" && PLAN_CURRENCIES[currency].exponent === 0 && !Number.isInteger(feeAmount)) {
      throw new HttpError(`A fixed fee must be a whole number of ${currency}`, 400);
    }

    const before = await AccountTopUpPricingSvc.fee(tenant.id, currency);
    await TenantSettingRepo.upsert(tenant.id, TENANT_SETTING_KEYS.accountTopUpFee, { feeType, feeAmount, currency }, adminId);

    await SecurityAuditSvc.record({
      action: "admin.settings.account_topup_fee_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { from: before, to: { feeType, feeAmount }, currency },
    });

    const all = await AccountTopUpPricingSvc.listForAdmin();
    return all.find((t) => t.code === code)!;
  }

  /** How much of a non-dollar site's currency buys $1 of AI usage on a top-up (₩1,400 on KR). Reaches
   * the next top-up; one already paid keeps the AI usage it bought. */
  static async setRate(code: TenantCode, perUsd: number, adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    const currency = await PaymentPlanSvc.siteCurrency(tenant.id, code);
    if (currency === "USD") throw new HttpError(`${code} charges in US dollars, so it has no rate to set`, 400, "RATE_NOT_APPLICABLE");
    const { min, max } = AI_CREDIT_RATE_LIMITS[currency];
    if (!Number.isFinite(perUsd) || perUsd < min || perUsd > max) {
      throw new HttpError(`The rate must be between ${min} and ${max} ${currency} per US dollar`, 400, "RATE_OUT_OF_RANGE");
    }

    const before = await AccountTopUpPricingSvc.perUsd(tenant.id, currency);
    await TenantSettingRepo.upsert(tenant.id, TENANT_SETTING_KEYS.accountTopUpRate, { perUsd, currency }, adminId);
    await SecurityAuditSvc.record({
      action: "admin.settings.account_topup_rate_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { from: { perUsd: before }, to: { perUsd }, currency },
    });

    const all = await AccountTopUpPricingSvc.listForAdmin();
    return all.find((t) => t.code === code)!;
  }

  /** The single fee calc every quote/checkout call goes through, so they can never disagree.
   * `amount` is in major units of the site's currency. Throws on an out-of-bounds amount, or part of
   * a won, rather than adjusting it silently. */
  static async quoteMinor(tenantId: string, amount: number): Promise<AccountTopUpQuoteMinor> {
    const currency = await AccountTopUpPricingSvc.currencyOf(tenantId);
    const { exponent } = PLAN_CURRENCIES[currency];
    const { minMinor, maxMinor } = ACCOUNT_TOPUP_TERMS[currency];
    const amountMinor = Math.round(amount * 10 ** exponent);
    if (!Number.isFinite(amount) || Math.abs(amountMinor - amount * 10 ** exponent) > 1e-6 || amountMinor < minMinor || amountMinor > maxMinor) {
      throw new HttpError(`Choose an amount between ${formatAmount(minMinor, currency)} and ${formatAmount(maxMinor, currency)}`, 400, "TOPUP_AMOUNT_OUT_OF_RANGE");
    }
    const [fee, perUsd] = await Promise.all([AccountTopUpPricingSvc.fee(tenantId, currency), AccountTopUpPricingSvc.perUsd(tenantId, currency)]);
    const feeMinor = fee.feeType === "FIXED" ? Math.round(fee.feeAmount * 10 ** exponent) : Math.round((amountMinor * fee.feeAmount) / 100);
    const totalMinor = amountMinor + feeMinor;
    // In dollars, the site's currency at the rate (exact on a US-dollar site).
    const usd = (minor: number) => round2(toMajor(minor, currency) / perUsd);
    return { currency, amountMinor, feeMinor, totalMinor, creditUsd: usd(amountMinor), feeUsd: usd(feeMinor), totalUsd: usd(totalMinor) };
  }

  static async quote(tenantId: string, amount: number): Promise<AccountTopUpQuote> {
    return AccountTopUpPricingSvc.toQuote(await AccountTopUpPricingSvc.quoteMinor(tenantId, amount));
  }

  static toQuote(q: Pick<AccountTopUpQuoteMinor, "currency" | "amountMinor" | "feeMinor" | "totalMinor" | "creditUsd">): AccountTopUpQuote {
    return {
      currency: q.currency,
      topUpAmount: toMajor(q.amountMinor, q.currency),
      feeAmount: toMajor(q.feeMinor, q.currency),
      totalCharged: toMajor(q.totalMinor, q.currency),
      creditUsd: q.creditUsd,
    };
  }

  /** Turns dollars of AI usage into the site's currency, for display (a plan's "₩14,000 of AI
   * usage"), in the currency's smallest unit. Reads the rate once for every amount converted. */
  static async aiUsageConverter(tenantId: string): Promise<(usd: number) => { amountMinor: number; currency: PlanCurrency }> {
    const currency = await AccountTopUpPricingSvc.currencyOf(tenantId);
    const perUsd = await AccountTopUpPricingSvc.perUsd(tenantId, currency);
    const factor = perUsd * 10 ** PLAN_CURRENCIES[currency].exponent;
    return (usd) => ({ amountMinor: Math.round(usd * factor), currency });
  }
}
