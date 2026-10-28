import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireClientAccount from "../middleware/require-client-account.middleware";
import requireConsent from "../middleware/require-consent.middleware";
import ClientCaseCtrl from "../controllers/client-case.controller";
import ClientRequestCtrl from "../controllers/client-request.controller";

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
// The client's side of closing the engagement, and rating the lawyer afterwards (#519).
router.post("/lawyer-requests/:id/end", asyncHandler(ClientRequestCtrl.end));
router.post("/lawyer-requests/:id/feedback", asyncHandler(ClientRequestCtrl.feedback));
// The engagement thread with the lawyer (#517).
router.get("/lawyer-requests/:id/messages", asyncHandler(ClientRequestCtrl.messages));
router.post("/lawyer-requests/:id/messages", asyncHandler(ClientRequestCtrl.postMessage));
router.post("/lawyer-requests/:id/messages/read", asyncHandler(ClientRequestCtrl.readMessages));

export default router;
