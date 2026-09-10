import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import LawCtrl from "../controllers/law.controller";

const router = express.Router();

// PUBLIC (before validSession): a same-origin proxy for a stored law's official PDF. Legislation
// (legislation.gov.uk) and TNA judgments both send X-Frame-Options: DENY, so the browser can't
// iframe them directly — this re-serves the bytes from our origin. lawId-scoped (no user-supplied
// URL) so it can only ever fetch the PDF of a document we already store. The content is public
// primary law, so no auth; it can't leak anything a `View source` link wouldn't.
router.get("/:lawId/pdf", asyncHandler(LawCtrl.pdf));

// resolveOrganization so the handler can read the caller's tenantCode and keep juris.ph
// (Philippine-law only) PH-tenant scoped — see law.controller.ts / legal-rag.route.ts.
router.use(validSession, asyncHandler(resolveOrganization));

router.get("/search", asyncHandler(LawCtrl.search));
router.get("/browse", asyncHandler(LawCtrl.browse));
router.get("/document", asyncHandler(LawCtrl.getDocument));

router.post("/:lawId/citations/expand", asyncHandler(LawCtrl.expandCitations));
router.get("/:lawId/citations", asyncHandler(LawCtrl.getCitations));

export default router;
