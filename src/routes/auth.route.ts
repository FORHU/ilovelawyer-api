import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import AuthCtrl from "../controllers/auth.controller";

const router = express.Router();

router.post("/signup", asyncHandler(AuthCtrl.signup));
router.post("/login", asyncHandler(AuthCtrl.login));
router.post("/refresh", asyncHandler(AuthCtrl.refresh));
router.post("/logout", asyncHandler(AuthCtrl.logout));
router.post("/google", asyncHandler(AuthCtrl.google));
router.post("/google/refresh", validSession, asyncHandler(AuthCtrl.refreshGoogleToken));
router.post("/forgot-password", asyncHandler(AuthCtrl.forgotPassword));
router.get("/reset-password/validate", asyncHandler(AuthCtrl.validateResetToken));
router.post("/reset-password", asyncHandler(AuthCtrl.resetPassword));

export default router;
