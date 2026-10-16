import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { ACCESS_TOKEN_SECRET } from "../config";
import { TRIAL_MESSAGE_LIMIT } from "../constants/trial.constants";

/** Spends one of a trial guest's AI answers before a message is sent; a no-op for real accounts.
 * Must run after validSession. 403 TRIAL_LIMIT_REACHED tells the app to ask for an account. */
export async function trialMessageLimit(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user?.userId || !(await AuthRepo.findTrialState(req.user.userId))) return next();
    if (!(await AuthRepo.spendTrialMessage(req.user.userId, TRIAL_MESSAGE_LIMIT))) {
      throw new HttpError("You've used your trial answers. Create an account to keep going.", 403, "TRIAL_LIMIT_REACHED");
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Refuses writes (uploads, sharing, new cases...) from a trial guest; reads still work, so the
 * pages around the chat load. Mounted ahead of a router, so it reads the token itself rather than
 * relying on validSession; a request without a valid one passes through for the router's own
 * checks to deal with. */
export async function blockTrialWrites(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return next();
    let userId: string | undefined;
    try {
      userId = (jwt.verify(token, ACCESS_TOKEN_SECRET) as { userId?: string }).userId;
    } catch {
      return next();
    }
    if (userId && (await AuthRepo.findTrialState(userId))) {
      throw new HttpError("Create an account to use this.", 403, "TRIAL_RESTRICTED");
    }
    next();
  } catch (err) {
    next(err);
  }
}
