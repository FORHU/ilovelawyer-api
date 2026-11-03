import express from "express";
import multer from "multer";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import UsersCtrl from "../controllers/users.controller";
import LawyerProfileCtrl from "../controllers/lawyer-profile.controller";
import OrganizationCardCtrl from "../controllers/organization-card.controller";
import { freeCreditState } from "../middleware/free-credit.middleware";
import AccountLimitsSvc from "../services/account-limits.service";
import { AVATAR_MAX_BYTES } from "../constants";
import WalletCtrl from "../controllers/wallet.controller";

// In memory: AvatarSvc checks the bytes (type, size) before anything reaches S3.
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });

const router = express.Router();

router.use(validSession);

router.get("/me", asyncHandler(UsersCtrl.me));
// The account's free AI credit and what it has spent of it; { creditUsd: null } when it has none.
router.get(
  "/me/free-credit",
  asyncHandler(async (req, res) => res.json((await freeCreditState(req.user!.userId)) ?? { creditUsd: null })),
);
// The account's AI usage allowance (AccountLimitsSvc, account-level — cases aren't billed
// individually): only consumedPct is shown to the lawyer, never the dollar amount (product
// decision — a lawyer sees how much of their plan they've used, not a balance to watch drain);
// { limited: false } for an account with no allowance at all (not LAWYER-owned). trialEnded: locked
// because a solo lawyer's free trial is over and they don't subscribe; trialEndsAt is when it ends.
router.get(
  "/me/ai-allowance",
  asyncHandler(async (req, res) => {
    const { limited, locked, consumedPct, trialEnded, trialEndsAt } = await AccountLimitsSvc.allowanceInfo(req.user!.userId);
    res.json({ limited, locked, consumedPct, trialEnded, trialEndsAt });
  }),
);
router.patch("/me", asyncHandler(UsersCtrl.updateMe));
router.post("/me/change-password", asyncHandler(UsersCtrl.changePassword));
router.post("/me/export", asyncHandler(UsersCtrl.exportMe));
router.delete("/me", asyncHandler(UsersCtrl.deleteMe));
router.post("/me/cancel-deletion", asyncHandler(UsersCtrl.cancelDeletion));
router.put("/me/avatar", avatarUpload.single("avatar"), asyncHandler(UsersCtrl.uploadAvatar));
router.delete("/me/avatar", asyncHandler(UsersCtrl.removeAvatar));
router.post("/me/google-calendar", asyncHandler(UsersCtrl.connectGoogleCalendar));
router.delete("/me/google-calendar", asyncHandler(UsersCtrl.disconnectGoogleCalendar));
router.get("/me/tour/:track", asyncHandler(UsersCtrl.getTour));
// Account setup after sign-up (the app's /onboarding) is finished or skipped; sets setupCompletedAt.
router.post("/me/setup/complete", asyncHandler(UsersCtrl.completeSetup));
// The lawyer works solo: no organization is created (docs/adr/0022); sets soloChosenAt.
router.post("/me/solo", asyncHandler(UsersCtrl.chooseSolo));
// Verify before plan (PlanGateSvc): whether the app lets the lawyer in, waits for their
// application's verification, or asks them to choose a plan; and the plan step's "go on without
// paying" (a solo lawyer's free trial starts then).
router.get("/me/plan-gate", asyncHandler(UsersCtrl.planGate));
router.post("/me/plan-gate/start", asyncHandler(UsersCtrl.startWithoutPaying));
// A solo lawyer's own card on file and fee history (a firm's are under /organizations/:id/billing).
router.get("/me/billing/card", asyncHandler(OrganizationCardCtrl.getOwn));
router.post("/me/billing/card/setup-session", asyncHandler(OrganizationCardCtrl.startOwnSetup));
router.get("/me/billing/fees", asyncHandler(OrganizationCardCtrl.ownFees));
// A solo lawyer's own earnings from client quotations, and paying them out (a firm's are under
// /organizations/:id/wallet).
router.get("/me/wallet", asyncHandler(WalletCtrl.get));
router.get("/me/wallet/ledger", asyncHandler(WalletCtrl.ledger));
router.get("/me/wallet/earnings", asyncHandler(WalletCtrl.earnings));
router.get("/me/wallet/withdrawals", asyncHandler(WalletCtrl.withdrawals));
router.post("/me/wallet/withdrawals", asyncHandler(WalletCtrl.withdraw));
router.post("/me/wallet/payout-account/onboarding-link", asyncHandler(WalletCtrl.onboardingLink));
router.post("/me/wallet/payout-account/refresh", asyncHandler(WalletCtrl.refreshAccount));
router.put("/me/tour/:track", asyncHandler(UsersCtrl.saveTour));
// A lawyer's Lawyer Application (UK and PH; the path predates PH).
router.get("/me/client-request-profile", asyncHandler(LawyerProfileCtrl.get));
router.patch("/me/client-request-profile", asyncHandler(LawyerProfileCtrl.update));

export default router;
