import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireClientAccount from "../middleware/require-client-account.middleware";
import requireConsent from "../middleware/require-consent.middleware";
import ClientCaseCtrl from "../controllers/client-case.controller";

/** The client app (ilovelawyer-client): a client's own cases, their AI chat and their documents.
 * Client accounts only; everything runs in the client's personal workspace. */
const router = express.Router();

router.use(validSession, asyncHandler(requireClientAccount));

router.get("/cases", asyncHandler(ClientCaseCtrl.list));
router.post("/cases", asyncHandler(ClientCaseCtrl.create));
router.get("/cases/:caseId", asyncHandler(ClientCaseCtrl.get));
router.get("/cases/:caseId/messages", asyncHandler(ClientCaseCtrl.listMessages));
router.post("/cases/:caseId/messages", requireConsent("AI_PROCESSING"), asyncHandler(ClientCaseCtrl.sendMessage));
router.post("/cases/:caseId/documents/presign", asyncHandler(ClientCaseCtrl.presignDocument));
router.post("/cases/:caseId/documents", asyncHandler(ClientCaseCtrl.addDocument));

export default router;
