import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import LegalRagCtrl from "../controllers/legalRag.controller";

const router = express.Router();

router.use(validSession);

router.get("/documents", asyncHandler(LegalRagCtrl.listDocuments));

export default router;
