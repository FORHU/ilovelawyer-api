import express from "express";
import multer from "multer";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import UsersCtrl from "../controllers/users.controller";
import { AVATAR_MAX_BYTES } from "../constants";

// In memory: AvatarSvc checks the bytes (type, size) before anything reaches S3.
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });

const router = express.Router();

router.use(validSession);

router.get("/me", asyncHandler(UsersCtrl.me));
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
router.put("/me/tour/:track", asyncHandler(UsersCtrl.saveTour));

export default router;
