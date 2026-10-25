import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ClientPricingSvc from "../services/client-pricing.service";
import OrganizationChargeSvc from "../services/organization-charge.service";

// Billing reads that belong to no one organization (#516). A firm's own billing is under
// /organizations/:id/billing, a solo lawyer's under /users/me/billing.
const router = express.Router();

router.use(validSession);

// The AI top-up packs an engaged lawyer can buy (POST /client-requests/:id/ai-top-ups): their
// region's, set in admin (#598).
router.get(
  "/top-up-packs",
  asyncHandler(async (req, res) => {
    const tenantId = await ClientPricingSvc.tenantIdForClient(req.user.userId);
    res.status(200).json(await OrganizationChargeSvc.topUpPacks(tenantId));
  }),
);

export default router;
