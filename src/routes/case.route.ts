import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import CaseCtrl from "../controllers/case.controller";
import CaseTerminalCtrl from "../controllers/case-terminal.controller";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(CaseCtrl.create));
router.get("/", asyncHandler(CaseCtrl.list));
router.get("/:id", asyncHandler(CaseCtrl.getById));
router.patch("/:id", asyncHandler(CaseCtrl.update));
router.delete("/:id", asyncHandler(CaseCtrl.delete));

/**
 *  UI routes for user document management.
 *   1. Request a presigned URL for uploading a document to S3.
 *   2. Create case
 *   3. upload document to S3 using the presigned URL.
 *   4. Create a document record in the database after the file has been uploaded to S3.
 *
 * 
 */

router.post("/:caseId/documents", asyncHandler(CaseCtrl.handleCreateCaseWithDocument));
router.post("/:caseId/relevant-chunks", asyncHandler(CaseCtrl.relevantChunks));

router.get("/:caseId/snapshot", asyncHandler(CaseTerminalCtrl.snapshot));
router.post("/:caseId/refresh", asyncHandler(CaseTerminalCtrl.refresh));

router.get("/:caseId/timeline", asyncHandler(CaseTerminalCtrl.listTimeline));
router.post("/:caseId/timeline", asyncHandler(CaseTerminalCtrl.createTimeline));
router.patch("/:caseId/timeline/:id", asyncHandler(CaseTerminalCtrl.updateTimeline));
router.delete("/:caseId/timeline/:id", asyncHandler(CaseTerminalCtrl.deleteTimeline));

router.get("/:caseId/risks", asyncHandler(CaseTerminalCtrl.listRisks));
router.post("/:caseId/risks", asyncHandler(CaseTerminalCtrl.createRisk));
router.patch("/:caseId/risks/:id", asyncHandler(CaseTerminalCtrl.updateRisk));
router.delete("/:caseId/risks/:id", asyncHandler(CaseTerminalCtrl.deleteRisk));

router.get("/:caseId/evidence", asyncHandler(CaseTerminalCtrl.evidence));
router.put("/:caseId/evidence/matrix/:documentId", asyncHandler(CaseTerminalCtrl.upsertMatrix));
router.post("/:caseId/evidence/contradictions/scan", asyncHandler(CaseTerminalCtrl.scanContradictions));
router.get("/:caseId/evidence/traces/:documentId", asyncHandler(CaseTerminalCtrl.traces));

router.get("/:caseId/citations", asyncHandler(CaseTerminalCtrl.listCitations));
router.post("/:caseId/citations", asyncHandler(CaseTerminalCtrl.checkCitation));

router.get("/:caseId/procedure", asyncHandler(CaseTerminalCtrl.procedure));
router.post("/:caseId/procedure/deadlines", asyncHandler(CaseTerminalCtrl.createDeadline));
router.post("/:caseId/procedure/deadlines/:deadlineId/confirm", asyncHandler(CaseTerminalCtrl.confirmDeadline));
router.post("/:caseId/procedure/items", asyncHandler(CaseTerminalCtrl.createProcedureItem));
router.patch("/:caseId/procedure/items/:id", asyncHandler(CaseTerminalCtrl.updateProcedureItem));

router.get("/:caseId/team", asyncHandler(CaseTerminalCtrl.teamAudit));
router.post("/:caseId/access", asyncHandler(CaseTerminalCtrl.grantAccess));

router.get("/:caseId/findings", asyncHandler(CaseTerminalCtrl.listFindings));
router.post("/:caseId/findings", asyncHandler(CaseTerminalCtrl.createFinding));
router.patch("/:caseId/findings/:id", asyncHandler(CaseTerminalCtrl.updateFinding));
router.delete("/:caseId/findings/:id", asyncHandler(CaseTerminalCtrl.deleteFinding));

router.get("/:caseId/witnesses", asyncHandler(CaseTerminalCtrl.listWitnesses));
router.post("/:caseId/witnesses", asyncHandler(CaseTerminalCtrl.createWitness));
router.patch("/:caseId/witnesses/:id", asyncHandler(CaseTerminalCtrl.updateWitness));
router.delete("/:caseId/witnesses/:id", asyncHandler(CaseTerminalCtrl.deleteWitness));

router.get("/:caseId/damages", asyncHandler(CaseTerminalCtrl.listDamages));
router.post("/:caseId/damages", asyncHandler(CaseTerminalCtrl.createDamage));
router.patch("/:caseId/damages/:id", asyncHandler(CaseTerminalCtrl.updateDamage));
router.delete("/:caseId/damages/:id", asyncHandler(CaseTerminalCtrl.deleteDamage));

router.get("/:caseId/reconstruction", asyncHandler(CaseTerminalCtrl.getReconstruction));
router.post("/:caseId/reconstruction/generate", asyncHandler(CaseTerminalCtrl.generateReconstruction));
router.patch("/:caseId/reconstruction", asyncHandler(CaseTerminalCtrl.updateReconstruction));

export default router;
