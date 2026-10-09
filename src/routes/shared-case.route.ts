import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import SharedCaseCtrl from "../controllers/shared-case.controller";

const router = express.Router();

// No X-Organization-Id: these cases live in other people's portfolios, not the caller's workspace.
router.use(validSession);

router.get("/", asyncHandler(SharedCaseCtrl.list));
router.delete("/:caseId", asyncHandler(SharedCaseCtrl.leave));

export default router;
