import express from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/async-handler";
import SupportContentCtrl from "../controllers/support-content.controller";

/** The Support Chat for people who aren't signed in: no session. */
const router = express.Router();

const publicContentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { message: "Too many requests. Try again in a minute." },
});

router.get("/content", publicContentLimiter, asyncHandler(SupportContentCtrl.forVisitor));

export default router;
