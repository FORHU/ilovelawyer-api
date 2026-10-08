import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ConsentCtrl from "../controllers/consent.controller";

const router = express.Router();

// Per user, not per organization: what someone agreed to follows them across workspaces.
router.use(validSession);

router.get("/", asyncHandler(ConsentCtrl.list));
router.put("/:purpose", asyncHandler(ConsentCtrl.set));

export default router;
