import { Prisma, type ClientPromo, type PaymentPlan } from "@prisma/client";
import ClientPricingRepo, { type ClientPricePatch, type ClientPromoData } from "../repositories/client-pricing.repository";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import { TenantCode } from "../types/tenant-code";
import {
  CLIENT_CURRENCIES,
  CLIENT_CURRENCY_CODES,
  CLIENT_PRICING_CACHE_TTL_S,
  clientPricingCacheKey,
  type ClientCurrency,
} from "../constants/client-pricing.constants";

export interface Money {
  amountMinor: number;
  currency: string;
}

/** A new case is free: this is only the chat credits it starts with. */
export interface ClientCasePrice {
  credits: number;
}

export interface ClientPack {
  /** The pack's code ("p100"): what the client app sends back to buy it. */
  id: string;
  name: string;
  credits: number;
  price: Money;
}

/** What checkout and the client app's price list read, for one tenant. Active packs only. */
export interface ClientPriceList {
  case: ClientCasePrice;
  topUpPacks: ClientPack[];
  defaultPackId: string | null;
}

export type PromoCheck = { ok: true; promo: ClientPromo; discountMinor: number } | { ok: false; code: string; message: string };

export interface CasePriceInput {
  credits: number;
}

export interface NewPackInput {
  code: string;
  name: string;
  priceMinor: number;
  credits: number;
  currency: string;
}

export type NewPromoInput = Omit<ClientPromoData, "expiresAt" | "isActive"> & { code: string; expiresAt?: Date | null; isActive?: boolean };

type AuditAction = "admin.settings.client_price_created" | "admin.settings.client_price_changed" | "admin.settings.client_promo_created" | "admin.settings.client_promo_changed";

const PACK_CODE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROMO_CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

function currencyOf(code: string): ClientCurrency {
  const upper = code.trim().toUpperCase();
  if (!(upper in CLIENT_CURRENCIES)) throw new HttpError(`Choose one of ${CLIENT_CURRENCY_CODES.join(", ")}`, 400, "CURRENCY_NOT_SUPPORTED");
  return upper as ClientCurrency;
}

/** A price is 0 (free, settled without Stripe) or between Stripe's minimum and our ceiling. */
function assertPrice(amountMinor: number, currency: ClientCurrency, label: string) {
  const { minMinor, maxMinor } = CLIENT_CURRENCIES[currency];
  if (!Number.isInteger(amountMinor) || amountMinor < 0 || (amountMinor > 0 && amountMinor < minMinor) || amountMinor > maxMinor) {
    throw new HttpError(`${label} must be 0, or between ${minMinor} and ${maxMinor} in ${currency}'s smallest unit`, 400, "PRICE_OUT_OF_RANGE");
  }
}

function assertCredits(credits: number) {
  if (!Number.isInteger(credits) || credits < 1) throw new HttpError("Credits must be a whole number of at least 1", 400);
}

function moneyOf(row: PaymentPlan): Money {
  return { amountMinor: row.priceMinor ?? 0, currency: row.currency ?? "USD" };
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
 * The client app's prices, edited by admins (ilovelawyer-admin Settings), per tenant like the
 * lawyer subscription tiers: each tenant has the chat credits a new (free) case starts with, its
 * credit top-up packs and its promo codes, which come off a top-up. A client pays their own
 * tenant's prices (User.tenantId). Prices are PaymentPlan rows (B2C_CASE, credits only, and
 * B2C_TOP_UP) and promos are ClientPromo rows; see ADR 0017 and ADR 0019.
 *
 * Checkout reads priceList(), cached per tenant for CLIENT_PRICING_CACHE_TTL_S, so an edit reaches
 * clients within about a minute. Every write clears that tenant's cache and is recorded in the
 * security audit log. A payment already taken keeps the amount it was charged
 * (ClientPayment.amountMinor).
 */
export default class ClientPricingSvc {
  /** The tenant whose prices apply to this client. */
  static async tenantIdForClient(userId: string): Promise<string> {
    const tenantId = await ClientPaymentRepo.findTenantId(userId);
    if (!tenantId) throw new HttpError("This account isn't in a region, so it has no prices", 409, "CLIENT_TENANT_MISSING");
    return tenantId;
  }

  static async priceList(tenantId: string): Promise<ClientPriceList> {
    const cached = await redis.get<ClientPriceList>(clientPricingCacheKey(tenantId));
    if (cached) return cached;

    const rows = await ClientPricingRepo.listPrices(tenantId);
    const caseRow = rows.find((r) => r.planType === "B2C_CASE");
    if (!caseRow) throw new HttpError("The client app's new-case credits aren't set up for this region", 500, "CLIENT_PRICING_MISSING");
    const packs = rows.filter((r) => r.planType === "B2C_TOP_UP" && r.isActive);
    const list: ClientPriceList = {
      case: { credits: caseRow.credits ?? 0 },
      topUpPacks: packs.map((p) => ({ id: p.code, name: p.name, credits: p.credits ?? 0, price: moneyOf(p) })),
      defaultPackId: (packs.find((p) => p.isDefault) ?? packs[0])?.code ?? null,
    };
    await redis.set(clientPricingCacheKey(tenantId), list, CLIENT_PRICING_CACHE_TTL_S);
    return list;
  }

  /** Whether one of the tenant's promo codes takes money off this client's top-up. `packPrice` is
   * the price it would come off; `discountMinor` is how much it takes off. */
  static async checkPromo(tenantId: string, userId: string, rawCode: string, packPrice: Money): Promise<PromoCheck> {
    const code = rawCode.trim().toUpperCase();
    const promo = await ClientPricingRepo.findPromoByCode(tenantId, code);
    if (!promo || !promo.isActive) return { ok: false, code: rawCode.trim(), message: "That code isn't valid." };
    if (promo.expiresAt && promo.expiresAt.getTime() <= Date.now()) return { ok: false, code, message: `${code} has expired.` };
    if (promo.currency !== packPrice.currency) return { ok: false, code, message: `${code} can't be used with this price.` };
    const discountMinor = Math.min(promo.discountMinor, packPrice.amountMinor);
    const left = packPrice.amountMinor - discountMinor;
    // Stripe won't take less than its minimum; 0 is fine (it settles without Stripe).
    const { minMinor } = CLIENT_CURRENCIES[currencyOf(packPrice.currency)];
    if (left > 0 && left < minMinor) return { ok: false, code, message: `${code} can't be used with this pack. Choose a larger one.` };
    if (promo.firstTopUpOnly && (await ClientPaymentRepo.hasPaidTopUp(userId))) {
      return { ok: false, code, message: `${code} only applies to your first top-up.` };
    }
    if (promo.oncePerClient && (await ClientPaymentRepo.countPromoRedemptions(tenantId, code, userId)) > 0) {
      return { ok: false, code, message: `You've already used ${code}.` };
    }
    if (promo.maxRedemptions !== null && (await ClientPaymentRepo.countPromoRedemptions(tenantId, code)) >= promo.maxRedemptions) {
      return { ok: false, code, message: `${code} has been fully used.` };
    }
    return { ok: true, promo, discountMinor };
  }

  /** The admin Settings page: each tenant's new-case credits, every pack (inactive ones too) and every
   * promo with how often it's been used, plus the currencies a price can be in. */
  static async listForAdmin() {
    const [tenants, rows, promos] = await Promise.all([TenantRepo.listAll(), ClientPricingRepo.listAllPrices(), ClientPricingRepo.listAllPromos()]);
    const redemptions = await Promise.all(promos.map((p) => ClientPaymentRepo.countPromoRedemptions(p.tenantId, p.code)));
    const withUses = promos.map((p, i) => ({ ...p, redemptions: redemptions[i] }));
    return {
      currencies: CLIENT_CURRENCY_CODES.map((code) => ({ code, ...CLIENT_CURRENCIES[code] })),
      tenants: tenants.map((tenant) => ({
        code: tenant.code as TenantCode,
        name: tenant.name,
        case: rows.find((r) => r.tenantId === tenant.id && r.planType === "B2C_CASE") ?? null,
        packs: rows.filter((r) => r.tenantId === tenant.id && r.planType === "B2C_TOP_UP"),
        promos: withUses.filter((p) => p.tenantId === tenant.id),
      })),
    };
  }

  /** The chat credits a new case starts with. Cases are free, so there's no price to set. */
  static async updateCase(tenantCode: TenantCode, input: CasePriceInput, adminId: string) {
    const tenantId = await tenantIdOf(tenantCode);
    const before = (await ClientPricingRepo.listPrices(tenantId)).find((r) => r.planType === "B2C_CASE");
    if (!before) throw new HttpError(`${tenantCode} has no new-case credits set up`, 500, "CLIENT_PRICING_MISSING");
    assertCredits(input.credits);

    const row = await ClientPricingRepo.updatePrice(before.id, { credits: input.credits }, adminId);
    await ClientPricingSvc.changed(tenantId, "admin.settings.client_price_changed", adminId, "client_price", `${tenantCode}:case`, {
      from: { credits: before.credits },
      to: { credits: row.credits },
    });
    return row;
  }

  static async createPack(tenantCode: TenantCode, input: NewPackInput, adminId: string) {
    const tenantId = await tenantIdOf(tenantCode);
    const code = input.code.trim().toLowerCase();
    if (!PACK_CODE.test(code)) throw new HttpError("A pack code is lowercase letters, digits, - or _, up to 32", 400);
    if (!input.name.trim()) throw new HttpError("A pack needs a name", 400);
    const currency = currencyOf(input.currency);
    assertPrice(input.priceMinor, currency, "The pack price");
    assertCredits(input.credits);

    let pack: PaymentPlan;
    try {
      pack = await ClientPricingRepo.createPack(tenantId, {
        code,
        name: input.name.trim(),
        priceMinor: input.priceMinor,
        credits: input.credits,
        currency,
        level: (await ClientPricingRepo.maxPackLevel(tenantId)) + 1,
        updatedById: adminId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(`${tenantCode} already has a pack with code "${code}"`, 409);
      throw err;
    }
    await ClientPricingSvc.changed(tenantId, "admin.settings.client_price_created", adminId, "client_price", `${tenantCode}:${code}`, {
      to: { ...input, code, currency },
    });
    return pack;
  }

  /** Edit, reorder (`level`) or turn a pack on or off. The default pack can't be turned off: make
   * another one the default first. */
  static async updatePack(id: string, patch: ClientPricePatch, adminId: string) {
    const before = await ClientPricingRepo.findPrice(id);
    if (!before || before.planType !== "B2C_TOP_UP") throw new HttpError("Unknown top-up pack", 404);
    if (patch.isActive === false && before.isDefault) {
      throw new HttpError("This is the default pack. Make another pack the default before turning it off.", 409, "DEFAULT_PACK_REQUIRED");
    }
    if (patch.name !== undefined && !patch.name.trim()) throw new HttpError("A pack needs a name", 400);
    const currency = currencyOf(patch.currency ?? before.currency ?? "USD");
    assertPrice(patch.priceMinor ?? before.priceMinor ?? 0, currency, "The pack price");
    if (patch.credits !== undefined) assertCredits(patch.credits);

    const row = await ClientPricingRepo.updatePrice(id, { ...patch, name: patch.name?.trim(), currency }, adminId);
    await ClientPricingSvc.changed(before.tenantId, "admin.settings.client_price_changed", adminId, "client_price", `${before.tenant.code}:${before.code}`, {
      from: { name: before.name, priceMinor: before.priceMinor, credits: before.credits, currency: before.currency, level: before.level, isActive: before.isActive },
      to: patch,
    });
    return row;
  }

  static async setDefaultPack(id: string, adminId: string) {
    const pack = await ClientPricingRepo.findPrice(id);
    if (!pack || pack.planType !== "B2C_TOP_UP") throw new HttpError("Unknown top-up pack", 404);
    if (!pack.isActive) throw new HttpError("Turn the pack on before making it the default", 409);
    await ClientPricingRepo.setDefaultPack(pack.tenantId, id, adminId);
    await ClientPricingSvc.changed(pack.tenantId, "admin.settings.client_price_changed", adminId, "client_price", `${pack.tenant.code}:${pack.code}`, {
      to: { isDefault: true },
    });
  }

  static async createPromo(tenantCode: TenantCode, input: NewPromoInput, adminId: string) {
    const tenantId = await tenantIdOf(tenantCode);
    const code = input.code.trim().toUpperCase();
    if (!PROMO_CODE.test(code)) throw new HttpError("A promo code is 3 to 32 letters, digits, - or _", 400);
    const data: ClientPromoData = {
      description: input.description.trim(),
      discountMinor: input.discountMinor,
      currency: input.currency,
      firstTopUpOnly: input.firstTopUpOnly,
      oncePerClient: input.oncePerClient,
      expiresAt: input.expiresAt ?? null,
      maxRedemptions: input.maxRedemptions,
      isActive: input.isActive ?? true,
    };
    ClientPricingSvc.assertPromo(data);
    data.currency = currencyOf(data.currency);

    let promo: ClientPromo;
    try {
      promo = await ClientPricingRepo.createPromo(tenantId, code, data, adminId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(`${tenantCode} already has the code ${code}`, 409);
      throw err;
    }
    await ClientPricingSvc.changed(tenantId, "admin.settings.client_promo_created", adminId, "client_promo", `${tenantCode}:${code}`, { to: data });
    return promo;
  }

  /** Promos are never deleted (past payments name them): turn one off with isActive. */
  static async updatePromo(id: string, patch: Partial<ClientPromoData>, adminId: string) {
    const before = await ClientPricingRepo.findPromo(id);
    if (!before) throw new HttpError("Unknown promo code", 404);
    ClientPricingSvc.assertPromo({ ...before, ...patch });

    const promo = await ClientPricingRepo.updatePromo(
      id,
      { ...patch, currency: patch.currency === undefined ? undefined : currencyOf(patch.currency), description: patch.description?.trim() },
      adminId,
    );
    await ClientPricingSvc.changed(before.tenantId, "admin.settings.client_promo_changed", adminId, "client_promo", `${before.tenant.code}:${before.code}`, {
      from: {
        description: before.description,
        discountMinor: before.discountMinor,
        currency: before.currency,
        firstTopUpOnly: before.firstTopUpOnly,
        oncePerClient: before.oncePerClient,
        expiresAt: before.expiresAt,
        maxRedemptions: before.maxRedemptions,
        isActive: before.isActive,
      },
      to: patch,
    });
    return promo;
  }

  private static assertPromo(p: ClientPromoData) {
    const currency = currencyOf(p.currency);
    if (!p.description.trim()) throw new HttpError("A promo needs a description", 400);
    if (!Number.isInteger(p.discountMinor) || p.discountMinor < 1 || p.discountMinor > CLIENT_CURRENCIES[currency].maxMinor) {
      throw new HttpError("The discount must be a whole amount above 0", 400, "PRICE_OUT_OF_RANGE");
    }
    if (p.maxRedemptions !== null && (!Number.isInteger(p.maxRedemptions) || p.maxRedemptions < 1)) {
      throw new HttpError("Max redemptions must be a whole number of at least 1, or empty for no limit", 400);
    }
  }

  /** `targetId` is "<tenant>:<code>", e.g. "UK:case", "UK:p100", "UK:WELCOME5". */
  private static async changed(tenantId: string, action: AuditAction, adminId: string, targetType: "client_price" | "client_promo", targetId: string, payload: Record<string, unknown>) {
    await redis.del(clientPricingCacheKey(tenantId));
    await SecurityAuditSvc.record({ action, actorId: adminId, organizationId: null, targetType, targetId, payload });
  }
}
