import TenantSettingRepo from "../repositories/tenant-setting.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { TenantCode } from "../types/tenant-code";
import { TENANT_SETTING_KEYS, ACCOUNT_TOPUP_FEE_DEFAULT } from "../constants/tenant-settings.constants";

export type AccountTopUpFeeType = "FIXED" | "PERCENT";

export interface AccountTopUpFee {
  feeType: AccountTopUpFeeType;
  feeAmount: number;
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

/**
 * The per-tenant platform fee on a self-serve account AI top-up (TENANT_SETTING_KEYS.accountTopUpFee,
 * AccountTopUpBillingSvc): FIXED is a flat USD amount, PERCENT is 0-100, applied to the lawyer's
 * chosen top-up amount. Stored as a TenantSetting row (reusing the existing signup-approval
 * setting's pattern, not a bespoke table) — a tenant with no row yet (no admin has saved one)
 * falls back to a sane default rather than refusing to quote.
 *
 * The account's base AI allowance and per-account case limit no longer live here — they come from
 * the lawyer's PaymentPlan tier (PaymentPlanSvc, AccountLimitsSvc), since a tenant can have several
 * tiers rather than one flat plan.
 */
export default class AccountTopUpPricingSvc {
  static async fee(tenantId: string): Promise<AccountTopUpFee> {
    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.accountTopUpFee);
    return isAccountTopUpFee(row?.value) ? (row!.value as AccountTopUpFee) : ACCOUNT_TOPUP_FEE_DEFAULT;
  }

  /** The admin Settings page: every Tenant's current top-up fee, defaulted ones included. */
  static async listForAdmin() {
    const [tenants, feeRows] = await Promise.all([TenantRepo.listAll(), TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.accountTopUpFee)]);
    return tenants.map((tenant) => {
      const feeRow = feeRows.find((r) => r.tenantId === tenant.id);
      const fee: AccountTopUpFee = isAccountTopUpFee(feeRow?.value) ? (feeRow!.value as AccountTopUpFee) : ACCOUNT_TOPUP_FEE_DEFAULT;
      return {
        code: tenant.code as TenantCode,
        name: tenant.name,
        feeType: fee.feeType,
        feeAmount: fee.feeAmount,
        feeUpdatedAt: feeRow?.updatedAt ?? null,
        feeUpdatedBy: feeRow?.updatedBy ?? null,
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
