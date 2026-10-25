import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireAdmin from "../middleware/require-admin.middleware";
import AdminCtrl from "../controllers/admin.controller";
import SecurityAuditCtrl from "../controllers/security-audit.controller";
import LlmUsageCtrl from "../controllers/llm-usage.controller";
import ClientBillingAdminCtrl from "../controllers/client-billing-admin.controller";
import ClientRequestAdminCtrl from "../controllers/client-request-admin.controller";
import ClientPricingAdminCtrl from "../controllers/client-pricing-admin.controller";
import LawyerPricingAdminCtrl from "../controllers/lawyer-pricing-admin.controller";

const router = express.Router();

router.use(validSession, requireAdmin);

router.get("/users", asyncHandler(AdminCtrl.listUsers));
router.get("/audit-events", asyncHandler(AdminCtrl.listAuditEvents));
router.get("/feedback", asyncHandler(AdminCtrl.listFeedback));

router.get("/law/search", asyncHandler(AdminCtrl.searchLaw));
router.get("/law", asyncHandler(AdminCtrl.listLaw));

router.post("/users/:id/export", asyncHandler(AdminCtrl.exportUserData));
router.post("/users/:id/approve", asyncHandler(AdminCtrl.approveUser));
router.post("/users/:id/deny", asyncHandler(AdminCtrl.denyUser));
router.post("/users/:id/reactivate", asyncHandler(AdminCtrl.reactivateUser));
router.post("/users/:id/block", asyncHandler(AdminCtrl.blockUser));
router.post("/users/:id/unblock", asyncHandler(AdminCtrl.unblockUser));
router.post("/users/:id/verify-email", asyncHandler(AdminCtrl.verifyUserEmail));
router.patch("/users/:id/tenant", asyncHandler(AdminCtrl.changeUserTenant));
router.delete("/users/:id", asyncHandler(AdminCtrl.deleteUser));

router.get("/lawyer-verifications", asyncHandler(AdminCtrl.listLawyerVerifications));
router.post("/lawyer-verifications/:userId/verify", asyncHandler(AdminCtrl.verifyLawyer));
router.post("/lawyer-verifications/:userId/reject", asyncHandler(AdminCtrl.rejectLawyer));

router.get("/settings", asyncHandler(AdminCtrl.getSettings));
router.patch("/settings/tenants/:code", asyncHandler(AdminCtrl.updateTenantSettings));
router.get("/settings/tenants/:code/payment-plans", asyncHandler(AdminCtrl.listPaymentPlans));
router.post("/settings/tenants/:code/payment-plans", asyncHandler(AdminCtrl.createPaymentPlan));
router.patch("/settings/tenants/:code/payment-plans/:planId", asyncHandler(AdminCtrl.updatePaymentPlan));
router.delete("/settings/tenants/:code/payment-plans/:planId", asyncHandler(AdminCtrl.deactivatePaymentPlan));
router.post("/tenants/:code/approve-pending", asyncHandler(AdminCtrl.approvePending));

// The client app's per-tenant prices and promo codes (ClientPricingSvc).
router.get("/settings/client-pricing", asyncHandler(ClientPricingAdminCtrl.get));
router.patch("/settings/tenants/:code/client-pricing/case", asyncHandler(ClientPricingAdminCtrl.updateCase));
router.post("/settings/tenants/:code/client-pricing/packs", asyncHandler(ClientPricingAdminCtrl.createPack));
router.patch("/settings/client-pricing/packs/:id", asyncHandler(ClientPricingAdminCtrl.updatePack));
router.post("/settings/client-pricing/packs/:id/default", asyncHandler(ClientPricingAdminCtrl.setDefaultPack));
router.post("/settings/tenants/:code/client-promos", asyncHandler(ClientPricingAdminCtrl.createPromo));
router.patch("/settings/client-promos/:id", asyncHandler(ClientPricingAdminCtrl.updatePromo));
// What lawyers pay per tenant: the introduction fee and the AI top-up packs (LawyerPricingSvc, #598).
router.get("/settings/lawyer-pricing", asyncHandler(LawyerPricingAdminCtrl.get));
router.patch("/settings/tenants/:code/lawyer-pricing/intro-fee", asyncHandler(LawyerPricingAdminCtrl.updateIntroFee));
router.post("/settings/tenants/:code/lawyer-pricing/packs", asyncHandler(LawyerPricingAdminCtrl.createPack));
router.patch("/settings/lawyer-pricing/packs/:id", asyncHandler(LawyerPricingAdminCtrl.updatePack));

router.get("/audit-log", asyncHandler(SecurityAuditCtrl.listForAdmin));
router.get("/audit-log/export", asyncHandler(SecurityAuditCtrl.exportForAdmin));

router.get("/llm-usage/summary", asyncHandler(LlmUsageCtrl.summary));
router.get("/llm-usage/people", asyncHandler(LlmUsageCtrl.people));
router.get("/llm-usage", asyncHandler(LlmUsageCtrl.list));

router.get("/billing/summary", asyncHandler(ClientBillingAdminCtrl.summary));
router.get("/billing/clients/:userId", asyncHandler(ClientBillingAdminCtrl.client));
router.get("/billing", asyncHandler(ClientBillingAdminCtrl.list));
router.get("/billing/:id", asyncHandler(ClientBillingAdminCtrl.get));
router.post("/billing/:id/refund", asyncHandler(ClientBillingAdminCtrl.refund));

// The UK client-to-lawyer hand-off: requests, the firms' fees, and refunds of them (#520).
router.get("/client-requests/fees-summary", asyncHandler(ClientRequestAdminCtrl.feesSummary));
router.get("/client-requests", asyncHandler(ClientRequestAdminCtrl.listRequests));
router.get("/charges/:chargeId", asyncHandler(ClientRequestAdminCtrl.getCharge));
router.post("/charges/:chargeId/refund", asyncHandler(ClientRequestAdminCtrl.refundCharge));

export default router;
