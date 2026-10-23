import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import ClientCaseSvc, { type ClientWorkspace } from "../services/client-case.service";
import HttpError from "../utils/http-error";

/**
 * For the client app's routes (/api/client). The caller must be a client account (User.role
 * USER), read fresh from the database like requireAdmin rather than trusted from the token. Every
 * request then runs in the client's personal workspace (ClientCaseSvc.workspaceFor), so the
 * client app sends no X-Organization-Id. Must run after validSession and be wrapped in
 * asyncHandler.
 */
/** The client's personal workspace, as ClientCaseSvc and ClientRequestSvc take it. */
export function clientWorkspaceOf(req: Request): ClientWorkspace {
  const ws = req.workspace;
  if (!ws?.organizationId) throw new HttpError("Client workspace not resolved — route must run requireClientAccount first", 500);
  return { id: ws.organizationId, role: ws.role, tenantCode: ws.tenantCode };
}

export default async function requireClientAccount(req: Request, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { role: true, name: true, username: true } });
  if (user?.role !== "USER") {
    throw new HttpError("This is only available in the client app", 403, "CLIENT_ACCOUNT_ONLY");
  }
  // A client's personal workspace is an organization (clients keep theirs; only lawyers work
  // without one), so it's a firm-shaped workspace here.
  const ws = await ClientCaseSvc.workspaceFor(req.user.userId, user.name || user.username);
  req.workspace = { organizationId: ws.id, ownerId: null, userId: req.user.userId, role: ws.role, tenantCode: ws.tenantCode };
  next();
}
