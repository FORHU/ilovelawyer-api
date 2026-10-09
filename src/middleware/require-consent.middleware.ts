import { Request, Response, NextFunction } from "express";
import { ConsentPurpose } from "@prisma/client";
import ConsentSvc from "../services/consent.service";

/** Stops a request that needs a consent the person has switched off, before anything is claimed or
 * queued. Must run after validSession (it reads req.user). Put it on a route that starts AI work:
 *   router.post("/:caseId/refresh", requireConsent("AI_PROCESSING"), asyncHandler(Ctrl.refresh));
 * test/consent-enforcement.spec.ts fails when a route that starts AI work does not have it. */
export default function requireConsent(purpose: ConsentPurpose) {
  return async function requireConsentMiddleware(req: Request, _res: Response, next: NextFunction) {
    try {
      await ConsentSvc.assertAllowed(req.user.userId, purpose);
      next();
    } catch (err) {
      next(err);
    }
  };
}
