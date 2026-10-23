import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import AccountTopUpCtrl from "../controllers/account-topup.controller";

const router = express.Router();

// Scoped entirely to req.user.userId (the logged-in lawyer topping up their own account) — no case
// involved, so there's nothing case-scoped for accountSpendLimit to gate here in the first place.
router.use(validSession);

router.post("/quote", asyncHandler(AccountTopUpCtrl.quote));
router.post("/checkout", asyncHandler(AccountTopUpCtrl.startCheckout));
router.get("/:topUpId", asyncHandler(AccountTopUpCtrl.status));

export default router;
