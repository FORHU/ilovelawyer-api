import { Request } from "express";
import { OrganizationRole } from "@prisma/client";
import { Jurisdiction } from "../types/jurisdiction";
import HttpError from "./http-error";

export interface TenantContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  jurisdiction: Jurisdiction;
}

/**
 * The trusted, server-resolved identity for the current request: authenticated user ->
 * validated membership -> organization -> organization.jurisdiction. Reuses whatever
 * resolve-organization.middleware (or resolveOrganizationFromParam) already validated against
 * the DB for this request — it does not re-derive anything from client-supplied headers/body
 * itself. Route handlers must sit behind one of those middlewares before calling this.
 */
export function getTenantContext(req: Request): TenantContext {
  if (!req.organization) {
    throw new HttpError("Tenant context not resolved — route must run resolveOrganization first", 500);
  }
  return {
    userId: req.user.userId,
    organizationId: req.organization.id,
    role: req.organization.role,
    jurisdiction: req.organization.jurisdiction,
  };
}
