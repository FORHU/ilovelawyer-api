import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import CaseCtrl from "../controllers/case.controller";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(CaseCtrl.create));
router.get("/", asyncHandler(CaseCtrl.list));
router.get("/:id", asyncHandler(CaseCtrl.getById));
router.patch("/:id", asyncHandler(CaseCtrl.update));
router.delete("/:id", asyncHandler(CaseCtrl.delete));

export default router;
