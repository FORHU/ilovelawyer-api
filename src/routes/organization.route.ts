import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import OrganizationCtrl from "../controllers/organization.controller";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(OrganizationCtrl.create));
router.get("/", asyncHandler(OrganizationCtrl.list));
router.get("/:id", asyncHandler(OrganizationCtrl.getById));
router.post("/:id/members", asyncHandler(OrganizationCtrl.addMember));
router.delete("/:id/members/:userId", asyncHandler(OrganizationCtrl.removeMember));
router.post("/:id/cases", asyncHandler(OrganizationCtrl.attachCase));

export default router;
