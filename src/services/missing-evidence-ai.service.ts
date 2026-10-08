import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import MissingEvidenceRepo, { AiMissingEvidenceRow } from "../repositories/missing-evidence.repository";
import { MissingEvidenceStatus } from "@prisma/client";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { getMissingEvidencePromptBuilder } from "../legal/prompt-registry";
import { extractMissingEvidence } from "../utils/missing-evidence-parse";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import { MissingEvidencePromptClaim } from "../constants/missing-evidence.constants";
import AiGenerationLockSvc from "./ai-generation-lock.service";

/** What the case's documents don't yet establish, as rows a lawyer can work through — the
 * structured replacement for CaseReconstruction.gaps (a flat String[] that named gaps in prose
 * and tied them to nothing). Mirrors CaseFindingAiSvc's prompt->parse->replace-AI-rows shape. */
export default class MissingEvidenceAiSvc {
  /** Unqueued generate, holding the "missingEvidence" lock — the analysis refresh's step. */
  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "missingEvidence", () => MissingEvidenceAiSvc.generateInner(caseId));
  }

  /** Fast, synchronous half of the pane's own Regenerate — access check + claiming the job row —
   * so a 403/409 surfaces before the enqueue rather than inside the worker. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    // A pane's own Regenerate never overlaps the case analysis (ADR 0018).
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "missingEvidence");
  }

  /** Run by AiGenerationQueue's worker after beginQueued claimed the job row. */
  static async runQueued(caseId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "missingEvidence", () => MissingEvidenceAiSvc.generateInner(caseId));
  }

  /** The lawyer's triage on one gap. */
  static async update(
    caseId: string,
    id: string,
    userId: string,
    data: { status: MissingEvidenceStatus; resolutionNote?: string | null },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await MissingEvidenceRepo.updateStatus(id, caseId, {
      status: data.status,
      resolutionNote: data.resolutionNote?.trim() || null,
      resolvedById: userId,
    });
    if (!row) throw new HttpError("Missing-evidence item not found", 404);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "evidence.missing.status",
      payload: { id, status: data.status },
    });
    return row;
  }

  private static async generateInner(caseId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return MissingEvidenceRepo.list(caseId);

    // C1…Cn in a stable order, so the handle the model cites maps back to a real claim — the
    // same reason document handles exist (see case-document-handles.ts).
    const claims = await CaseClaimRepo.list(caseId);
    const byHandle = new Map(claims.map((claim, i) => [`C${i + 1}`, claim.id]));
    const promptClaims: MissingEvidencePromptClaim[] = [...byHandle].map(([handle], i) => ({
      handle,
      title: claims[i].title,
    }));

    const buildPrompt = getMissingEvidencePromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildPrompt(ready, promptClaims, ukJurisdiction)}

${wrapExtractedText("Use only these excerpts and the attached case documents.", pack.text)}
`;

    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("missingEvidence", caseId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
    }

    const parsed = extractMissingEvidence(String(result.content || ""));
    logger.info("Chat Wonder missing-evidence reply", {
      caseId,
      readyCount: ready.length,
      claimCount: claims.length,
      chunkCount: pack.chunkIds.length,
      itemCount: parsed?.length ?? null,
    });
    // An unparseable reply leaves the case with the rows it already had, rather than wiping them.
    if (!parsed) return MissingEvidenceRepo.list(caseId);

    const rows: AiMissingEvidenceRow[] = parsed.map((item) => ({
      label: item.label,
      detail: item.detail,
      suggestedSource: item.suggestedSource,
      // Only a handle naming a claim on this case is kept — a garbled or invented one is dropped
      // to a case-wide gap rather than pointing the row at nothing.
      claimId: (item.claimHandle && byHandle.get(item.claimHandle)) || null,
      severity: item.severity,
    }));
    return MissingEvidenceRepo.replaceAiItems(caseId, rows);
  }
}
