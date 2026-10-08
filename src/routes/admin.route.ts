import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireAdmin from "../middleware/require-admin.middleware";
import AdminCtrl from "../controllers/admin.controller";

const router = express.Router();

router.use(validSession, requireAdmin);

router.get("/users", asyncHandler(AdminCtrl.listUsers));
router.get("/audit-events", asyncHandler(AdminCtrl.listAuditEvents));

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

router.get("/settings", asyncHandler(AdminCtrl.getSettings));
router.patch("/settings/tenants/:code", asyncHandler(AdminCtrl.updateTenantSettings));
router.post("/tenants/:code/approve-pending", asyncHandler(AdminCtrl.approvePending));

export default router;
