import { Request, Response } from "express";
import Joi from "joi";
import SecurityAuditSvc from "../services/security-audit.service";
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

type QueryFilter = Omit<SecurityAuditFilter, "organizationId"> & { organizationId?: string; limit?: number; cursor?: string };

function toFilter(query: QueryFilter, organizationId: SecurityAuditFilter["organizationId"]): SecurityAuditFilter {
  const { actorId, caseId, action, outcome, from, to } = query;
  return { organizationId, actorId, caseId, action, outcome, from, to };
}

function sendCsv(res: Response, csv: string, name: string) {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${date}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(csv);
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
    const result = await SecurityAuditSvc.list(toFilter(query, req.organization!.id), query.limit!, query.cursor);
    return res.status(200).json(result);
  }

  /** GET /api/organizations/:id/audit-log/export — the same, as CSV. */
  static async exportForOrganization(req: Request, res: Response) {
    const query = validate<QueryFilter>(securityAuditExportSchema, req.query);
    const { csv } = await SecurityAuditSvc.exportCsv(toFilter(query, req.organization!.id));
    return sendCsv(res, csv, "audit-log");
  }

  /** GET /api/admin/audit-log — every organization's events plus those outside any, for
   * platform admins (ilovelawyer-admin). */
  static async listForAdmin(req: Request, res: Response) {
    const query = validate<QueryFilter>(adminSecurityAuditListSchema, req.query);
    const filter = toFilter(query, adminOrganizationFilter(query.organizationId));
    const result = await SecurityAuditSvc.list(filter, query.limit!, query.cursor);
    return res.status(200).json(result);
  }

  static async exportForAdmin(req: Request, res: Response) {
    const query = validate<QueryFilter>(adminSecurityAuditExportSchema, req.query);
    const { csv } = await SecurityAuditSvc.exportCsv(toFilter(query, adminOrganizationFilter(query.organizationId)));
    return sendCsv(res, csv, "platform-audit-log");
  }
}
