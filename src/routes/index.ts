import express from "express";
import authRoute from "./auth.route";
import trialRoute from "./trial.route";
import { blockTrialWrites } from "../middleware/trial.middleware";
import { freeCreditLimit } from "../middleware/free-credit.middleware";
import { planGate } from "../middleware/plan-gate.middleware";
import chatRoute from "./chat.route";
import legalRagRoute from "./legal-rag.route";
import filesRoute from "./files.route";
import usersRoute from "./users.route";
import caseRoute from "./case.route";
import accountTopupRoute from "./account-topup.route";
import billingRoute from "./billing.route";
import paymentPlanRoute from "./payment-plan.route";
import sharedCaseRoute from "./shared-case.route";
import bookmarkRoute from "./bookmark.route";
import consentRoute from "./consent.route";
import feedbackRoute from "./feedback.route";
import userDocumentRoute from "./user-document.route";
import legalSourceCacheRoute from "./legal-source-cache.route";
import transcriptionRoute from "./transcription.route";
import eventRoute from "./event.route";
import notificationRoute from "./notification.route";
import noteRoute from "./note.route";
import calendarRoute from "./calendar.route";
import legalRoute from "./legal.route";
import sendEmailRoute from "./send-email.route";
import rsvpRoute from "./rsvp.route";
import ttsRoute from "./tts.route";
import healthRoute from "./health.route";
import caseDocumentRoute from "./case-document.route";
import generatedDocumentRoute from "./generated-document.route";
import terminalRoute from "./terminal.route";
import organizationRoute from "./organization.route";
import { jurisdictionRouter, integrationRouter } from "./jurisdiction.route";
import modelSettingsRoute from "./model-settings.route";
import adminRoute from "./admin.route";
import lawRoute from "./law.route";
import clientRoute from "./client.route";
import clientRequestRoute from "./client-request.route";
import practiceAreaRoute from "./practice-area.route";
import lawyerMatchingRoute from "./lawyer-matching.route";

const router = express.Router();

// An account that has spent its free AI credit starts no new work anywhere (freeCreditLimit).
router.use(freeCreditLimit);

// A UK lawyer held by verify before plan reaches only what the verification and plan steps need
// (planGate).
router.use(planGate);

// A trial guest (see TrialSvc) can read around the app but not write through these. That includes
// the routers whose POSTs call a paid model or the speech service (legal-rag, tts, law's citation
// expansion, source analysis); a guest's only AI is the capped chat send (trialMessageLimit).
router.use(
  [
    "/organizations", "/case-document", "/generated-document", "/my-cases", "/shared-cases", "/documents",
    "/transcriptions", "/send-email", "/terminal", "/legal-rag", "/tts", "/law", "/legal-source-analysis", "/model-settings",
  ],
  blockTrialWrites,
);

router.use("/health", healthRoute);
router.use("/organizations", organizationRoute);
router.use("/case-document", caseDocumentRoute);
router.use("/generated-document", generatedDocumentRoute);
router.use("/auth", authRoute);
router.use("/trial", trialRoute);
router.use("/chat", chatRoute);
router.use("/legal-rag", legalRagRoute);
router.use("/files", filesRoute);
router.use("/users", usersRoute);
router.use("/admin", adminRoute);
router.use("/law", lawRoute);
router.use("/my-cases", caseRoute);
router.use("/account-topups", accountTopupRoute);
router.use("/billing", billingRoute);
router.use("/payment-plans", paymentPlanRoute);
router.use("/shared-cases", sharedCaseRoute);
router.use("/bookmarks", bookmarkRoute);
router.use("/consents", consentRoute);
router.use("/feedback", feedbackRoute);
router.use("/documents", userDocumentRoute);
router.use("/legal-source-analysis", legalSourceCacheRoute);
router.use("/transcriptions", transcriptionRoute);
router.use("/events", eventRoute);
router.use("/notifications", notificationRoute);
router.use("/notes", noteRoute);
router.use("/calendar", calendarRoute);
router.use("/legal", legalRoute);
router.use("/send-email", sendEmailRoute);
router.use("/rsvp", rsvpRoute);
router.use("/tts", ttsRoute);
router.use("/terminal", terminalRoute);
router.use("/jurisdictions", jurisdictionRouter);
router.use("/integrations", integrationRouter);
router.use("/model-settings", modelSettingsRoute);
router.use("/practice-areas", practiceAreaRoute);
router.use("/lawyer-matching", lawyerMatchingRoute);
// The client app (ilovelawyer-client): client accounts only.
router.use("/client", clientRoute);
router.use("/client-requests", clientRequestRoute);

export default router;
