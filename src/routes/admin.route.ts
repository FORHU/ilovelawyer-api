import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireAdmin from "../middleware/require-admin.middleware";
import AdminCtrl from "../controllers/admin.controller";
import SecurityAuditCtrl from "../controllers/security-audit.controller";
import LlmUsageCtrl from "../controllers/llm-usage.controller";
import ClientBillingAdminCtrl from "../controllers/client-billing-admin.controller";

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

router.post("/lawyers/:id/verify", asyncHandler(AdminCtrl.verifyLawyer));
router.post("/lawyers/:id/reject", asyncHandler(AdminCtrl.rejectLawyer));

router.get("/settings", asyncHandler(AdminCtrl.getSettings));
router.patch("/settings/tenants/:code", asyncHandler(AdminCtrl.updateTenantSettings));
router.post("/tenants/:code/approve-pending", asyncHandler(AdminCtrl.approvePending));

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

export default router;
