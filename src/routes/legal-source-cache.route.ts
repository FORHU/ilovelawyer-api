import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import LegalSourceCacheCtrl from "../controllers/legal-source-cache.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.post("/", asyncHandler(LegalSourceCacheCtrl.analyze));

export default router;
