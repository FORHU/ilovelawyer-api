import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import LegalRagCtrl from "../controllers/legal-rag.controller";

const router = express.Router();

router.use(validSession);

router.get("/categories", asyncHandler(LegalRagCtrl.categories));
router.post("/search-vector", asyncHandler(LegalRagCtrl.vectorSearch));
router.post("/format-documents", asyncHandler(LegalRagCtrl.formatDocuments));
router.get("/", asyncHandler(LegalRagCtrl.list));
router.get("/:id/related", asyncHandler(LegalRagCtrl.getRelated));
router.post("/:id/format", asyncHandler(LegalRagCtrl.formatDocument));
router.get("/:id", asyncHandler(LegalRagCtrl.getById));

export default router;
