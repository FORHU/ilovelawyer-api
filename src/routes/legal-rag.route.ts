import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import LegalRagCtrl from "../controllers/legal-rag.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(LegalRagCtrl.list));
router.get("/:id", asyncHandler(LegalRagCtrl.getById));

export default router;
