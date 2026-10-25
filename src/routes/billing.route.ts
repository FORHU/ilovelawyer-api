import express from "express";
import validSession from "../middleware/valid-session.middleware";
import OrganizationChargeSvc from "../services/organization-charge.service";

// Billing reads that belong to no one organization (#516). A firm's own billing is under
// /organizations/:id/billing, a solo lawyer's under /users/me/billing.
const router = express.Router();

router.use(validSession);

// The AI top-up packs an engaged lawyer can buy (POST /client-requests/:id/ai-top-ups).
router.get("/top-up-packs", (_req, res) => {
  res.status(200).json(OrganizationChargeSvc.topUpPacks());
});

export default router;
