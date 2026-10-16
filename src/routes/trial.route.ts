import express from "express";
import asyncHandler from "../utils/async-handler";
import HttpError from "../utils/http-error";
import TrialSvc from "../services/trial.service";
import { TRIAL_DURATION_HOURS, TRIAL_MESSAGE_LIMIT, TRIAL_SAMPLE_CASE_ID } from "../config";
import { setRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { resolveTenantCodeFromRequest } from "../utils/tenant-host";

const router = express.Router();

// Public: what the start screen tells a visitor before there is a guest to read it from.
router.get("/config", (_req, res) =>
  res.json({ messageLimit: TRIAL_MESSAGE_LIMIT, durationHours: TRIAL_DURATION_HOURS, sampleCase: !!TRIAL_SAMPLE_CASE_ID }),
);

// Public: starts a landing-page trial guest. `acceptedNotice` is the guest agreeing to the
// AI-processing notice shown before the button; without it nothing is created. `sample: "case"`
// starts the guest in their own copy of the sample case instead of the sample consultation.
router.post(
  "/start",
  asyncHandler(async (req, res) => {
    if (req.body?.acceptedNotice !== true) throw new HttpError("Accept the notice to start the trial", 400);
    const sample = req.body?.sample === "case" ? "case" : "consultation";
    const { user, accessToken, refreshToken, consultationId, caseId, caseConsultationId } = await TrialSvc.start(
      resolveTenantCodeFromRequest(req),
      sample,
    );
    setRefreshTokenCookie(res, refreshToken, true);
    return res.status(201).json({ user, accessToken, consultationId, caseId, caseConsultationId });
  }),
);

export default router;
