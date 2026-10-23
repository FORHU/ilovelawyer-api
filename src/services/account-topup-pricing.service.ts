import TenantSettingRepo from "../repositories/tenant-setting.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { TenantCode } from "../types/tenant-code";
import { TENANT_SETTING_KEYS, ACCOUNT_TOPUP_FEE_DEFAULT, SUBSCRIPTION_PLAN_DEFAULT } from "../constants/tenant-settings.constants";

export type AccountTopUpFeeType = "FIXED" | "PERCENT";

export interface AccountTopUpFee {
  feeType: AccountTopUpFeeType;
  feeAmount: number;
}

export interface SubscriptionPlan {
  name: string;
  /** Placeholder, shown to the lawyer; not yet charged via recurring Stripe billing. */
  monthlyPriceUsd: number;
  /** The account's base monthly AI allowance (replaces the old flat CASE_SPEND_LIMIT_USD). */
  includedAllowanceUsd: number;
}

export interface AccountTopUpQuote {
  topUpAmountUsd: number;
  feeAmountUsd: number;
  totalChargedUsd: number;
}

const MIN_TOPUP_USD = 5;
const MAX_TOPUP_USD = 500;

function isAccountTopUpFee(value: unknown): value is AccountTopUpFee {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.feeType === "FIXED" || v.feeType === "PERCENT") && typeof v.feeAmount === "number" && Number.isFinite(v.feeAmount) && v.feeAmount >= 0;
}

function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.monthlyPriceUsd === "number" && Number.isFinite(v.monthlyPriceUsd) && typeof v.includedAllowanceUsd === "number" && Number.isFinite(v.includedAllowanceUsd) && v.includedAllowanceUsd >= 0;
}

/**
 * Two per-tenant admin settings, both stored as TenantSetting rows (reusing the existing
 * signup-approval setting's pattern, not bespoke tables):
 *  - The subscription plan (TENANT_SETTING_KEYS.subscriptionPlan): a placeholder monthly price and
 *    the account's included AI allowance, replacing the old flat CASE_SPEND_LIMIT_USD.
 *  - The platform fee on a self-serve account top-up (TENANT_SETTING_KEYS.accountTopUpFee,
 *    AccountTopUpBillingSvc): FIXED is a flat USD amount, PERCENT is 0-100, applied to the
 *    lawyer's chosen top-up amount.
 * A tenant with no row yet (no admin has saved one) falls back to a sane default rather than
 * refusing to quote.
 */
export default class AccountTopUpPricingSvc {
  static async fee(tenantId: string): Promise<AccountTopUpFee> {
    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.accountTopUpFee);
    return isAccountTopUpFee(row?.value) ? (row!.value as AccountTopUpFee) : ACCOUNT_TOPUP_FEE_DEFAULT;
  }

  static async plan(tenantId: string): Promise<SubscriptionPlan> {
    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.subscriptionPlan);
    return isSubscriptionPlan(row?.value) ? (row!.value as SubscriptionPlan) : SUBSCRIPTION_PLAN_DEFAULT;
  }

  /** The admin Settings page: every Tenant's current fee and plan, defaulted ones included. */
  static async listForAdmin() {
    const [tenants, feeRows, planRows] = await Promise.all([
      TenantRepo.listAll(),
      TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.accountTopUpFee),
      TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.subscriptionPlan),
    ]);
    return tenants.map((tenant) => {
      const feeRow = feeRows.find((r) => r.tenantId === tenant.id);
      const fee: AccountTopUpFee = isAccountTopUpFee(feeRow?.value) ? (feeRow!.value as AccountTopUpFee) : ACCOUNT_TOPUP_FEE_DEFAULT;
      const planRow = planRows.find((r) => r.tenantId === tenant.id);
      const plan: SubscriptionPlan = isSubscriptionPlan(planRow?.value) ? (planRow!.value as SubscriptionPlan) : SUBSCRIPTION_PLAN_DEFAULT;
      return {
        code: tenant.code as TenantCode,
        name: tenant.name,
        feeType: fee.feeType,
        feeAmount: fee.feeAmount,
        feeUpdatedAt: feeRow?.updatedAt ?? null,
        feeUpdatedBy: feeRow?.updatedBy ?? null,
        plan,
        planUpdatedAt: planRow?.updatedAt ?? null,
        planUpdatedBy: planRow?.updatedBy ?? null,
      };
    });
  }

  static async setFee(code: TenantCode, feeType: AccountTopUpFeeType, feeAmount: number, adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    if (feeType === "PERCENT" && feeAmount > 100) throw new HttpError("A percentage fee can't exceed 100", 400);

    const before = await AccountTopUpPricingSvc.fee(tenant.id);
    await TenantSettingRepo.upsert(tenant.id, TENANT_SETTING_KEYS.accountTopUpFee, { feeType, feeAmount }, adminId);

    await SecurityAuditSvc.record({
      action: "admin.settings.account_topup_fee_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { from: before, to: { feeType, feeAmount } },
    });

    const all = await AccountTopUpPricingSvc.listForAdmin();
    return all.find((t) => t.code === code)!;
  }

  static async setPlan(code: TenantCode, plan: SubscriptionPlan, adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    if (plan.monthlyPriceUsd < 0 || plan.includedAllowanceUsd < 0) throw new HttpError("Price and included allowance can't be negative", 400);

    const before = await AccountTopUpPricingSvc.plan(tenant.id);
    await TenantSettingRepo.upsert(tenant.id, TENANT_SETTING_KEYS.subscriptionPlan, { ...plan }, adminId);

    await SecurityAuditSvc.record({
      action: "admin.settings.subscription_plan_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { from: before, to: plan },
    });

    const all = await AccountTopUpPricingSvc.listForAdmin();
    return all.find((t) => t.code === code)!;
  }

  /** The single fee calc every quote/checkout call goes through, so they can never disagree. Throws
   * on an out-of-bounds amount rather than clamping it silently. */
  static async quote(tenantId: string, topUpAmountUsd: number): Promise<AccountTopUpQuote> {
    if (!Number.isFinite(topUpAmountUsd) || topUpAmountUsd < MIN_TOPUP_USD || topUpAmountUsd > MAX_TOPUP_USD) {
      throw new HttpError(`Choose an amount between $${MIN_TOPUP_USD} and $${MAX_TOPUP_USD}`, 400, "TOPUP_AMOUNT_OUT_OF_RANGE");
    }
    const fee = await AccountTopUpPricingSvc.fee(tenantId);
    const feeAmountUsd = Math.round((fee.feeType === "FIXED" ? fee.feeAmount : (topUpAmountUsd * fee.feeAmount) / 100) * 100) / 100;
    return { topUpAmountUsd, feeAmountUsd, totalChargedUsd: Math.round((topUpAmountUsd + feeAmountUsd) * 100) / 100 };
  }
}
