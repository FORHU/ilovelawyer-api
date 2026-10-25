import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import ClientRequestLawyerCtrl from "../controllers/client-request-lawyer.controller";

// The lawyer app's side of the UK client-to-lawyer hand-off (#511, #512). The client app's side is
// /client/lawyer-requests (client.route.ts). Same rows.
const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.get("/", asyncHandler(ClientRequestLawyerCtrl.list));
router.get("/:id", asyncHandler(ClientRequestLawyerCtrl.get));
router.post("/:id/claim", asyncHandler(ClientRequestLawyerCtrl.claim));
router.post("/:id/pass", asyncHandler(ClientRequestLawyerCtrl.pass));
// The conflict check, giving it back, and the quote (#512).
router.get("/:id/parties", asyncHandler(ClientRequestLawyerCtrl.parties));
router.post("/:id/release", asyncHandler(ClientRequestLawyerCtrl.release));
router.post("/:id/quote", asyncHandler(ClientRequestLawyerCtrl.quote));
// Retrying the per-case fee after the card was declined and updated (#513).
router.post("/:id/charge/retry", asyncHandler(ClientRequestLawyerCtrl.retryCharge));
// Copying the engaged client's case to the lawyer's own workspace (#514).
router.post("/:id/copy", asyncHandler(ClientRequestLawyerCtrl.copy));
// The engagement's AI budget meter (#515).
router.get("/:id/ai-budget", asyncHandler(ClientRequestLawyerCtrl.aiBudget));
// Buying an AI top-up pack for it, once the lawyer approves the charge (#516).
router.post("/:id/ai-top-ups", asyncHandler(ClientRequestLawyerCtrl.topUp));
// The engagement thread with the client (#517). The client's side is /client/lawyer-requests/:id/messages.
router.get("/:id/messages", asyncHandler(ClientRequestLawyerCtrl.messages));
router.post("/:id/messages", asyncHandler(ClientRequestLawyerCtrl.postMessage));
router.post("/:id/messages/read", asyncHandler(ClientRequestLawyerCtrl.readMessages));
// The lawyer's side of closing the engagement (#519). The client's side is /client/lawyer-requests/:id/end.
router.post("/:id/close", asyncHandler(ClientRequestLawyerCtrl.close));

export default router;
