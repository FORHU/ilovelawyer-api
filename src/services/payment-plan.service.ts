import { PaymentPlan, PaymentPlanType, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import TenantRepo from "../repositories/tenant.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { TenantCode } from "../types/tenant-code";

export interface PaymentPlanInput {
  code: string;
  name: string;
  level?: number;
  feeUsd: number;
  includedAllowanceUsd: number;
  caseLimit: number;
}

export type PaymentPlanPatch = Partial<PaymentPlanInput>;

function validateNumbers(input: { feeUsd?: number; includedAllowanceUsd?: number; caseLimit?: number }) {
  if (input.feeUsd !== undefined && input.feeUsd < 0) throw new HttpError("Fee can't be negative", 400);
  if (input.includedAllowanceUsd !== undefined && input.includedAllowanceUsd < 0) throw new HttpError("Included AI allowance can't be negative", 400);
  if (input.caseLimit !== undefined && (!Number.isInteger(input.caseLimit) || input.caseLimit < 0)) {
    throw new HttpError("Case limit must be a non-negative whole number", 400);
  }
}

/**
 * Admin-editable B2B subscription tiers (Standard/Pro/Max are placeholders), one row per
 * (tenant, planType, code). Real columns on a dedicated table rather than a TenantSetting Json
 * blob, so a User can hold a real FK (User.paymentPlanId) and admin CRUD doesn't need to
 * hand-roll ids/ordering inside an array — see docs handoff for the full rationale.
 *
 * Tiers are never hard-deleted (setActive only): a lawyer's User.paymentPlanId and every
 * PaymentPlanSubscription row must stay valid even after a tier is retired from new signups.
 */
export default class PaymentPlanSvc {
  static async listForTenant(tenantId: string, planType: PaymentPlanType = "B2B_SUBSCRIPTION"): Promise<PaymentPlan[]> {
    return prisma.paymentPlan.findMany({ where: { tenantId, planType }, orderBy: { level: "asc" } });
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
    return tenants.map((tenant) => ({
      code: tenant.code as TenantCode,
      name: tenant.name,
      paymentPlans: plans.filter((p) => p.tenantId === tenant.id),
    }));
  }

  static async create(code: TenantCode, input: PaymentPlanInput, adminId: string): Promise<PaymentPlan> {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    if (!input.code.trim() || !input.name.trim()) throw new HttpError("Code and name are required", 400);
    validateNumbers(input);

    let plan: PaymentPlan;
    try {
      plan = await prisma.paymentPlan.create({
        data: {
          tenantId: tenant.id,
          planType: "B2B_SUBSCRIPTION",
          code: input.code.trim(),
          name: input.name.trim(),
          level: input.level ?? 0,
          feeUsd: input.feeUsd,
          includedAllowanceUsd: input.includedAllowanceUsd,
          caseLimit: input.caseLimit,
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
      payload: { planId: plan.id, ...input },
    });
    return plan;
  }

  static async update(planId: string, patch: PaymentPlanPatch, adminId: string): Promise<PaymentPlan> {
    const before = await prisma.paymentPlan.findUnique({ where: { id: planId }, include: { tenant: { select: { code: true } } } });
    if (!before) throw new HttpError("Unknown subscription tier", 404);
    validateNumbers(patch);

    const plan = await prisma.paymentPlan.update({
      where: { id: planId },
      data: {
        code: patch.code?.trim(),
        name: patch.name?.trim(),
        level: patch.level,
        feeUsd: patch.feeUsd,
        includedAllowanceUsd: patch.includedAllowanceUsd,
        caseLimit: patch.caseLimit,
        updatedById: adminId,
      },
    });

    await SecurityAuditSvc.record({
      action: "admin.settings.payment_plan_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: before.tenant.code,
      payload: { planId, from: before, to: patch },
    });
    return plan;
  }

  /** Soft-disable/re-enable only — hides a tier from new signups/upgrades without ever deleting
   * the row, so existing lawyers on it (User.paymentPlanId) and their PaymentPlanSubscription rows
   * stay valid. */
  static async setActive(planId: string, isActive: boolean, adminId: string): Promise<PaymentPlan> {
    const before = await prisma.paymentPlan.findUnique({ where: { id: planId }, include: { tenant: { select: { code: true } } } });
    if (!before) throw new HttpError("Unknown subscription tier", 404);

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
