import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import TerminalWorkspaceCtrl from "../controllers/terminal-workspace.controller";
import CaseTerminalCtrl from "../controllers/case-terminal.controller";

const router = express.Router();

router.use(validSession);

router.get("/catalog", asyncHandler(TerminalWorkspaceCtrl.catalog));
router.get("/metrics", asyncHandler(TerminalWorkspaceCtrl.metrics));
router.get("/procedure-rules", asyncHandler(CaseTerminalCtrl.procedureRules));
router.get("/workspaces", asyncHandler(TerminalWorkspaceCtrl.list));
router.post("/workspaces", asyncHandler(TerminalWorkspaceCtrl.create));
router.post("/workspaces/reset", asyncHandler(TerminalWorkspaceCtrl.reset));
router.get("/workspaces/:id", asyncHandler(TerminalWorkspaceCtrl.getById));
router.patch("/workspaces/:id", asyncHandler(TerminalWorkspaceCtrl.update));
router.post("/workspaces/:id/apply", asyncHandler(TerminalWorkspaceCtrl.apply));
router.delete("/workspaces/:id", asyncHandler(TerminalWorkspaceCtrl.delete));

export default router;
