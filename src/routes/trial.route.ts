import express from "express";
import asyncHandler from "../utils/async-handler";
import HttpError from "../utils/http-error";
import TrialSvc from "../services/trial.service";
import LlmUsageSvc from "../services/llm-usage.service";
import AuthRepo from "../repositories/auth.repository";
import validSession from "../middleware/valid-session.middleware";
import { TRIAL_BUDGET_USD, TRIAL_DURATION_HOURS, TRIAL_MESSAGE_LIMIT } from "../config";
import { setRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { resolveTenantCodeFromRequest } from "../utils/tenant-host";

const router = express.Router();

// Public: what the start screen tells a visitor before there is a guest to read it from.
// `budgetUsd` is null when the full trial is not offered (TRIAL_BUDGET_USD unset).
router.get("/config", (_req, res) =>
  res.json({ messageLimit: TRIAL_MESSAGE_LIMIT, durationHours: TRIAL_DURATION_HOURS, budgetUsd: TRIAL_BUDGET_USD }),
);

// Public: starts a landing-page trial guest. `acceptedNotice` is the guest agreeing to the
// AI-processing notice shown before the button; without it nothing is created. `kind: "full"`
// starts the full trial (the whole product, limited by spend); anything else the chat-only one.
router.post(
  "/start",
  asyncHandler(async (req, res) => {
    if (req.body?.acceptedNotice !== true) throw new HttpError("Accept the notice to start the trial", 400);
    const kind = req.body?.kind === "full" ? "FULL" : "CHAT";
    const { user, accessToken, refreshToken, consultationId } = await TrialSvc.start(resolveTenantCodeFromRequest(req), kind);
    setRefreshTokenCookie(res, refreshToken, true);
    return res.status(201).json({ user, accessToken, consultationId });
  }),
);

// A FULL guest's spend so far against TRIAL_BUDGET_USD, for the app's banner. 404 for anyone else.
router.get(
  "/budget",
  validSession,
  asyncHandler(async (req, res) => {
    const trial = await AuthRepo.findTrialState(req.user!.userId);
    if (trial?.kind !== "FULL") throw new HttpError("Not on the full trial", 404);
    return res.json({ budgetUsd: TRIAL_BUDGET_USD, spentUsd: await LlmUsageSvc.chatWonderSpendUsd(req.user!.userId) });
  }),
);

export default router;
