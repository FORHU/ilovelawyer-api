import { Request, Response, NextFunction } from "express";
import { OrganizationRole } from "@prisma/client";
import OrganizationSvc from "../services/organization.service";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import { asTenantCode } from "../types/tenant-code";
import type { Workspace } from "../utils/workspace";

const HEADER = "x-organization-id";
/** `X-Organization-Id: user:<id>` names a lawyer's own workspace (it has no organization id). */
const OWN_PREFIX = "user:";

/** A lawyer's own workspace: their work with no organization. Its site is their account's. */
async function ownWorkspace(userId: string, ownerId: string): Promise<Workspace> {
  const site = await OrganizationRepo.findOwnSite(ownerId);
  if (!site) throw new HttpError("Your account has no site (UK or PH). Sign in on uk. or ph.ilovelawyer.com.", 400, "NO_SITE");
  return { organizationId: null, ownerId, userId, role: OrganizationRole.OWNER, tenantCode: asTenantCode(site) };
}

async function firmWorkspace(organizationId: string, userId: string): Promise<Workspace> {
  const membership = await OrganizationSvc.requireMembership(organizationId, userId);
  return { organizationId, ownerId: null, userId, role: membership.role, tenantCode: asTenantCode(membership.organization.tenant.code) };
}

/** Which workspace the header names: none or `user:<self>` is the caller's own; `user:<other>` is
 * another lawyer's own (only a guest may enter it); anything else is a firm. */
function parseHeader(req: Request): { own: string } | { firm: string } {
  const raw = req.headers[HEADER];
  if (raw !== undefined && typeof raw !== "string") throw new HttpError("Send one X-Organization-Id", 400);
  if (!raw) return { own: req.user.userId };
  if (raw.startsWith(OWN_PREFIX)) return { own: raw.slice(OWN_PREFIX.length) };
  return { firm: raw };
}

function setWorkspace(req: Request, ws: Workspace) {
  req.workspace = ws;
}

/**
 * Resolves the workspace for this request from the X-Organization-Id header: a firm, checked
 * against OrganizationMember(organizationId, userId), or with no header the lawyer's own workspace
 * (no organization, see utils/workspace.ts). Not embedded in the JWT: it can change between
 * requests (switching, being removed) without re-authenticating, so it's re-checked every time.
 *
 * Used by resource routes (cases, documents, consultations, bookmarks, events, transcriptions),
 * where the workspace isn't part of the URL. Must run after validSession (needs req.user) and be
 * wrapped in asyncHandler, e.g.:
 *   router.use(validSession, asyncHandler(resolveOrganization));
 */
export default async function resolveOrganization(req: Request, _res: Response, next: NextFunction) {
  const target = parseHeader(req);
  if ("own" in target) {
    if (target.own !== req.user.userId) throw new HttpError("Not your workspace", 403);
    setWorkspace(req, await ownWorkspace(req.user.userId, req.user.userId));
  } else {
    setWorkspace(req, await firmWorkspace(target.firm, req.user.userId));
  }
  next();
}

/**
 * Same resolution for a firm named in the URL — /api/organizations/:id/* routes. Always a firm:
 * an own workspace has no organization to name.
 */
export function resolveOrganizationFromParam(paramName = "id") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const organizationId = req.params[paramName];
    if (!organizationId) throw new HttpError(`Missing :${paramName} route param`, 400);
    setWorkspace(req, await firmWorkspace(organizationId, req.user.userId));
    next();
  };
}

/** The writes a guest may still make: they only touch the guest's own state — which layout tab
 * they last had open, and when they last opened the case. Matched against the full mounted path. */
const GUEST_WRITES: RegExp[] = [/^\/api(\/v1)?\/terminal\/workspaces\/[^/]+\/apply$/, /^\/api(\/v1)?\/my-cases\/[^/]+\/opened$/];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * resolveOrganization for the routers a read-only share reaches (cases, the Terminal, a case's
 * documents and transcriptions). A member, or the owner of an own workspace, resolves exactly as
 * there. Someone else is let in as a guest when they hold a share of one of its cases: another
 * lawyer's own workspace (`user:<id>`), or a client-era personal workspace (a portfolio). The
 * usual case access rules (CaseAccess.visibleWhere) then show them only the shared cases. A share
 * is read-only, so a guest can only read: every other write is refused here, for every route on
 * these routers, including ones added later. Every other router uses resolveOrganization and
 * refuses guests outright.
 */
export async function resolveOrganizationAllowingGuests(req: Request, res: Response, next: NextFunction) {
  const target = parseHeader(req);

  if ("own" in target) {
    if (target.own === req.user.userId) {
      setWorkspace(req, await ownWorkspace(req.user.userId, req.user.userId));
      return next();
    }
    if (!(await OrganizationRepo.holdsShareInOwnWorkspace(target.own, req.user.userId))) throw new HttpError("Not your workspace", 403);
    const ws = await ownWorkspace(req.user.userId, target.own);
    setWorkspace(req, { ...ws, role: OrganizationRole.MEMBER, guest: true });
  } else {
    try {
      setWorkspace(req, await firmWorkspace(target.firm, req.user.userId));
      return next();
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 403) throw error;
      const portfolio = await OrganizationRepo.findSharedPortfolio(target.firm, req.user.userId);
      if (!portfolio) throw error;
      setWorkspace(req, {
        organizationId: target.firm,
        ownerId: null,
        userId: req.user.userId,
        role: OrganizationRole.MEMBER,
        tenantCode: asTenantCode(portfolio.tenant.code),
        guest: true,
      });
    }
  }

  const path = `${req.baseUrl}${req.path}`.replace(/\/$/, "");
  if (!READ_METHODS.has(req.method) && !GUEST_WRITES.some((pattern) => pattern.test(path))) {
    throw new HttpError("This case was shared with you to read only", 403, "SHARE_READ_ONLY");
  }
  next();
}
