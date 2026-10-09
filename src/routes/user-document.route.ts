import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { resolveOrganizationAllowingGuests } from "../middleware/resolve-organization.middleware";
import { documentCaseOf, guestItemNeedsCase, guestListNeedsCase } from "../middleware/guest-case-items.middleware";
import DocumentCtrl from "../controllers/document.controller";

const router = express.Router();

// Allows guests: a read-only share of a portfolio case reaches it here (see the middleware).
router.use(validSession, asyncHandler(resolveOrganizationAllowingGuests));
router.param("id", guestItemNeedsCase(documentCaseOf));

router.get("/", guestListNeedsCase, asyncHandler(DocumentCtrl.list));
router.get("/:id", asyncHandler(DocumentCtrl.getById));
router.get("/:id/text-preview", asyncHandler(DocumentCtrl.getTextPreview));
router.post("/presign", asyncHandler(DocumentCtrl.presign));
router.post("/", asyncHandler(DocumentCtrl.create));
router.patch("/:id", asyncHandler(DocumentCtrl.update));
router.delete("/:id", asyncHandler(DocumentCtrl.delete));
router.post("/:id/archive", asyncHandler(DocumentCtrl.archive));
router.post("/:id/unarchive", asyncHandler(DocumentCtrl.unarchive));
router.post("/archive", asyncHandler(DocumentCtrl.archiveMany));
router.post("/unarchive", asyncHandler(DocumentCtrl.unarchiveMany));
router.delete("/", asyncHandler(DocumentCtrl.deleteMany));

export default router;
