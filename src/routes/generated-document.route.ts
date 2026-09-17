import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import GeneratedDocumentCtrl from "../controllers/generated-document.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.post("/", asyncHandler(GeneratedDocumentCtrl.create));

export default router;
