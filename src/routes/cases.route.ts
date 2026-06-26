import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import CasesCtrl from "../controllers/cases.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(CasesCtrl.list));
router.get("/:id", asyncHandler(CasesCtrl.getById));

export default router;
