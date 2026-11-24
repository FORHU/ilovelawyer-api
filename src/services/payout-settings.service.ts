import PayoutSettingsRepo, { type PayoutSettingsPatch } from "../repositories/payout-settings.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import type { TenantCode } from "../types/tenant-code";
import type { QuoteTerms } from "../types/client-handoff";
import { PAYOUT_LIMITS, PAYOUT_SETTINGS_CACHE_TTL_S, PAYOUT_SETTINGS_DEFAULTS, PAYOUT_SETTINGS_DEFAULTS_KRW, payoutSettingsCacheKey } from "../constants/payout.constants";
import { FEE_CURRENCY_BY_COUNTRY } from "../constants/lawyer-application.constants";
import { paysLawyerDirectly } from "../constants/client-request.constants";

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

/** A site's starting terms, in its own currency: GBP on UK (and PH, which has no requests), KRW on KR. */
function defaultsFor(code: string | null | undefined): PayoutTerms {
  if (code !== "KR") return DEFAULTS;
  const d = PAYOUT_SETTINGS_DEFAULTS_KRW;
  return { platformFeeBps: d.platformFeeBps, minPlatformFeeMinor: d.minPlatformFeeMinor, earningsHoldDays: d.earningsHoldDays, minWithdrawalMinor: d.minWithdrawalMinor, currency: d.currency };
}

/** What a site's requests are quoted and paid in (FEE_CURRENCY_BY_COUNTRY), for an amount an admin sets. */
function currencyFor(code: string | null | undefined): string {
  return code === "KR" ? FEE_CURRENCY_BY_COUNTRY.KR : DEFAULTS.currency;
}

async function tenantIdOf(code: TenantCode): Promise<string> {
  const tenant = await TenantRepo.findByCode(code);
  if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
  return tenant.id;
}

/** A site's terms: what an admin set, the rest its defaults, always in the site's own currency. On a
 * site where the client pays the lawyer directly (KR) there is no platform fee, whatever a row says. */
function termsOf(row: Partial<PayoutTerms> | null, code?: string | null): PayoutTerms {
  const defaults = defaultsFor(code);
  const base = row ? { ...defaults, ...Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? defaults[f]])) } : defaults;
  const noFee = paysLawyerDirectly(code) ? { platformFeeBps: 0, minPlatformFeeMinor: 0 } : {};
  return { ...base, ...noFee, currency: currencyFor(code) };
}

/**
 * The quotation payment terms per tenant (PayoutSettings), edited by admins on the admin Settings
 * page: the platform fee rate and its minimum (deducted from the amount a lawyer quotes, which is
 * what the client pays), how long an earning waits after its engagement closes before it can be
 * withdrawn, and the smallest withdrawal. Read
 * through forTenant(), cached per tenant for PAYOUT_SETTINGS_CACHE_TTL_S. A change only reaches what
 * comes after it: a sent quote keeps its fee (Quotation.platformFeeBps), an earning whose hold has
 * started its availableAt.
 * Every change is recorded in the security audit log.
 */
export default class PayoutSettingsSvc {
  static async forTenant(tenantId: string): Promise<PayoutTerms> {
    const cached = await redis.get<PayoutTerms>(payoutSettingsCacheKey(tenantId));
    if (cached) return cached;
    const code = (await TenantRepo.findById(tenantId))?.code ?? null;
    const terms = termsOf(await PayoutSettingsRepo.find(tenantId), code);
    await redis.set(payoutSettingsCacheKey(tenantId), terms, PAYOUT_SETTINGS_CACHE_TTL_S);
    return terms;
  }

  static async forTenantCode(code: TenantCode): Promise<PayoutTerms> {
    return PayoutSettingsSvc.forTenant(await tenantIdOf(code));
  }

  /** QuoteTerms in the contract: what the lawyer app needs to preview a quote's platform fee. */
  static async quoteTerms(code: TenantCode): Promise<QuoteTerms> {
    const terms = await PayoutSettingsSvc.forTenantCode(code);
    return { platformFeeBps: terms.platformFeeBps, minPlatformFee: { amountMinor: terms.minPlatformFeeMinor, currency: terms.currency as "GBP" } };
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
          // Each site's amounts are in its own currency (settings.currency).
          settings: termsOf(row, tenant.code),
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
    if (paysLawyerDirectly(code) && ((patch.platformFeeBps ?? 0) !== 0 || (patch.minPlatformFeeMinor ?? 0) !== 0)) {
      throw new HttpError(`${code} clients pay lawyers directly, so it has no platform fee.`, 400, "PLATFORM_FEE_NOT_ALLOWED");
    }
    const tenantId = await tenantIdOf(code);
    const before = termsOf(await PayoutSettingsRepo.find(tenantId), code);
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
    return { code, settings: termsOf(row, code), isDefault: false, updatedAt: row.updatedAt };
  }
}
