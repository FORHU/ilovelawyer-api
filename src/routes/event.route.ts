import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import EventCtrl from "../controllers/event.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.get("/", asyncHandler(EventCtrl.list));
router.get("/:id", asyncHandler(EventCtrl.getById));
router.post("/", asyncHandler(EventCtrl.create));
router.put("/:id", asyncHandler(EventCtrl.updateById));
router.put("/by-google-id/:googleEventId", asyncHandler(EventCtrl.updateByGoogleEventId));
router.delete("/:id", asyncHandler(EventCtrl.deleteById));
router.delete("/by-google-id/:googleEventId", asyncHandler(EventCtrl.deleteByGoogleEventId));

export default router;
