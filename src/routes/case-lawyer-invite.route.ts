import express from "express";
import asyncHandler from "../utils/async-handler";
import CaseLawyerInviteCtrl from "../controllers/case-lawyer-invite.controller";

/** The client app's own-lawyer invites (client-invites-own-lawyer). Mounted from client.route.ts
 * at /lawyer-invites, under the same validSession + requireClientAccount as the rest of that
 * router. */
const router = express.Router();

router.get("/", asyncHandler(CaseLawyerInviteCtrl.getCurrent));
router.post("/link", asyncHandler(CaseLawyerInviteCtrl.createLink));
router.post("/email", asyncHandler(CaseLawyerInviteCtrl.createEmail));
router.post("/revoke", asyncHandler(CaseLawyerInviteCtrl.revoke));

export default router;
