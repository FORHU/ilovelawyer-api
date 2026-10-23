import { Request } from "express";
import { OrganizationRole } from "@prisma/client";
import { TenantCode } from "../types/tenant-code";
import HttpError from "./http-error";

/**
 * Where a request works: a firm the caller belongs to, or a lawyer's own workspace, which has no
 * organization (see docs/adr/0022-solo-lawyers-without-an-organization.md). Resolved once per
 * request by resolve-organization.middleware and read through workspaceOf().
 *
 * Every query on workspace data filters through scopeWhere(), never by organizationId alone: in an
 * own workspace organizationId is null, and `{ organizationId: null }` on its own would match
 * every lawyer's own work.
 */
export interface Workspace {
  /** The firm, or null in a lawyer's own workspace. */
  organizationId: string | null;
  /** Whose own work this is (the caller, or for a guest the lawyer who shared a case). Null in a
   * firm workspace. */
  ownerId: string | null;
  /** The caller. */
  userId: string;
  /** The caller's role in the firm. OWNER in their own workspace; MEMBER for a guest. */
  role: OrganizationRole;
  /** The firm's site, or for an own workspace its owner's. */
  tenantCode: TenantCode;
  /** The caller isn't a member: they reached this workspace through a read-only share of one of
   * its cases (resolveOrganizationAllowingGuests). */
  guest?: boolean;
}

/** A Workspace's identity, all that scopeWhere() and the services need. */
export type WorkspaceScope = Pick<Workspace, "organizationId" | "ownerId">;

/** The filter for workspace data: a firm's rows, or the owner's rows that have no organization. */
export function scopeWhere(scope: WorkspaceScope): { organizationId: string } | { organizationId: null; userId: string } {
  if (scope.organizationId) return { organizationId: scope.organizationId };
  if (!scope.ownerId) throw new Error("An own workspace needs its owner");
  return { organizationId: null, userId: scope.ownerId };
}

/** The organizationId a new row in this workspace gets: the firm, or null. */
export function organizationIdOf(scope: WorkspaceScope): string | null {
  return scope.organizationId;
}

export function firmScope(organizationId: string): WorkspaceScope {
  return { organizationId, ownerId: null };
}

export function ownScope(ownerId: string): WorkspaceScope {
  return { organizationId: null, ownerId };
}

/** No account has this id, so a scope owned by it matches nothing. */
const NO_OWNER = "00000000-0000-0000-0000-000000000000";

/** The workspace a case lives in: its firm, or for an org-less case its creator's own. An
 * org-less case whose creator's account is gone belongs to no one, so its scope matches nothing. */
export function caseScope(c: { organizationId: string | null; userId: string | null }): WorkspaceScope {
  return c.organizationId ? firmScope(c.organizationId) : ownScope(c.userId ?? NO_OWNER);
}

/** The resolved workspace. Routes must run resolveOrganization (or a sibling) first. */
export function workspaceOf(req: Request): Workspace {
  if (!req.workspace) throw new HttpError("Workspace not resolved — route must run resolveOrganization first", 500);
  return req.workspace;
}

/** For firm-only features (members, invites, the firm's card and audit log): the firm's id, or
 * 400 in an own workspace. */
export function firmIdOf(req: Request): string {
  const ws = workspaceOf(req);
  if (!ws.organizationId) throw new HttpError("This needs a firm. Create or join one from the Organization page.", 400, "FIRM_REQUIRED");
  return ws.organizationId;
}
