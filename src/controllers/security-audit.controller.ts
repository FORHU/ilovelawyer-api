import { Request, Response } from "express";
import Joi from "joi";
import SecurityAuditSvc from "../services/security-audit.service";
import OrganizationRepo from "../repositories/organization.repository";
import { SecurityAuditFilter } from "../repositories/security-audit.repository";
import {
  adminSecurityAuditExportSchema,
  adminSecurityAuditListSchema,
  securityAuditExportSchema,
  securityAuditListSchema,
} from "../validation/security-audit.validation";
import HttpError from "../utils/http-error";

function validate<T>(schema: Joi.ObjectSchema, query: unknown): T {
  const { error, value } = schema.validate(query ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

type QueryFilter = Omit<SecurityAuditFilter, "organizationId"> & { organizationId?: string; page?: number; limit?: number };

function toFilter(query: QueryFilter, organizationId: SecurityAuditFilter["organizationId"]): SecurityAuditFilter {
  const { actorId, caseId, action, outcome, from, to, sort, order } = query;
  return { organizationId, actorId, caseId, action, outcome, from, to, sort, order };
}

function sendPdf(res: Response, pdf: Buffer, name: string) {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${date}.pdf"`);
  // The app reads the filename from here; it's a cross-origin call, so the header has to be exposed.
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(pdf);
}

/** "none" = events that belong to no organization; absent = every organization. */
function adminOrganizationFilter(organizationId: string | undefined): SecurityAuditFilter["organizationId"] {
  if (organizationId === undefined) return undefined;
  return organizationId === "none" ? null : organizationId;
}

export default class SecurityAuditCtrl {
  /** GET /api/organizations/:id/audit-log — the firm's own security audit log, for its Owners
   * and Admins (requireOrgRole in the route). Scoped to req.organization, never a client value. */
  static async listForOrganization(req: Request, res: Response) {
    const query = validate<QueryFilter>(securityAuditListSchema, req.query);
    const result = await SecurityAuditSvc.list(toFilter(query, req.organization!.id), query.page!, query.limit!);
    return res.status(200).json(result);
  }

  /** GET /api/organizations/:id/audit-log/export — the same filters, as a PDF table. */
  static async exportForOrganization(req: Request, res: Response) {
    const query = validate<QueryFilter>(securityAuditExportSchema, req.query);
    const organization = await OrganizationRepo.findById(req.organization!.id);
    const { pdf } = await SecurityAuditSvc.exportPdf(toFilter(query, req.organization!.id), organization?.name ?? "Organization");
    return sendPdf(res, pdf, "audit-log");
  }

  /** GET /api/admin/audit-log — every organization's events plus those outside any, for
   * platform admins (ilovelawyer-admin). */
  static async listForAdmin(req: Request, res: Response) {
    const query = validate<QueryFilter>(adminSecurityAuditListSchema, req.query);
    const filter = toFilter(query, adminOrganizationFilter(query.organizationId));
    const result = await SecurityAuditSvc.list(filter, query.page!, query.limit!);
    return res.status(200).json(result);
  }

  static async exportForAdmin(req: Request, res: Response) {
    const query = validate<QueryFilter>(adminSecurityAuditExportSchema, req.query);
    const organizationId = adminOrganizationFilter(query.organizationId);
    const scope =
      organizationId === undefined
        ? "All organizations"
        : organizationId === null
          ? "Events outside any organization"
          : ((await OrganizationRepo.findById(organizationId))?.name ?? `Organization ${organizationId}`);
    const { pdf } = await SecurityAuditSvc.exportPdf(toFilter(query, organizationId), scope);
    return sendPdf(res, pdf, "platform-audit-log");
  }
}
