import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireClientAccount from "../middleware/require-client-account.middleware";
import requireConsent from "../middleware/require-consent.middleware";
import { requireClientAi, requireClientRequests } from "../middleware/require-client-site-feature.middleware";
import ClientCaseCtrl from "../controllers/client-case.controller";
import ClientRequestCtrl from "../controllers/client-request.controller";
import caseLawyerInviteRoute from "./case-lawyer-invite.route";
import ClientDictationCtrl from "../controllers/client-dictation.controller";
import ClientLawyerCtrl from "../controllers/client-lawyer.controller";
import ClientGmailCtrl from "../controllers/client-gmail.controller";
import SupportContentCtrl from "../controllers/support-content.controller";
import SupportActionCtrl from "../controllers/support-action.controller";
import SupportTicketCtrl from "../controllers/support-ticket.controller";

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

// Each story makes a case and starts an AI reading of it (no chat credit is spent), so a client can
// only tell so many in a short time.
const storyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user.userId,
  message: { message: "You've sent a lot of stories just now. Try again in a few minutes." },
});

// Starting the questions writes the case's list with the AI once; coming back to them is a plain
// read. Bounded all the same, since a start can call the AI.
const questionsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user.userId,
  message: { message: "That's a lot of tries just now. Wait a few minutes, then carry on with your questions." },
});

// A typed or spoken answer can ask the AI whether it's complete. Generous: a case has at most six
// questions and their follow-ups.
const answersLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user.userId,
  message: { message: "That's a lot of answers just now. Wait a few minutes, then carry on." },
});

// The Case summary PDF is rendered on every download (nothing is stored), so it's bounded per account.
const caseSummaryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user.userId,
  message: { message: "You've downloaded a lot of case summaries just now. Try again in a few minutes." },
});

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

// The Support Chat's published content for a signed-in client (SupportContentSvc).
router.get("/support/content", asyncHandler(SupportContentCtrl.forClient));
// What the Support Chat's actions do for a signed-in client (SupportActionSvc). deletion-check is
// registered first.
router.get("/support/actions/deletion-check", asyncHandler(SupportActionCtrl.deletionCheck));
router.post("/support/actions/:key", asyncHandler(SupportActionCtrl.run));
// The client's Support Ticket: one conversation with the team, and the flow outcomes the chat reports
// (SupportTicketSvc, SupportOutcomeSvc).
const ticketMessageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user.userId,
  message: { message: "You've sent a lot of messages just now. Wait a few minutes and try again." },
});
router.get("/support/ticket", asyncHandler(SupportTicketCtrl.getThread));
router.post("/support/ticket/messages", ticketMessageLimiter, asyncHandler(SupportTicketCtrl.postMessage));
router.post("/support/ticket/read", asyncHandler(SupportTicketCtrl.markRead));
router.post("/support/outcomes", asyncHandler(SupportTicketCtrl.recordOutcomes));
router.post("/payments/top-up/quote", asyncHandler(ClientCaseCtrl.quoteTopUp));
// Removed with pay per case: 410 for a client app still open from before.
router.post("/payments/case/quote", asyncHandler(ClientCaseCtrl.casePaymentGone));
router.post("/payments/case", asyncHandler(ClientCaseCtrl.casePaymentGone));
router.get("/payments/:paymentId", asyncHandler(ClientCaseCtrl.paymentStatus));

// Speaking instead of typing in a composer (AWS Transcribe): the clip is sent for transcribing, so
// it needs AI-processing consent like the chat does. Nothing is kept once the text is returned.
router.post("/dictations", requireClientAi, requireConsent("AI_PROCESSING"), dictationLimiter, dictationUpload.single("audio"), asyncHandler(ClientDictationCtrl.start));
router.get("/dictations/:id", asyncHandler(ClientDictationCtrl.result));

router.get("/limits", asyncHandler(ClientCaseCtrl.limits));
// The "Type of issue" choices: the switched-on case areas, in order.
router.get("/case-areas", asyncHandler(ClientCaseCtrl.caseAreas));

router.get("/cases", asyncHandler(ClientCaseCtrl.list));
router.post("/cases", asyncHandler(ClientCaseCtrl.create));
// The story-first way in (the new-client flow): a case made from the client's story, which the AI
// reads straight away, and their fix to it. Both start AI work, so both need AI-processing consent.
router.post("/cases/story", requireClientAi, requireConsent("AI_PROCESSING"), storyLimiter, asyncHandler(ClientCaseCtrl.startStory));
router.post("/cases/:caseId/story", requireClientAi, requireConsent("AI_PROCESSING"), storyLimiter, asyncHandler(ClientCaseCtrl.correctStory));
// The story's key facts as chips, shown while it's read: one small AI call, nothing stored.
router.post("/cases/:caseId/story/facts", requireClientAi, requireConsent("AI_PROCESSING"), questionsLimiter, asyncHandler(ClientCaseCtrl.storyFacts));
// The Questions step after the story: the details the case still needs, one at a time. Starting
// writes the list with the AI, so it needs AI-processing consent.
// The evidence step after the questions: proof suggested from the story and answers. Starting asks
// the AI once (consent needed); reading and "I don't have this" never do.
router.get("/cases/:caseId/evidence-suggestions", asyncHandler(ClientCaseCtrl.evidence));
router.post("/cases/:caseId/evidence-suggestions", requireClientAi, requireConsent("AI_PROCESSING"), questionsLimiter, asyncHandler(ClientCaseCtrl.startEvidence));
router.patch("/cases/:caseId/evidence-suggestions/:suggestionId", asyncHandler(ClientCaseCtrl.dismissEvidence));
// Done reads the case again (the intake reading), so it needs AI-processing consent.
router.post("/cases/:caseId/evidence/done", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.evidenceDone));
// The client's own note on a document: no AI involved.
router.patch("/cases/:caseId/documents/:documentId/note", asyncHandler(ClientCaseCtrl.setDocumentNote));
// A plain read, for the case page's "questions left" banner: never writes a list or asks the AI.
router.get("/cases/:caseId/questions", asyncHandler(ClientCaseCtrl.questions));
router.post("/cases/:caseId/questions", requireClientAi, requireConsent("AI_PROCESSING"), questionsLimiter, asyncHandler(ClientCaseCtrl.startQuestions));
// An answer may ask the AI whether it's complete, so it needs the same consent; a skip asks nothing,
// but the questions are an AI step all the same.
router.post("/cases/:caseId/questions/answer", requireClientAi, requireConsent("AI_PROCESSING"), answersLimiter, asyncHandler(ClientCaseCtrl.answerQuestion));
router.post("/cases/:caseId/questions/skip", requireClientAi, requireConsent("AI_PROCESSING"), answersLimiter, asyncHandler(ClientCaseCtrl.skipQuestion));
router.get("/cases/:caseId", asyncHandler(ClientCaseCtrl.get));
router.patch("/cases/:caseId", asyncHandler(ClientCaseCtrl.update));
router.delete("/cases/:caseId", asyncHandler(ClientCaseCtrl.remove));
router.post("/cases/:caseId/archive", asyncHandler(ClientCaseCtrl.archive));
router.post("/cases/:caseId/unarchive", asyncHandler(ClientCaseCtrl.unarchive));
router.get("/cases/:caseId/messages", asyncHandler(ClientCaseCtrl.listMessages));
router.post("/cases/:caseId/messages", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.sendMessage));
// Stop an answer (its credit comes back) and delete a message (#568). Neither asks the AI anything,
// so neither needs AI-processing consent.
router.post("/cases/:caseId/messages/:messageId/cancel", asyncHandler(ClientCaseCtrl.cancelMessage));
router.delete("/cases/:caseId/messages/:messageId", asyncHandler(ClientCaseCtrl.deleteMessage));
router.post("/cases/:caseId/voice-messages/presign", requireClientAi, asyncHandler(ClientCaseCtrl.presignVoiceMessage));
router.post("/cases/:caseId/voice-messages", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.sendVoiceMessage));
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
router.post("/cases/:caseId/overview/generate", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.generateOverview));
// The Intake tab (docs/plans/client-side-compressed-meteor.md): the Overview's traceable,
// secretary-shaped replacement. Both tabs run side by side until the client app has moved over.
router.get("/cases/:caseId/intake", asyncHandler(ClientCaseCtrl.intake));
router.post("/cases/:caseId/intake/refresh", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.refreshIntake));
// "Download case summary" (ilovelawyer-client#137): the stored intake as a PDF. A plain read — no AI,
// no credits, so no AI consent — but each one renders a PDF, so a client gets a bounded number.
router.get("/cases/:caseId/export", caseSummaryLimiter, asyncHandler(ClientCaseCtrl.exportSummary));
router.post("/cases/:caseId/top-ups", asyncHandler(ClientCaseCtrl.topUp));
// A GET, but it asks Jev about the case, so it needs AI-processing consent like the chat does.
router.get("/cases/:caseId/lawyer-readiness", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.lawyerReadiness));
// #159: the case's open evidence gaps, plus CW's pick of which to ask for next — a GET, but it
// calls CW for the suggestion, same AI-consent reasoning as lawyer-readiness above.
router.get("/cases/:caseId/missing-evidence", requireClientAi, requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.missingEvidence));

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
router.post("/cases/:caseId/gmail-suggestions", requireClientAi, emailImportConsent, requireConsent("AI_PROCESSING"), gmailSuggestLimiter, asyncHandler(ClientGmailCtrl.suggestForCase));

router.get("/lawyers", requireClientRequests, asyncHandler(ClientLawyerCtrl.list));
router.get("/lawyers/:id", requireClientRequests, asyncHandler(ClientLawyerCtrl.get));

// Asking for a lawyer on one of the client's cases (the UK client-to-lawyer hand-off).
router.get("/lawyer-requests/consent", asyncHandler(ClientRequestCtrl.consent));
router.get("/lawyer-requests/eligibility", requireClientRequests, asyncHandler(ClientRequestCtrl.eligibility));
// The request's anonymised brief is AI-written (#508), so creating one needs AI-processing consent.
router.post("/lawyer-requests", requireClientRequests, requireConsent("AI_PROCESSING"), asyncHandler(ClientRequestCtrl.create));
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

// A client inviting their own lawyer onto a case (client-invites-own-lawyer), by link or email.
router.use("/lawyer-invites", caseLawyerInviteRoute);

export default router;
