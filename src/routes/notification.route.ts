import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import NotificationCtrl from "../controllers/notification.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.get("/", asyncHandler(NotificationCtrl.list));
router.get("/unread-count", asyncHandler(NotificationCtrl.unreadCount));
router.put("/read-all", asyncHandler(NotificationCtrl.markAllRead));
router.put("/:id/read", asyncHandler(NotificationCtrl.markRead));

export default router;
