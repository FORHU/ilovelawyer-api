import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import PlanGateSvc from "../services/plan-gate.service";
import { ACCESS_TOKEN_SECRET } from "../config";

/** Still open to a lawyer held by verify before plan: signing in and out, their own account
 * (profile, Lawyer Application, plan gate, solo, card on file, deletion, export), consents, setting
 * up their firm and its card (organizations), choosing and paying for a plan (payment-plans,
 * billing), and what the application form and the app shell read (practice areas, jurisdictions,
 * notifications). */
const HELD_OPEN = /^\/api(?:\/v1)?\/(?:auth|health|users\/me|consents|organizations|payment-plans|billing|practice-areas|jurisdictions|notifications)(?:\/|$)/;

/** Verify before plan (PlanGateSvc), enforced for the whole API: while a UK solo lawyer or founder
 * waits for their application's verification, or hasn't chosen a plan yet, every request outside
 * HELD_OPEN answers 403 VERIFICATION_REQUIRED or PLAN_NOT_CHOSEN, reads included. Mounted ahead of
 * every router, so it reads the token itself; a request without a valid one passes through for the
 * router's own checks to deal with. */
export async function planGate(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method === "OPTIONS") return next();
    const path = `${req.baseUrl}${req.path}`.replace(/\/$/, "");
    if (HELD_OPEN.test(path)) return next();
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return next();
    let userId: string | undefined;
    try {
      userId = (jwt.verify(token, ACCESS_TOKEN_SECRET) as { userId?: string }).userId;
    } catch {
      return next();
    }
    if (userId) await PlanGateSvc.assertOpenForRequest(userId);
    next();
  } catch (err) {
    next(err);
  }
}
