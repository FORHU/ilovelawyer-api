import { Request } from "express";
import { OrganizationRole } from "@prisma/client";
import { TenantCode } from "../types/tenant-code";
import HttpError from "./http-error";

export interface TenantContext {
  userId: string;
  /** The firm, or null in a lawyer's own workspace (see utils/workspace.ts). */
  organizationId: string | null;
  role: OrganizationRole;
  tenantCode: TenantCode;
}

/**
 * The trusted, server-resolved identity for the current request: authenticated user -> validated
 * workspace (a firm membership, or the lawyer's own) -> its site's tenant code. Reuses whatever
 * resolve-organization.middleware already validated for this request — it does not re-derive
 * anything from client-supplied headers/body itself. Route handlers must sit behind one of those
 * middlewares before calling this.
 */
export function getTenantContext(req: Request): TenantContext {
  if (!req.workspace) {
    throw new HttpError("Tenant context not resolved — route must run resolveOrganization first", 500);
  }
  return {
    userId: req.user.userId,
    organizationId: req.workspace.organizationId,
    role: req.workspace.role,
    tenantCode: req.workspace.tenantCode,
  };
}
