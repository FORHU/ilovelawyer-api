import express from "express";
import asyncHandler from "../utils/async-handler";
import SignupCtrl from "../controllers/signup.controller";
import LoginCtrl from "../controllers/login.controller";
import RefreshCtrl from "../controllers/refresh.controller";
import LogoutCtrl from "../controllers/logout.controller";

const router = express.Router();

router.post("/signup", asyncHandler(SignupCtrl.signup));
router.post("/login", asyncHandler(LoginCtrl.login));
router.post("/refresh", asyncHandler(RefreshCtrl.refresh));
router.post("/logout", asyncHandler(LogoutCtrl.logout));

export default router;
