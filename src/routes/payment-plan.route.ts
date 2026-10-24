import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import PaymentPlanBillingCtrl from "../controllers/payment-plan-billing.controller";

const router = express.Router();

// Scoped entirely to req.user.userId (the logged-in lawyer's own plan) — no case involved, so
// accountSpendLimit never gates these: a read-only account can still choose a plan.
router.use(validSession);

router.get("/", asyncHandler(PaymentPlanBillingCtrl.options));
router.post("/checkout", asyncHandler(PaymentPlanBillingCtrl.startCheckout));
router.get("/checkout/:subscriptionId", asyncHandler(PaymentPlanBillingCtrl.status));

export default router;
