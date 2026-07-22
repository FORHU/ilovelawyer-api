import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import CalendarWatchChannelCtrl from "../controllers/calendar-watch-channel.controller";

const router = express.Router();

// Webhook is public — Google calls it directly (no auth)
router.post("/webhooks/calendar", asyncHandler(CalendarWatchChannelCtrl.handleWebhook));

// Watch registration requires auth
router.post("/watch", validSession, asyncHandler(CalendarWatchChannelCtrl.registerWatch));

export default router;
