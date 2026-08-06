import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import CaseDocumentCtrl from "../controllers/case-document.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(CaseDocumentCtrl.list));
router.get("/:id", asyncHandler(CaseDocumentCtrl.getById));
router.post("/presign", asyncHandler(CaseDocumentCtrl.presign));
router.post("/", asyncHandler(CaseDocumentCtrl.create));
router.patch("/:id", asyncHandler(CaseDocumentCtrl.update));
router.delete("/:id", asyncHandler(CaseDocumentCtrl.delete));

export default router;
