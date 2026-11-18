import { Request, Response, NextFunction } from "express";
import { clientWorkspaceOf } from "./require-client-account.middleware";
import { assertClientAiOpen, assertClientRequestsOpen } from "../constants/client-sites.constants";

/** For a client route that runs the AI: 403 CLIENT_AI_NOT_OPEN on a site whose AI isn't open
 * (constants/client-sites.constants.ts). Must run after requireClientAccount. */
export function requireClientAi(req: Request, _res: Response, next: NextFunction) {
  assertClientAiOpen(clientWorkspaceOf(req).tenantCode);
  next();
}

/** For a client route that finds or asks for a lawyer: 403 CLIENT_REQUESTS_NOT_OPEN on a site
 * where lawyers don't take client requests yet. Must run after requireClientAccount. */
export function requireClientRequests(req: Request, _res: Response, next: NextFunction) {
  assertClientRequestsOpen(clientWorkspaceOf(req).tenantCode);
  next();
}
