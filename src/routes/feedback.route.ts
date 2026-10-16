import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import FeedbackCtrl from "../controllers/feedback.controller";

const router = express.Router();

// Per user, not per organization, like consents: feedback can come from any page.
router.use(validSession);

router.post("/", asyncHandler(FeedbackCtrl.submit));

export default router;
