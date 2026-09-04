import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import LawCtrl from "../controllers/law.controller";

const router = express.Router();

// resolveOrganization so the handler can read the caller's tenantCode and keep juris.ph
// (Philippine-law only) PH-tenant scoped — see law.controller.ts / legal-rag.route.ts.
router.use(validSession, asyncHandler(resolveOrganization));

router.get("/search", asyncHandler(LawCtrl.search));
router.get("/browse", asyncHandler(LawCtrl.browse));
router.get("/document", asyncHandler(LawCtrl.getDocument));

export default router;
