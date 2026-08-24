import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import ModelSettingsCtrl from "../controllers/model-settings.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.get("/", asyncHandler(ModelSettingsCtrl.list));
router.put("/:toolName", asyncHandler(ModelSettingsCtrl.update));

export default router;
