import express from "express";
import asyncHandler from "../utils/async-handler";
import HealthCtrl from "../controllers/health.controller";

const router = express.Router();

router.get("/", asyncHandler(HealthCtrl.check));

export default router;
