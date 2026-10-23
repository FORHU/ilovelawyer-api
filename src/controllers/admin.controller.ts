import { Request, Response } from "express";
import AdminSvc from "../services/admin.service";
import LawyerVerificationSvc from "../services/lawyer-verification.service";
import LawSvc, { parseLawCategory } from "../services/law.service";
import TenantSettingSvc from "../services/tenant-setting.service";
import AccountTopUpPricingSvc from "../services/account-topup-pricing.service";
import PaymentPlanSvc from "../services/payment-plan.service";
import TenantRepo from "../repositories/tenant.repository";
import BulkApprovalRunner from "../queues/bulk-approval.runner";
import SecurityAuditSvc from "../services/security-audit.service";
import HttpError from "../utils/http-error";
import { sendExportZip, exportAuditPayload } from "../utils/export-response";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import {
  listUsersSchema,
  listAuditEventsSchema,
  listFeedbackSchema,
  exportUserDataSchema,
  denyUserSchema,
  listLawyerVerificationsSchema,
  verifyLawyerSchema,
  rejectLawyerSchema,
  lawSearchSchema,
  listLawsSchema,
  updateTenantSettingsSchema,
  updateUserTenantSchema,
  createPaymentPlanSchema,
  updatePaymentPlanSchema,
} from "../validation/admin.validation";

function parseTenantCode(raw: string): TenantCode {
  try {
    return asTenantCode(raw);
  } catch {
    throw new HttpError(`Unknown tenant ${raw}`, 404);
  }
}

export default class AdminCtrl {
  static async listUsers(req: Request, res: Response) {
    const { error, value } = listUsersSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { page, limit, sortBy, sortDir, q, role } = value;
    const { data, total } = await AdminSvc.listUsers({ page, limit, sortBy, sortDir, q, role });

    return res.status(200).json({
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }

  /** GET /api/admin/audit-events — the audit trail, newest first. */
  static async listAuditEvents(req: Request, res: Response) {
    const { error, value } = listAuditEventsSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { page, limit, sortDir, q, actorId } = value;
    const { data, total, resolved } = await AdminSvc.listAuditEvents({ page, limit, sortDir, q, actorId });

    return res.status(200).json({
      data,
      resolved,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }

  /** GET /api/admin/feedback — what testers sent from inside the app, newest first. */
  static async listFeedback(req: Request, res: Response) {
    const { error, value } = listFeedbackSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { page, limit, sortDir, q, source, rating } = value;
    const { data, total, resolved } = await AdminSvc.listFeedback({ page, limit, sortDir, q, source, rating });

    return res.status(200).json({
      data,
      resolved,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }

  /** POST /api/admin/users/:id/export — the same ZIP the user can download for themselves, produced
   * by an admin who has verified the requester's identity (for requests that arrive by email, or
   * from someone who can't sign in). Recorded separately from a self-service export, with the
   * admin as the actor and the person whose data it was in the payload. */
  static async exportUserData(req: Request, res: Response) {
    const { error } = exportUserDataSchema.validate({ identityVerified: req.body?.identityVerified });
    if (error) throw new HttpError(error.message, 400);
    await AdminSvc.assertExportable(req.params.id);

    const result = await sendExportZip(res, req.params.id);
    if (result) {
      await SecurityAuditSvc.record({
        action: "export.user_data",
        actorId: req.user.userId,
        targetType: "user",
        targetId: req.params.id,
        payload: exportAuditPayload(result),
      });
    }
  }

  static async approveUser(req: Request, res: Response) {
    const user = await AdminSvc.approve(req.params.id);
    return res.status(200).json(user);
  }

  static async denyUser(req: Request, res: Response) {
    const { error, value } = denyUserSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const user = await AdminSvc.deny(req.params.id, value.reason || undefined);
    return res.status(200).json(user);
  }

  static async reactivateUser(req: Request, res: Response) {
    const user = await AdminSvc.reactivate(req.params.id);
    return res.status(200).json(user);
  }

  static async blockUser(req: Request, res: Response) {
    const user = await AdminSvc.block(req.params.id);
    return res.status(200).json(user);
  }

  static async unblockUser(req: Request, res: Response) {
    const user = await AdminSvc.unblock(req.params.id);
    return res.status(200).json(user);
  }

  /** POST /api/admin/users/:id/verify-email — marks the email verified, bypassing the signup OTP. */
  static async verifyUserEmail(req: Request, res: Response) {
    const user = await AdminSvc.verifyEmail(req.params.id, req.user.userId);
    return res.status(200).json(user);
  }

  /** PATCH /api/admin/users/:id/tenant — body { tenantCode: "PH" | "UK" }. */
  static async changeUserTenant(req: Request, res: Response) {
    const { error, value } = updateUserTenantSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const user = await AdminSvc.changeTenant(req.params.id, value.tenantCode, req.user.userId);
    return res.status(200).json(user);
  }

  /** DELETE /api/admin/users/:id — immediate, permanent hard delete. */
  static async deleteUser(req: Request, res: Response) {
    await AdminSvc.deleteUser(req.params.id, req.user.userId);
    return res.status(204).send();
  }

  /** GET /api/admin/lawyer-verifications — the Lawyer Application queue for one site (default UK)
   * and status (default PENDING), oldest submission first. */
  static async listLawyerVerifications(req: Request, res: Response) {
    const { error, value } = listLawyerVerificationsSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { site, status, page, limit } = value;
    const { data, total } = await LawyerVerificationSvc.list({ country: site, status, page, limit });

    return res.status(200).json({
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }

  /** POST /api/admin/lawyer-verifications/:userId/verify — body { confirmedJurisdictions?, note? }
   * (jurisdictions for UK only). The admin approves a PENDING application on trust (no register
   * check yet, #506). */
  static async verifyLawyer(req: Request, res: Response) {
    const { error, value } = verifyLawyerSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const row = await LawyerVerificationSvc.verify(
      req.params.userId,
      { confirmedJurisdictions: value.confirmedJurisdictions, note: value.note || undefined },
      req.user.userId
    );
    return res.status(200).json(row);
  }

  /** POST /api/admin/lawyer-verifications/:userId/reject — body { reason, note? }; note required
   * only for OTHER. */
  static async rejectLawyer(req: Request, res: Response) {
    const { error, value } = rejectLawyerSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const row = await LawyerVerificationSvc.reject(req.params.userId, value.reason, value.note || undefined, req.user.userId);
    return res.status(200).json(row);
  }

  /** GET /api/admin/settings — per-Tenant signup settings, pending backlog, bulk-run progress, the
   * account top-up platform fee, and each tenant's B2B subscription tiers (Standard/Pro/Max). */
  static async getSettings(_req: Request, res: Response) {
    const [tenants, topUpPricing, paymentPlans] = await Promise.all([
      TenantSettingSvc.listForAdmin(),
      AccountTopUpPricingSvc.listForAdmin(),
      PaymentPlanSvc.listForAdmin(),
    ]);
    const merged = tenants.map((t) => ({
      ...t,
      accountTopUp: topUpPricing.find((p) => p.code === t.code) ?? null,
      paymentPlans: paymentPlans.find((p) => p.code === t.code)?.paymentPlans ?? [],
    }));
    return res.status(200).json({ tenants: merged });
  }

  static async updateTenantSettings(req: Request, res: Response) {
    const code = parseTenantCode(req.params.code);
    const { error, value } = updateTenantSettingsSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    let tenant;
    if (value.autoApproveSignups !== undefined) tenant = await TenantSettingSvc.setAutoApprove(code, value.autoApproveSignups, req.user.userId);
    if (value.accountTopUpFeeType !== undefined) {
      await AccountTopUpPricingSvc.setFee(code, value.accountTopUpFeeType, value.accountTopUpFeeAmount, req.user.userId);
    }
    if (!tenant) tenant = (await TenantSettingSvc.listForAdmin()).find((t) => t.code === code);
    const accountTopUp = await AccountTopUpPricingSvc.listForAdmin().then((all) => all.find((p) => p.code === code));
    return res.status(200).json({ ...tenant, accountTopUp });
  }

  /** GET /api/admin/settings/tenants/:code/payment-plans — one tenant's B2B subscription tiers. */
  static async listPaymentPlans(req: Request, res: Response) {
    const code = parseTenantCode(req.params.code);
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);
    const plans = await PaymentPlanSvc.listForTenant(tenant.id);
    return res.status(200).json({ paymentPlans: plans });
  }

  /** POST /api/admin/settings/tenants/:code/payment-plans — add a new tier. */
  static async createPaymentPlan(req: Request, res: Response) {
    const code = parseTenantCode(req.params.code);
    const { error, value } = createPaymentPlanSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    const plan = await PaymentPlanSvc.create(code, value, req.user.userId);
    return res.status(201).json(plan);
  }

  /** PATCH /api/admin/settings/tenants/:code/payment-plans/:planId — edit or (re)activate a tier. */
  static async updatePaymentPlan(req: Request, res: Response) {
    const { error, value } = updatePaymentPlanSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    const { isActive, ...patch } = value;
    let plan = Object.keys(patch).length ? await PaymentPlanSvc.update(req.params.planId, patch, req.user.userId) : undefined;
    if (isActive !== undefined) plan = await PaymentPlanSvc.setActive(req.params.planId, isActive, req.user.userId);
    return res.status(200).json(plan);
  }

  /** DELETE /api/admin/settings/tenants/:code/payment-plans/:planId — soft-disable only; a tier is
   * never hard-deleted, so lawyers already on it keep working. */
  static async deactivatePaymentPlan(req: Request, res: Response) {
    const plan = await PaymentPlanSvc.setActive(req.params.planId, false, req.user.userId);
    return res.status(200).json(plan);
  }

  /** POST /api/admin/tenants/:code/approve-pending — starts a background run; poll GET /settings. */
  static async approvePending(req: Request, res: Response) {
    const code = parseTenantCode(req.params.code);
    const result = await BulkApprovalRunner.start(code, req.user.userId);
    return res.status(202).json(result);
  }

  /** GET /api/admin/law/search — proxy juris.ph, store any new hits, return them annotated. */
  static async searchLaw(req: Request, res: Response) {
    const { error, value } = lawSearchSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.search({
      category: parseLawCategory(value.category),
      q: value.q,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /** GET /api/admin/law — the laws already saved in our own database (no juris.ph call). */
  static async listLaw(req: Request, res: Response) {
    const { error, value } = listLawsSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.list({
      category: value.category ? parseLawCategory(value.category) : undefined,
      q: value.q,
      page: value.page,
      limit: value.limit,
      sortBy: value.sortBy,
      sortDir: value.sortDir,
    });
    return res.status(200).json(result);
  }
}
