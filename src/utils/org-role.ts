import { NextFunction, Request, Response } from "express";
import { OrganizationRole } from "@prisma/client";
import HttpError from "./http-error";

const ROLE_RANK: Record<OrganizationRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  MEMBER: 1,
};

export function hasOrgRole(role: OrganizationRole, minRole: OrganizationRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Route guard for organizational actions (invite, role change, member removal).
 * Must run after resolveOrganization — reads req.organization.role, not the caller's
 * global User.role, since permissions here are scoped to the active org.
 */
export function requireOrgRole(minRole: OrganizationRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.organization) return next(new HttpError("Organization context missing", 400));
    if (!hasOrgRole(req.organization.role, minRole)) {
      return next(new HttpError("Insufficient organization role", 403));
    }
    next();
  };
}
