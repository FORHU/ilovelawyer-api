import { Request, Response } from "express";
import AdminSvc from "../services/admin.service";
import LawSvc, { parseLawCategory } from "../services/law.service";
import TenantSettingSvc from "../services/tenant-setting.service";
import BulkApprovalRunner from "../queues/bulk-approval.runner";
import HttpError from "../utils/http-error";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import {
  listUsersSchema,
  listAuditEventsSchema,
  denyUserSchema,
  lawSearchSchema,
  listLawsSchema,
  updateTenantSettingsSchema,
  updateUserTenantSchema,
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

    const { page, limit, sortBy, sortDir, q } = value;
    const { data, total } = await AdminSvc.listUsers({ page, limit, sortBy, sortDir, q });

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
    const { data, total } = await AdminSvc.listAuditEvents({ page, limit, sortDir, q, actorId });

    return res.status(200).json({
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
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

  /** GET /api/admin/settings — per-Tenant signup settings, pending backlog and bulk-run progress. */
  static async getSettings(_req: Request, res: Response) {
    const tenants = await TenantSettingSvc.listForAdmin();
    return res.status(200).json({ tenants });
  }

  static async updateTenantSettings(req: Request, res: Response) {
    const code = parseTenantCode(req.params.code);
    const { error, value } = updateTenantSettingsSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const tenant = await TenantSettingSvc.setAutoApprove(code, value.autoApproveSignups, req.user.userId);
    return res.status(200).json(tenant);
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
