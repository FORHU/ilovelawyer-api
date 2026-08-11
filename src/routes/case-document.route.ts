import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import DocumentChunkCtrl from "../controllers/document-chunk.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.get("/", asyncHandler(DocumentChunkCtrl.listByFilter));
router.get("/:caseDocumentId", asyncHandler(DocumentChunkCtrl.list));

export default router;
