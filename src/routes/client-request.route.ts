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

export default router;
