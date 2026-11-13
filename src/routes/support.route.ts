import express from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../utils/async-handler";
import SupportContentCtrl from "../controllers/support-content.controller";
import SupportActionCtrl from "../controllers/support-action.controller";
import SupportTicketCtrl from "../controllers/support-ticket.controller";

/** The Support Chat for people who aren't signed in: no session. */
const router = express.Router();

const publicContentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { message: "Too many requests. Try again in a minute." },
});

// A visitor's reset or code request sends an email, so it's limited twice: per address (whoever it is,
// so a refusal says nothing about the account) and per IP.
const VISITOR_ACTION_WINDOW_MS = 15 * 60 * 1000;
const visitorActionIpLimiter = rateLimit({
  windowMs: VISITOR_ACTION_WINDOW_MS,
  max: 60,
  message: { message: "Too many requests. Try again in a few minutes." },
});
const visitorActionEmailLimiter = rateLimit({
  windowMs: VISITOR_ACTION_WINDOW_MS,
  max: 5,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `${req.params.key}:${email || `no-email:${req.ip}`}`;
  },
  message: { message: "Too many requests for that email address. Try again in a few minutes." },
});

router.get("/content", publicContentLimiter, asyncHandler(SupportContentCtrl.forVisitor));
router.post("/actions/:key", visitorActionIpLimiter, visitorActionEmailLimiter, asyncHandler(SupportActionCtrl.runForVisitor));

// A visitor's ticket sends nobody an email but costs an admin's time, so it needs the captcha and is limited
// twice: per IP, and per address (counted only once the captcha passes, so nobody can use up another
// person's allowance). A refusal is the same for any address.
const visitorTicketIpLimiter = rateLimit({
  windowMs: VISITOR_ACTION_WINDOW_MS,
  max: 30,
  message: { message: "Too many requests. Try again in a few minutes." },
});
const visitorTicketEmailLimiter = rateLimit({
  windowMs: VISITOR_ACTION_WINDOW_MS,
  max: 3,
  keyGenerator: (req) => `ticket:${typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : `no-email:${req.ip}`}`,
  message: { message: "Too many requests for that email address. Try again in a few minutes." },
});
const visitorOutcomeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { message: "Too many requests. Try again in a minute." },
});

router.post("/tickets", visitorTicketIpLimiter, asyncHandler(SupportTicketCtrl.checkVisitorTicket), visitorTicketEmailLimiter, asyncHandler(SupportTicketCtrl.openVisitorTicket));
router.post("/outcomes", visitorOutcomeLimiter, asyncHandler(SupportTicketCtrl.recordOutcomes));

export default router;
