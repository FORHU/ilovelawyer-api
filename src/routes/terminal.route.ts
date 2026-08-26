import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import TerminalWorkspaceCtrl from "../controllers/terminal-workspace.controller";
import CaseTerminalCtrl from "../controllers/case-terminal.controller";

const router = express.Router();

// resolveOrganization added so /procedure-rules can resolve the caller's tenant jurisdiction
// (see CaseTerminalCtrl.procedureRules) — the frontend already sends X-Organization-Id on
// every authenticated request once an org is active, so this is a no-op for the other routes.
router.use(validSession, asyncHandler(resolveOrganization));

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
