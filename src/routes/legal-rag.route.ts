import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import LegalRagCtrl from "../controllers/legal-rag.controller";

const router = express.Router();

// resolveOrganization added so these endpoints can resolve the caller's tenant jurisdiction
// and select the correct LegalKnowledgeProvider — never falling back to the PH corpus for a
// non-PH org (see legal/legal-knowledge.registry.ts).
router.use(validSession, asyncHandler(resolveOrganization));

router.get("/categories", asyncHandler(LegalRagCtrl.categories));
router.get("/library-sections", asyncHandler(LegalRagCtrl.librarySections));
router.post("/search-vector", asyncHandler(LegalRagCtrl.vectorSearch));
router.post("/format-documents", asyncHandler(LegalRagCtrl.formatDocuments));
router.get("/", asyncHandler(LegalRagCtrl.list));
router.get("/:id/related", asyncHandler(LegalRagCtrl.getRelated));
router.post("/:id/format", asyncHandler(LegalRagCtrl.formatDocument));
router.get("/:id", asyncHandler(LegalRagCtrl.getById));

export default router;
