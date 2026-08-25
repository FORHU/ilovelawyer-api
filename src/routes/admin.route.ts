import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import requireAdmin from "../middleware/require-admin.middleware";
import AdminCtrl from "../controllers/admin.controller";

const router = express.Router();

router.use(validSession, requireAdmin);

router.get("/users", asyncHandler(AdminCtrl.listUsers));
router.post("/users/:id/approve", asyncHandler(AdminCtrl.approveUser));
router.post("/users/:id/deny", asyncHandler(AdminCtrl.denyUser));

export default router;
