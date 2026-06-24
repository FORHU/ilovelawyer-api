import express from "express";
import asyncHandler from "../utils/async-handler";
import AuthCtrl from "../controllers/auth.controller";

const router = express.Router();

router.post("/signup", asyncHandler(AuthCtrl.signup));
router.post("/login", asyncHandler(AuthCtrl.login));
router.post("/refresh", asyncHandler(AuthCtrl.refresh));
router.post("/logout", asyncHandler(AuthCtrl.logout));
router.post("/google", asyncHandler(AuthCtrl.google));

export default router;
