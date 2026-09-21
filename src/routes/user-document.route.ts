import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import DocumentCtrl from "../controllers/document.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.get("/", asyncHandler(DocumentCtrl.list));
router.get("/:id", asyncHandler(DocumentCtrl.getById));
router.get("/:id/text-preview", asyncHandler(DocumentCtrl.getTextPreview));
router.post("/presign", asyncHandler(DocumentCtrl.presign));
router.post("/", asyncHandler(DocumentCtrl.create));
router.patch("/:id", asyncHandler(DocumentCtrl.update));
router.delete("/:id", asyncHandler(DocumentCtrl.delete));
router.post("/:id/archive", asyncHandler(DocumentCtrl.archive));
router.post("/:id/unarchive", asyncHandler(DocumentCtrl.unarchive));
router.post("/unarchive", asyncHandler(DocumentCtrl.unarchiveMany));

export default router;
