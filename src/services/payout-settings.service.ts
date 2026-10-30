import PayoutSettingsRepo, { type PayoutSettingsPatch } from "../repositories/payout-settings.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import type { TenantCode } from "../types/tenant-code";
import type { QuoteTerms } from "../types/client-handoff";
import { PAYOUT_LIMITS, PAYOUT_SETTINGS_CACHE_TTL_S, PAYOUT_SETTINGS_DEFAULTS, payoutSettingsCacheKey } from "../constants/payout.constants";

/** A tenant's quotation payment terms as the services use them. */
export interface PayoutTerms {
  platformFeeBps: number;
  minPlatformFeeMinor: number;
  earningsHoldDays: number;
  minWithdrawalMinor: number;
  currency: string;
}

const FIELDS = ["platformFeeBps", "minPlatformFeeMinor", "earningsHoldDays", "minWithdrawalMinor"] as const;

const DEFAULTS: PayoutTerms = {
  platformFeeBps: PAYOUT_SETTINGS_DEFAULTS.platformFeeBps,
  minPlatformFeeMinor: PAYOUT_SETTINGS_DEFAULTS.minPlatformFeeMinor,
  earningsHoldDays: PAYOUT_SETTINGS_DEFAULTS.earningsHoldDays,
  minWithdrawalMinor: PAYOUT_SETTINGS_DEFAULTS.minWithdrawalMinor,
  currency: PAYOUT_SETTINGS_DEFAULTS.currency,
};

async function tenantIdOf(code: TenantCode): Promise<string> {
  const tenant = await TenantRepo.findByCode(code);
  if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
  return tenant.id;
}

function termsOf(row: Partial<PayoutTerms> | null): PayoutTerms {
  return row ? { ...DEFAULTS, ...Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? DEFAULTS[f]])) } : DEFAULTS;
}

/**
 * The quotation payment terms per tenant (PayoutSettings), edited by admins on the admin Settings
 * page: the platform fee rate and its minimum (added on top of a lawyer's service fee for the
 * client), how long an earning waits before it can be withdrawn, and the smallest withdrawal. Read
 * through forTenant(), cached per tenant for PAYOUT_SETTINGS_CACHE_TTL_S. A change only reaches what
 * comes after it: a sent quote keeps its fee (Quotation.platformFeeBps), an earning its availableAt.
 * Every change is recorded in the security audit log.
 */
export default class PayoutSettingsSvc {
  static async forTenant(tenantId: string): Promise<PayoutTerms> {
    const cached = await redis.get<PayoutTerms>(payoutSettingsCacheKey(tenantId));
    if (cached) return cached;
    const terms = termsOf(await PayoutSettingsRepo.find(tenantId));
    await redis.set(payoutSettingsCacheKey(tenantId), terms, PAYOUT_SETTINGS_CACHE_TTL_S);
    return terms;
  }

  static async forTenantCode(code: TenantCode): Promise<PayoutTerms> {
    return PayoutSettingsSvc.forTenant(await tenantIdOf(code));
  }

  /** QuoteTerms in the contract: what the lawyer app needs to preview a quote's platform fee. */
  static async quoteTerms(code: TenantCode): Promise<QuoteTerms> {
    const terms = await PayoutSettingsSvc.forTenantCode(code);
    return { platformFeeBps: terms.platformFeeBps, minPlatformFee: { amountMinor: terms.minPlatformFeeMinor, currency: "GBP" } };
  }

  /** The admin Settings page: every tenant's terms, with whether they're still the defaults. */
  static async listForAdmin() {
    const [tenants, rows] = await Promise.all([TenantRepo.listAll(), PayoutSettingsRepo.listAll()]);
    return {
      currency: DEFAULTS.currency,
      defaults: DEFAULTS,
      limits: PAYOUT_LIMITS,
      tenants: tenants.map((tenant) => {
        const row = rows.find((r) => r.tenantId === tenant.id) ?? null;
        return {
          code: tenant.code as TenantCode,
          name: tenant.name,
          settings: termsOf(row),
          isDefault: row === null,
          updatedAt: row?.updatedAt ?? null,
        };
      }),
    };
  }

  static async update(code: TenantCode, patch: PayoutSettingsPatch, adminId: string) {
    for (const field of FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      const { min, max } = PAYOUT_LIMITS[field];
      if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(`${field} must be a whole number from ${min} to ${max}`, 400, "PAYOUT_SETTING_OUT_OF_RANGE");
    }
    const tenantId = await tenantIdOf(code);
    const before = termsOf(await PayoutSettingsRepo.find(tenantId));
    const { currency: _currency, ...base } = before;
    const row = await PayoutSettingsRepo.upsert(tenantId, base, patch, adminId);
    await redis.del(payoutSettingsCacheKey(tenantId));
    await SecurityAuditSvc.record({
      action: "admin.settings.payout_settings_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "payout_settings",
      targetId: code,
      payload: { from: Object.fromEntries(FIELDS.map((f) => [f, before[f]])), to: patch },
    });
    return { code, settings: termsOf(row), isDefault: false, updatedAt: row.updatedAt };
  }
}
