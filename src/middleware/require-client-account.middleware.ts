import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import ClientCaseSvc from "../services/client-case.service";
import HttpError from "../utils/http-error";

/**
 * For the client app's routes (/api/client). The caller must be a client account (User.role
 * USER), read fresh from the database like requireAdmin rather than trusted from the token. Every
 * request then runs in the client's personal workspace (ClientCaseSvc.workspaceFor), so the
 * client app sends no X-Organization-Id. Must run after validSession and be wrapped in
 * asyncHandler.
 */
export default async function requireClientAccount(req: Request, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { role: true, name: true, username: true } });
  if (user?.role !== "USER") {
    throw new HttpError("This is only available in the client app", 403, "CLIENT_ACCOUNT_ONLY");
  }
  req.organization = await ClientCaseSvc.workspaceFor(req.user.userId, user.name || user.username);
  next();
}
