import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** What lawyers pay: PaymentPlan's lawyer price types (#598, LawyerPricingSvc). */
const LAWYER = { planType: { in: ["LAWYER_INTRO_FEE", "LAWYER_AI_TOP_UP"] } } satisfies Prisma.PaymentPlanWhereInput;

const UPDATED_BY = { updatedBy: { select: { name: true, email: true } } } as const;

export interface NewLawyerPack {
  code: string;
  name: string;
  priceMinor: number;
  creditMinor: number;
  currency: string;
  level: number;
  updatedById: string;
}

export type LawyerPricePatch = Partial<{ name: string; priceMinor: number; creditMinor: number; level: number; isActive: boolean }>;

export default class LawyerPricingRepo {
  /** One tenant's fee row and every pack, active or not, in display order. */
  static async listPrices(tenantId: string) {
    return prisma.paymentPlan.findMany({ where: { ...LAWYER, tenantId }, orderBy: [{ planType: "asc" }, { level: "asc" }], include: UPDATED_BY });
  }

  static async listAllPrices() {
    return prisma.paymentPlan.findMany({ where: LAWYER, orderBy: [{ tenantId: "asc" }, { planType: "asc" }, { level: "asc" }], include: UPDATED_BY });
  }

  static async findPrice(id: string) {
    return prisma.paymentPlan.findFirst({ where: { ...LAWYER, id }, include: { tenant: { select: { code: true } } } });
  }

  static async updatePrice(id: string, patch: LawyerPricePatch, adminId: string) {
    return prisma.paymentPlan.update({ where: { id }, data: { ...patch, updatedById: adminId }, include: UPDATED_BY });
  }

  static async createPack(tenantId: string, pack: NewLawyerPack) {
    return prisma.paymentPlan.create({
      data: { tenantId, planType: "LAWYER_AI_TOP_UP", feeUsd: 0, includedAllowanceUsd: 0, caseLimit: 0, ...pack },
      include: UPDATED_BY,
    });
  }

  static async maxPackLevel(tenantId: string): Promise<number> {
    const { _max } = await prisma.paymentPlan.aggregate({ where: { tenantId, planType: "LAWYER_AI_TOP_UP" }, _max: { level: true } });
    return _max.level ?? -1;
  }
}
