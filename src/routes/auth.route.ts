import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import AuthCtrl from "../controllers/auth.controller";

const router = express.Router();

router.post("/signup", asyncHandler(AuthCtrl.signup));
router.post("/send-otp", asyncHandler(AuthCtrl.sendOtp));
router.post("/cancel-signup", asyncHandler(AuthCtrl.cancelSignup));
router.post("/verify-otp", asyncHandler(AuthCtrl.verifyOtp));
router.post("/login", asyncHandler(AuthCtrl.login));
router.post("/update-required-password", asyncHandler(AuthCtrl.updateRequiredPassword));
router.post("/refresh", asyncHandler(AuthCtrl.refresh));
router.post("/logout", asyncHandler(AuthCtrl.logout));
router.post("/google", asyncHandler(AuthCtrl.google));
router.post("/google/link", asyncHandler(AuthCtrl.googleLink));
router.post("/google/refresh", validSession, asyncHandler(AuthCtrl.refreshGoogleToken));
router.post("/forgot-password", asyncHandler(AuthCtrl.forgotPassword));
router.get("/reset-password/validate", asyncHandler(AuthCtrl.validateResetToken));
router.post("/reset-password", asyncHandler(AuthCtrl.resetPassword));
router.post("/login-link/consume", asyncHandler(AuthCtrl.consumeLoginLink));
// Desktop ↔ browser login handoff (see utils/handoff.ts).
router.post("/handoff", validSession, asyncHandler(AuthCtrl.issueHandoff));
router.post("/handoff/preview", asyncHandler(AuthCtrl.previewHandoff));
router.post("/handoff/consume", asyncHandler(AuthCtrl.consumeHandoff));

export default router;
