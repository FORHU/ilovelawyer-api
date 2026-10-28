import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** The client app's price rows: PaymentPlan's B2C plan types (ADR 0017). */
const B2C = { planType: { in: ["B2C_CASE", "B2C_TOP_UP"] } } satisfies Prisma.PaymentPlanWhereInput;

const UPDATED_BY = { updatedBy: { select: { name: true, email: true } } } as const;

export interface NewClientPack {
  code: string;
  name: string;
  priceMinor: number;
  credits: number;
  currency: string;
  level: number;
  updatedById: string;
}

export type ClientPricePatch = Partial<{ name: string; priceMinor: number; credits: number; currency: string; level: number; isActive: boolean }>;

export interface ClientPromoData {
  description: string;
  discountMinor: number;
  currency: string;
  firstTopUpOnly: boolean;
  oncePerClient: boolean;
  expiresAt: Date | null;
  maxRedemptions: number | null;
  isActive: boolean;
}

export default class ClientPricingRepo {
  /** One tenant's case row and every pack, active or not, in display order. */
  static async listPrices(tenantId: string) {
    return prisma.paymentPlan.findMany({ where: { ...B2C, tenantId }, orderBy: [{ planType: "asc" }, { level: "asc" }], include: UPDATED_BY });
  }

  /** Every tenant's rows, for the admin Settings page. */
  static async listAllPrices() {
    return prisma.paymentPlan.findMany({ where: B2C, orderBy: [{ tenantId: "asc" }, { planType: "asc" }, { level: "asc" }], include: UPDATED_BY });
  }

  static async findPrice(id: string) {
    return prisma.paymentPlan.findFirst({ where: { ...B2C, id }, include: { tenant: { select: { code: true } } } });
  }

  static async updatePrice(id: string, patch: ClientPricePatch, updatedById: string) {
    return prisma.paymentPlan.update({ where: { id }, data: { ...patch, updatedById } });
  }

  static async maxPackLevel(tenantId: string): Promise<number> {
    return (await prisma.paymentPlan.aggregate({ where: { tenantId, planType: "B2C_TOP_UP" }, _max: { level: true } }))._max.level ?? -1;
  }

  static async createPack(tenantId: string, data: NewClientPack) {
    return prisma.paymentPlan.create({
      data: { ...data, tenantId, planType: "B2C_TOP_UP", feeUsd: 0, includedAllowanceUsd: 0, caseLimit: 0 },
    });
  }

  /** Makes one pack its tenant's default and every other pack of that tenant not, together. */
  static async setDefaultPack(tenantId: string, id: string, updatedById: string) {
    await prisma.$transaction([
      prisma.paymentPlan.updateMany({ where: { tenantId, planType: "B2C_TOP_UP", isDefault: true, NOT: { id } }, data: { isDefault: false } }),
      prisma.paymentPlan.update({ where: { id }, data: { isDefault: true, updatedById } }),
    ]);
  }

  static async listAllPromos() {
    return prisma.clientPromo.findMany({ orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }], include: UPDATED_BY });
  }

  static async findPromo(id: string) {
    return prisma.clientPromo.findUnique({ where: { id }, include: { tenant: { select: { code: true } } } });
  }

  /** `code` uppercase, as stored. */
  static async findPromoByCode(tenantId: string, code: string) {
    return prisma.clientPromo.findUnique({ where: { tenantId_code: { tenantId, code } } });
  }

  static async createPromo(tenantId: string, code: string, data: ClientPromoData, updatedById: string) {
    return prisma.clientPromo.create({ data: { tenantId, code, ...data, updatedById } });
  }

  static async updatePromo(id: string, patch: Partial<ClientPromoData>, updatedById: string) {
    return prisma.clientPromo.update({ where: { id }, data: { ...patch, updatedById } });
  }
}
