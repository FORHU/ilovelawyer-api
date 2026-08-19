import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import CaseCtrl from "../controllers/case.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.post("/", asyncHandler(CaseCtrl.create));
router.get("/", asyncHandler(CaseCtrl.list));
router.get("/:id", asyncHandler(CaseCtrl.getById));
router.patch("/:id", asyncHandler(CaseCtrl.update));
router.delete("/:id", asyncHandler(CaseCtrl.delete));

/**
 *  UI routes for user document management.
 *   1. Request a presigned URL for uploading a document to S3.
 *   2. Create case
 *   3. upload document to S3 using the presigned URL.
 *   4. Create a document record in the database after the file has been uploaded to S3.
 *
 * 
 */

router.post("/:caseId/documents", asyncHandler(CaseCtrl.handleCreateCaseWithDocument));
router.post("/:caseId/relevant-chunks", asyncHandler(CaseCtrl.relevantChunks));

export default router;
