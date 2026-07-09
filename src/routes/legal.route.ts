import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import LegalRagCtrl from "../controllers/legal-rag.controller";

const router = express.Router();

router.use(validSession);

router.get("/case/:itemId", asyncHandler(LegalRagCtrl.getSourcePageDoc));

export default router;
