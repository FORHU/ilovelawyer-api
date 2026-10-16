import express from "express";
import asyncHandler from "../utils/async-handler";
import HttpError from "../utils/http-error";
import TrialSvc from "../services/trial.service";
import { setRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { resolveTenantCodeFromRequest } from "../utils/tenant-host";

const router = express.Router();

// Public: starts a landing-page trial guest. `acceptedNotice` is the guest agreeing to the
// AI-processing notice shown before the button; without it nothing is created.
router.post(
  "/start",
  asyncHandler(async (req, res) => {
    if (req.body?.acceptedNotice !== true) throw new HttpError("Accept the notice to start the trial", 400);
    const { user, accessToken, refreshToken, consultationId } = await TrialSvc.start(resolveTenantCodeFromRequest(req));
    setRefreshTokenCookie(res, refreshToken, true);
    return res.status(201).json({ user, accessToken, consultationId });
  }),
);

export default router;
