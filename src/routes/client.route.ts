import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireClientAccount from "../middleware/require-client-account.middleware";
import requireConsent from "../middleware/require-consent.middleware";
import ClientCaseCtrl from "../controllers/client-case.controller";
import ClientRequestCtrl from "../controllers/client-request.controller";
import ClientDictationCtrl from "../controllers/client-dictation.controller";
import ClientLawyerCtrl from "../controllers/client-lawyer.controller";
import ClientGmailCtrl from "../controllers/client-gmail.controller";

// A spoken answer is a short clip (180s at most in the app); in memory, since it goes straight to S3
// for the Transcribe job.
const dictationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
// Each clip starts a billed Transcribe job, so a client can only start so many: per account, ahead of
// the upload so a refused request holds no clip in memory.
const dictationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user.userId,
  message: { message: "You've used voice input a lot just now. Try again in a few minutes, or type instead." },
});

// Each Gmail search fans out to up to 50 Gmail reads, and Google limits each user's quota, so a
// client gets a generous but bounded number of inbox calls.
const gmailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user.userId,
  message: { message: "That's a lot of Gmail searches in a short time. Wait a minute and try again." },
});

const emailImportConsent = requireConsent("EMAIL_IMPORT");

const gmailSuggestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user.userId,
  message: { message: "You've asked the AI for email suggestions a lot just now. Try again in a few minutes, or search yourself." },
});

/** The client app (ilovelawyer-client): a client's own cases, their AI chat and their documents.
 * Client accounts only; everything runs in the client's personal workspace. */
const router = express.Router();

router.use(validSession, asyncHandler(requireClientAccount));

router.get("/pricing", asyncHandler(ClientCaseCtrl.pricing));
router.post("/payments/top-up/quote", asyncHandler(ClientCaseCtrl.quoteTopUp));
// Removed with pay per case: 410 for a client app still open from before.
router.post("/payments/case/quote", asyncHandler(ClientCaseCtrl.casePaymentGone));
router.post("/payments/case", asyncHandler(ClientCaseCtrl.casePaymentGone));
router.get("/payments/:paymentId", asyncHandler(ClientCaseCtrl.paymentStatus));

// Speaking instead of typing in a composer (AWS Transcribe): the clip is sent for transcribing, so
// it needs AI-processing consent like the chat does. Nothing is kept once the text is returned.
router.post("/dictations", requireConsent("AI_PROCESSING"), dictationLimiter, dictationUpload.single("audio"), asyncHandler(ClientDictationCtrl.start));
router.get("/dictations/:id", asyncHandler(ClientDictationCtrl.result));

router.get("/limits", asyncHandler(ClientCaseCtrl.limits));
// The "Type of issue" choices: the switched-on case areas, in order.
router.get("/case-areas", asyncHandler(ClientCaseCtrl.caseAreas));

router.get("/cases", asyncHandler(ClientCaseCtrl.list));
router.post("/cases", asyncHandler(ClientCaseCtrl.create));
router.get("/cases/:caseId", asyncHandler(ClientCaseCtrl.get));
router.patch("/cases/:caseId", asyncHandler(ClientCaseCtrl.update));
router.delete("/cases/:caseId", asyncHandler(ClientCaseCtrl.remove));
router.post("/cases/:caseId/archive", asyncHandler(ClientCaseCtrl.archive));
router.post("/cases/:caseId/unarchive", asyncHandler(ClientCaseCtrl.unarchive));
router.get("/cases/:caseId/messages", asyncHandler(ClientCaseCtrl.listMessages));
router.post("/cases/:caseId/messages", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.sendMessage));
router.post("/cases/:caseId/voice-messages/presign", asyncHandler(ClientCaseCtrl.presignVoiceMessage));
router.post("/cases/:caseId/voice-messages", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.sendVoiceMessage));
router.post("/cases/:caseId/documents/presign", asyncHandler(ClientCaseCtrl.presignDocument));
router.post("/cases/:caseId/documents", asyncHandler(ClientCaseCtrl.addDocument));
// The Documents tab's row actions (#574). Retry reads the file again like an upload does, so like
// an upload it needs no AI-processing consent.
router.delete("/cases/:caseId/documents/:documentId", asyncHandler(ClientCaseCtrl.removeDocument));
router.get("/cases/:caseId/documents/:documentId/url", asyncHandler(ClientCaseCtrl.documentUrl));
router.post("/cases/:caseId/documents/:documentId/retry", asyncHandler(ClientCaseCtrl.retryDocument));
// The Overview tab (#45/#572): a client-shaped summary, read for free and regenerated through a
// small job of its own — see ClientOverviewSvc. Generate reads documents already on the case, so
// it needs AI-processing consent like the chat does; the GET is a plain read and doesn't.
router.get("/cases/:caseId/overview", asyncHandler(ClientCaseCtrl.overview));
router.post("/cases/:caseId/overview/generate", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.generateOverview));
// The Intake tab (docs/plans/client-side-compressed-meteor.md): the Overview's traceable,
// secretary-shaped replacement. Both tabs run side by side until the client app has moved over.
router.get("/cases/:caseId/intake", asyncHandler(ClientCaseCtrl.intake));
router.post("/cases/:caseId/intake/refresh", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.refreshIntake));
router.post("/cases/:caseId/top-ups", asyncHandler(ClientCaseCtrl.topUp));
// A GET, but it asks Jev about the case, so it needs AI-processing consent like the chat does.
router.get("/cases/:caseId/lawyer-readiness", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.lawyerReadiness));

// The lawyer marketplace: verified lawyers taking requests, filtered and sorted.
// Email import (EPIC #982): the client's own Gmail, read-only. Nothing read here is stored.
// Everything but Disconnect needs the client's email-import consent (#989), given before they
// connect; withdrawing it disconnects Gmail.
router.post("/gmail/connect", emailImportConsent, asyncHandler(ClientGmailCtrl.connect));
router.delete("/gmail", asyncHandler(ClientGmailCtrl.disconnect));
router.get("/gmail/messages", emailImportConsent, gmailLimiter, asyncHandler(ClientGmailCtrl.search));
router.get("/gmail/messages/:messageId", emailImportConsent, gmailLimiter, asyncHandler(ClientGmailCtrl.message));
router.get("/gmail/messages/:messageId/attachments/:partId/download", emailImportConsent, gmailLimiter, asyncHandler(ClientGmailCtrl.downloadAttachment));
// Adding an email to a case (#986/#987): the email as a PDF and/or chosen attachments, each a
// case document. Like an upload, it needs no AI-processing consent.
router.post("/cases/:caseId/gmail-imports", emailImportConsent, gmailLimiter, asyncHandler(ClientGmailCtrl.importToCase));
// "Suggest by AI" (#984): Intake searches the inbox for the case and ranks what it finds. Sends
// email headers and previews to the AI, so it needs AI-processing consent, and each run is an AI
// call plus up to ~45 Gmail reads, so it has its own tighter limit.
router.post("/cases/:caseId/gmail-suggestions", emailImportConsent, requireConsent("AI_PROCESSING"), gmailSuggestLimiter, asyncHandler(ClientGmailCtrl.suggestForCase));

router.get("/lawyers", asyncHandler(ClientLawyerCtrl.list));
router.get("/lawyers/:id", asyncHandler(ClientLawyerCtrl.get));

// Asking for a lawyer on one of the client's cases (the UK client-to-lawyer hand-off).
router.get("/lawyer-requests/consent", asyncHandler(ClientRequestCtrl.consent));
router.get("/lawyer-requests/eligibility", asyncHandler(ClientRequestCtrl.eligibility));
// The request's anonymised brief is AI-written (#508), so creating one needs AI-processing consent.
router.post("/lawyer-requests", requireConsent("AI_PROCESSING"), asyncHandler(ClientRequestCtrl.create));
router.get("/lawyer-requests", asyncHandler(ClientRequestCtrl.list));
router.get("/lawyer-requests/:id", asyncHandler(ClientRequestCtrl.get));
router.post("/lawyer-requests/:id/withdraw", asyncHandler(ClientRequestCtrl.withdraw));
// Answering the lawyer's quote (#513): confirming charges their organization the per-case fee.
router.post("/lawyer-requests/:id/confirm", asyncHandler(ClientRequestCtrl.confirm));
router.post("/lawyer-requests/:id/decline", asyncHandler(ClientRequestCtrl.decline));
// A lawyer's quotation by its id: accepting it fixes the amount, then the client pays it through
// ilovelawyer (a Stripe PaymentIntent); paying engages the request.
router.post("/lawyer-requests/:id/quotations/:quotationId/accept", asyncHandler(ClientRequestCtrl.acceptQuotation));
router.post("/lawyer-requests/:id/quotations/:quotationId/reject", asyncHandler(ClientRequestCtrl.rejectQuotation));
router.post("/lawyer-requests/:id/quotations/:quotationId/payment", asyncHandler(ClientRequestCtrl.payQuotation));
router.get("/lawyer-requests/:id/payment", asyncHandler(ClientRequestCtrl.payment));
// The client's side of closing the engagement, and rating the lawyer afterwards (#519).
router.post("/lawyer-requests/:id/end", asyncHandler(ClientRequestCtrl.end));
// The lawyer said the work is finished: the client confirms it (the engagement closes) or says it isn't.
router.post("/lawyer-requests/:id/completion/confirm", asyncHandler(ClientRequestCtrl.confirmCompletion));
router.post("/lawyer-requests/:id/completion/decline", asyncHandler(ClientRequestCtrl.declineCompletion));
router.post("/lawyer-requests/:id/feedback", asyncHandler(ClientRequestCtrl.feedback));
// The engagement thread with the lawyer (#517).
router.get("/lawyer-requests/:id/messages", asyncHandler(ClientRequestCtrl.messages));
router.post("/lawyer-requests/:id/messages", asyncHandler(ClientRequestCtrl.postMessage));
router.post("/lawyer-requests/:id/messages/read", asyncHandler(ClientRequestCtrl.readMessages));

export default router;
