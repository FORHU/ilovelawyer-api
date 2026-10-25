import { Prisma, type PaymentPlan } from "@prisma/client";
import LawyerPricingRepo, { type LawyerPricePatch } from "../repositories/lawyer-pricing.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { redis } from "../lib/redis";
import type { TenantCode } from "../types/tenant-code";
import {
  LAWYER_PRICE_MAX_MINOR,
  LAWYER_PRICE_MIN_MINOR,
  LAWYER_PRICING_CACHE_TTL_S,
  LAWYER_PRICING_DEFAULTS,
  lawyerPricingCacheKey,
} from "../constants/lawyer-pricing.constants";

export interface Money {
  amountMinor: number;
  currency: string;
}

/** TopUpPack in the contract: what the card is charged, and the AI credit it adds. */
export interface LawyerTopUpPack {
  /** The pack's code ("standard"): what the lawyer app sends back to buy it. */
  id: string;
  name: string;
  price: Money;
  credit: Money;
}

/** What a tenant's lawyers pay now. Active packs only. */
export interface LawyerPriceList {
  introFee: Money;
  topUpPacks: LawyerTopUpPack[];
}

export interface NewLawyerPackInput {
  code: string;
  name: string;
  priceMinor: number;
  creditMinor: number;
}

type AuditAction = "admin.settings.lawyer_price_created" | "admin.settings.lawyer_price_changed";

const PACK_CODE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const { currency } = LAWYER_PRICING_DEFAULTS;

function assertAmount(amountMinor: number, label: string) {
  if (!Number.isInteger(amountMinor) || amountMinor < LAWYER_PRICE_MIN_MINOR || amountMinor > LAWYER_PRICE_MAX_MINOR) {
    throw new HttpError(`${label} must be between ${LAWYER_PRICE_MIN_MINOR} and ${LAWYER_PRICE_MAX_MINOR} pence`, 400, "PRICE_OUT_OF_RANGE");
  }
}

function money(amountMinor: number | null): Money {
  return { amountMinor: amountMinor ?? 0, currency };
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function tenantIdOf(code: TenantCode): Promise<string> {
  const tenant = await TenantRepo.findByCode(code);
  if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
  return tenant.id;
}

/**
 * What lawyers pay in the UK client-to-lawyer hand-off, edited by admins per tenant (#598), the same
 * way as the client app's prices (ClientPricingSvc, ADR 0017): the introduction fee charged when a
 * client confirms a lawyer (#513), and the AI top-up packs (#516). PaymentPlan rows LAWYER_INTRO_FEE
 * (one per tenant) and LAWYER_AI_TOP_UP, in GBP like every quote.
 *
 * Read through forTenant(), cached per tenant for LAWYER_PRICING_CACHE_TTL_S, so an edit reaches the
 * next confirmation within about a minute. Every write clears that tenant's cache and is recorded in
 * the security audit log. A charge already made keeps the amount it was charged
 * (OrganizationCharge.amountMinor, creditMinor).
 */
export default class LawyerPricingSvc {
  static async forTenant(tenantId: string): Promise<LawyerPriceList> {
    const cached = await redis.get<LawyerPriceList>(lawyerPricingCacheKey(tenantId));
    if (cached) return cached;

    const rows = await LawyerPricingRepo.listPrices(tenantId);
    const fee = rows.find((r) => r.planType === "LAWYER_INTRO_FEE");
    // Seeded for every tenant, so this shouldn't happen; if it does, lawyers still pay the default
    // rather than confirmations failing.
    if (!fee) logger.warn("Lawyer pricing: no introduction fee row, using the default", { tenantId });
    const list: LawyerPriceList = {
      introFee: money(fee?.priceMinor ?? LAWYER_PRICING_DEFAULTS.introFee.priceMinor),
      topUpPacks: rows
        .filter((r) => r.planType === "LAWYER_AI_TOP_UP" && r.isActive)
        .map((p) => ({ id: p.code, name: p.name, price: money(p.priceMinor), credit: money(p.creditMinor) })),
    };
    await redis.set(lawyerPricingCacheKey(tenantId), list, LAWYER_PRICING_CACHE_TTL_S);
    return list;
  }

  static async forTenantCode(code: TenantCode): Promise<LawyerPriceList> {
    return LawyerPricingSvc.forTenant(await tenantIdOf(code));
  }

  /** The admin Settings page: each tenant's fee and every pack, inactive ones too. */
  static async listForAdmin() {
    const [tenants, rows] = await Promise.all([TenantRepo.listAll(), LawyerPricingRepo.listAllPrices()]);
    return {
      currency,
      minMinor: LAWYER_PRICE_MIN_MINOR,
      maxMinor: LAWYER_PRICE_MAX_MINOR,
      tenants: tenants.map((tenant) => ({
        code: tenant.code as TenantCode,
        name: tenant.name,
        introFee: rows.find((r) => r.tenantId === tenant.id && r.planType === "LAWYER_INTRO_FEE") ?? null,
        packs: rows.filter((r) => r.tenantId === tenant.id && r.planType === "LAWYER_AI_TOP_UP"),
      })),
    };
  }

  static async updateIntroFee(tenantCode: TenantCode, input: { priceMinor: number }, adminId: string) {
    const tenantId = await tenantIdOf(tenantCode);
    const before = (await LawyerPricingRepo.listPrices(tenantId)).find((r) => r.planType === "LAWYER_INTRO_FEE");
    if (!before) throw new HttpError(`${tenantCode} has no introduction fee set up`, 500, "LAWYER_PRICING_MISSING");
    assertAmount(input.priceMinor, "The introduction fee");

    const row = await LawyerPricingRepo.updatePrice(before.id, { priceMinor: input.priceMinor }, adminId);
    await LawyerPricingSvc.changed(tenantId, "admin.settings.lawyer_price_changed", adminId, `${tenantCode}:${before.code}`, {
      from: { priceMinor: before.priceMinor },
      to: { priceMinor: row.priceMinor },
    });
    return row;
  }

  static async createPack(tenantCode: TenantCode, input: NewLawyerPackInput, adminId: string) {
    const tenantId = await tenantIdOf(tenantCode);
    const code = input.code.trim().toLowerCase();
    if (!PACK_CODE.test(code)) throw new HttpError("A pack code is lowercase letters, digits, - or _, up to 32", 400);
    if (!input.name.trim()) throw new HttpError("A pack needs a name", 400);
    assertAmount(input.priceMinor, "The pack price");
    assertAmount(input.creditMinor, "The pack's AI credit");

    let pack: PaymentPlan;
    try {
      pack = await LawyerPricingRepo.createPack(tenantId, {
        code,
        name: input.name.trim(),
        priceMinor: input.priceMinor,
        creditMinor: input.creditMinor,
        currency,
        level: (await LawyerPricingRepo.maxPackLevel(tenantId)) + 1,
        updatedById: adminId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(`${tenantCode} already has a pack with code "${code}"`, 409);
      throw err;
    }
    await LawyerPricingSvc.changed(tenantId, "admin.settings.lawyer_price_created", adminId, `${tenantCode}:${code}`, { to: { ...input, code } });
    return pack;
  }

  /** Edit, reorder (`level`) or turn a pack on or off. Turning every pack off is allowed: lawyers
   * then can't top up, which is a choice an admin can make. */
  static async updatePack(id: string, patch: LawyerPricePatch, adminId: string) {
    const before = await LawyerPricingRepo.findPrice(id);
    if (!before || before.planType !== "LAWYER_AI_TOP_UP") throw new HttpError("Unknown top-up pack", 404);
    if (patch.name !== undefined && !patch.name.trim()) throw new HttpError("A pack needs a name", 400);
    if (patch.priceMinor !== undefined) assertAmount(patch.priceMinor, "The pack price");
    if (patch.creditMinor !== undefined) assertAmount(patch.creditMinor, "The pack's AI credit");

    const row = await LawyerPricingRepo.updatePrice(id, { ...patch, name: patch.name?.trim() }, adminId);
    await LawyerPricingSvc.changed(before.tenantId, "admin.settings.lawyer_price_changed", adminId, `${before.tenant.code}:${before.code}`, {
      from: { name: before.name, priceMinor: before.priceMinor, creditMinor: before.creditMinor, level: before.level, isActive: before.isActive },
      to: patch,
    });
    return row;
  }

  /** `targetId` is "<tenant>:<code>", e.g. "UK:intro", "UK:standard". */
  private static async changed(tenantId: string, action: AuditAction, adminId: string, targetId: string, payload: Record<string, unknown>) {
    await redis.del(lawyerPricingCacheKey(tenantId));
    await SecurityAuditSvc.record({ action, actorId: adminId, organizationId: null, targetType: "lawyer_price", targetId, payload });
  }
}
