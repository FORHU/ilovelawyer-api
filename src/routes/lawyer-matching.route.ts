import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import LawyerMatchingCtrl from "../controllers/lawyer-matching.controller";

const router = express.Router();

router.use(apiKeyMiddleware);

router.post("/by-criteria", asyncHandler(LawyerMatchingCtrl.byCriteria));

export default router;
