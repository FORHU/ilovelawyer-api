import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import IntakeCaseCtrl from "../controllers/intake-case.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.patch("/:caseId", asyncHandler(IntakeCaseCtrl.update));

export default router;
