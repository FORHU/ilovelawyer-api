import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import UsersCtrl from "../controllers/users.controller";

const router = express.Router();

router.use(validSession);

router.get("/me", asyncHandler(UsersCtrl.me));
router.patch("/me", asyncHandler(UsersCtrl.updateMe));
router.patch("/me/deactivate", asyncHandler(UsersCtrl.deactivateMe));
router.delete("/me", asyncHandler(UsersCtrl.deleteMe));

export default router;
