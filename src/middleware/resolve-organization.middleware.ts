import { Request, Response, NextFunction } from "express";
import OrganizationSvc from "../services/organization.service";
import HttpError from "../utils/http-error";
import { asTenantCode } from "../types/tenant-code";

const HEADER = "x-organization-id";

/**
 * Resolves the active organization for this request from the X-Organization-Id header
 * against OrganizationMember(organizationId, userId). Active org is deliberately not
 * embedded in the JWT — it can change between requests (switching orgs, being removed)
 * without forcing re-authentication, so it's re-checked against the DB every time.
 *
 * Used by resource routes (cases, documents, consultations, bookmarks, events,
 * transcriptions), where the org isn't part of the URL. Must run after validSession
 * (needs req.user) and be wrapped in asyncHandler, e.g.:
 *   router.use(validSession, asyncHandler(resolveOrganization));
 */
export default async function resolveOrganization(req: Request, _res: Response, next: NextFunction) {
  const organizationId = req.headers[HEADER];
  if (!organizationId || typeof organizationId !== "string") {
    throw new HttpError("X-Organization-Id header is required", 400);
  }

  const membership = await OrganizationSvc.requireMembership(organizationId, req.user.userId);
  req.organization = { id: organizationId, role: membership.role, tenantCode: asTenantCode(membership.organization.tenant.code) };
  next();
}

/**
 * Same resolution as resolveOrganization, but reads the org id from a route param
 * instead of the header — for /api/organizations/:id/* routes, where the org is
 * already named in the URL. Populates req.organization so requireOrgRole works
 * identically for both resolution paths.
 */
export function resolveOrganizationFromParam(paramName = "id") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const organizationId = req.params[paramName];
    if (!organizationId) throw new HttpError(`Missing :${paramName} route param`, 400);

    const membership = await OrganizationSvc.requireMembership(organizationId, req.user.userId);
    req.organization = { id: organizationId, role: membership.role, tenantCode: asTenantCode(membership.organization.tenant.code) };
    next();
  };
}
