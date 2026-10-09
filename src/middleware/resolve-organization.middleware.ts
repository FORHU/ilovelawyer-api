import { Request, Response, NextFunction } from "express";
import { OrganizationRole } from "@prisma/client";
import OrganizationSvc from "../services/organization.service";
import OrganizationRepo from "../repositories/organization.repository";
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

/** The writes a guest may still make: they only touch the guest's own state — which layout tab
 * they last had open, and when they last opened the case. Matched against the full mounted path. */
const GUEST_WRITES: RegExp[] = [/^\/api(\/v1)?\/terminal\/workspaces\/[^/]+\/apply$/, /^\/api(\/v1)?\/my-cases\/[^/]+\/opened$/];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * resolveOrganization for the routers a read-only share reaches (cases, the Terminal, a case's
 * documents and transcriptions). A member resolves exactly as there. Someone who isn't one is let
 * into another user's portfolio as a guest when they hold a share of one of its cases: the usual
 * case access rules (CaseAccess.visibleWhere) then show them only the shared cases. A share is
 * read-only, so a guest can only read: every other write is refused here, for every route on
 * these routers, including ones added later. Every other router uses resolveOrganization and
 * refuses guests outright.
 */
export async function resolveOrganizationAllowingGuests(req: Request, res: Response, next: NextFunction) {
  const organizationId = req.headers[HEADER];
  if (!organizationId || typeof organizationId !== "string") {
    throw new HttpError("X-Organization-Id header is required", 400);
  }

  try {
    const membership = await OrganizationSvc.requireMembership(organizationId, req.user.userId);
    req.organization = { id: organizationId, role: membership.role, tenantCode: asTenantCode(membership.organization.tenant.code) };
    return next();
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 403) throw error;
    const portfolio = await OrganizationRepo.findSharedPortfolio(organizationId, req.user.userId);
    if (!portfolio) throw error;
    req.organization = { id: organizationId, role: OrganizationRole.MEMBER, tenantCode: asTenantCode(portfolio.tenant.code), guest: true };
  }

  const path = `${req.baseUrl}${req.path}`.replace(/\/$/, "");
  if (!READ_METHODS.has(req.method) && !GUEST_WRITES.some((pattern) => pattern.test(path))) {
    throw new HttpError("This case was shared with you to read only", 403, "SHARE_READ_ONLY");
  }
  next();
}
