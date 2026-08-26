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

router.get("/case/:itemId", asyncHandler(LegalRagCtrl.getSourcePageDoc));
router.get("/search", asyncHandler(LegalRagCtrl.search));

export default router;
