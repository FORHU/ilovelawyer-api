import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import CaseDocumentChunkCtrl from "../controllers/case-document-chunk.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.get("/:caseDocumentId", asyncHandler(CaseDocumentChunkCtrl.list));

export default router;
