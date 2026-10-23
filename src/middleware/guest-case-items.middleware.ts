import { NextFunction, Request, Response } from "express";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { scopeWhere, type WorkspaceScope } from "../utils/workspace";

/**
 * Keeps a guest (see resolveOrganizationAllowingGuests) to what belongs to the case shared with
 * them. Documents and transcriptions also exist outside any case, as the portfolio owner's own
 * workspace material; those are never part of a share. The case rules the services already apply
 * (CaseAccess.visibleWhere) handle which cases a guest can see; these only take away the "no case"
 * part. Members pass straight through.
 */

/** A guest lists only one case's items — the list without `caseId` is the whole workspace's. */
export function guestListNeedsCase(req: Request, _res: Response, next: NextFunction) {
  if (!req.workspace?.guest) return next();
  if (typeof req.query.caseId !== "string" || !req.query.caseId) {
    return next(new HttpError("Only a shared case's items are available to you", 403, "SHARE_CASE_ONLY"));
  }
  next();
}

type CaseOf = (id: string, scope: WorkspaceScope) => Promise<{ caseId: string | null } | null>;

/** For `router.param("id", ...)`: a guest gets 404 for an item that isn't on a case, like any id
 * they can't reach. Whether they can open that case is left to the service, as for a member. */
export function guestItemNeedsCase(caseOf: CaseOf) {
  return (req: Request, _res: Response, next: NextFunction, id: string) => {
    if (!req.workspace?.guest) return next();
    caseOf(id, req.workspace)
      .then((item) => (item?.caseId ? next() : next(new HttpError("Not found", 404))))
      .catch(next);
  };
}

export const documentCaseOf: CaseOf = (id, scope) =>
  prisma.document.findFirst({ where: { id, ...scopeWhere(scope) }, select: { caseId: true } });

export const transcriptionCaseOf: CaseOf = (id, scope) =>
  prisma.transcription.findFirst({ where: { id, ...scopeWhere(scope) }, select: { caseId: true } });

export const consultationCaseOf: CaseOf = (id, scope) =>
  prisma.consultation.findFirst({ where: { id, ...scopeWhere(scope) }, select: { caseId: true } });

/** For the parts of a guest-reachable router that are never part of a share (e.g. consultation
 * invite links, which are about joining, not reading). */
export function guestRefused(req: Request, _res: Response, next: NextFunction) {
  if (req.workspace?.guest) return next(new HttpError("Not available on a case shared with you", 403, "SHARE_NOT_INCLUDED"));
  next();
}
