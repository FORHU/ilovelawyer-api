import CaseChangeRun from "./case-change-run.service";
import { diffOutlook } from "../utils/case-change-delta";
import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseRiskRepo from "../repositories/case-risk.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseOutlookRepo from "../repositories/case-outlook.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { getCaseOutlookPromptBuilder } from "../legal/prompt-registry";
import { applyOutlookGuards, parseCaseOutlook } from "../utils/case-outlook-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import { OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES, OUTLOOK_MIN_READY_DOCS } from "../constants";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";

// Same prompt->chat-wonder->parse shape as CaseFindingAiSvc, but append-only: each successful run
// inserts a new CaseOutlook row, and a failed or unparseable run writes nothing, so the previous
// outlook stays current. Returns the case's current outlook (null if it has never had one).
export default class CaseOutlookAiSvc {
  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseOutlook", () => CaseOutlookAiSvc.generateFromDocumentsInner(caseId));
  }

  /** Case Summary's own Regenerate: claims the "caseOutlook" lock before the job is queued, so a
   * double click gets a 409 at once. Refused while the case analysis runs. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "caseOutlook");
  }

  /** Run by AiGenerationQueue's worker after beginQueued claimed the lock. */
  static async runQueued(caseId: string, userId?: string): Promise<void> {
    // The Case Summary pane's Regenerate: the "What changed" modal then describes this run (CaseChangeRun).
    await AiGenerationLockSvc.finishWith(caseId, "caseOutlook", () =>
      CaseChangeRun.regenerate(
        caseId,
        userId ?? null,
        "outlook",
        () => CaseOutlookRepo.latest(caseId),
        () => CaseOutlookAiSvc.generateFromDocumentsInner(caseId),
        (before, after) => diffOutlook(before, after),
      ),
    );
  }

  private static async generateFromDocumentsInner(caseId: string) {
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return CaseOutlookRepo.latest(caseId);

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const [caseRecord, ukJurisdiction, findings, risks, contradictions, deadlines] = await Promise.all([
      CaseRepo.findLanguage(caseId),
      tenantCode === "UK" ? CaseAccess.resolveUkJurisdiction(caseId) : Promise.resolve(null),
      CaseFindingRepo.list(caseId),
      CaseRiskRepo.list(caseId),
      EvidenceRepo.listContradictions(caseId),
      ProceduralDeadlineRepo.list(caseId),
    ]);
    const openRisks = risks.filter((r) => r.status === "OPEN");

    const buildCaseOutlookPrompt = getCaseOutlookPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseOutlookPrompt({
      docs: ready,
      findings,
      openRisks,
      contradictions,
      deadlines,
      language: caseRecord?.language ?? "en",
      ukJurisdiction,
    })}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    let payload: { response?: string; intermediate_response?: string };
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseOutlook", caseId);
    try {
      payload = await callChatWonderRest(prompt, await getChatWonderSessionId(), grounding, tenantCode, { trace });
    } catch {
      payload = await callChatWonderRest(prompt, await getChatWonderSessionId(), grounding, tenantCode, { trace });
    }

    const text = String(payload.response || payload.intermediate_response || "");
    const parsed = parseCaseOutlook(text);
    logger.info("Chat Wonder case outlook reply", {
      caseId,
      readyCount: ready.length,
      chunkCount: pack.chunkIds.length,
      replyChars: text.length,
      band: parsed?.band ?? null,
      confidence: parsed?.confidence ?? null,
    });

    if (!parsed) {
      logger.warn("Case outlook: unusable reply, keeping the previous outlook", { caseId, replyChars: text.length });
      return CaseOutlookRepo.latest(caseId);
    }

    const guarded = applyOutlookGuards(parsed, {
      caseDocumentIds: docs.map((d) => d.id),
      readyDocumentCount: ready.length,
      openRiskSeverities: openRisks.map((r) => r.severity),
      minReadyDocs: OUTLOOK_MIN_READY_DOCS,
      lowConfidenceRiskSeverities: OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES,
    });
    if (guarded.confidence !== parsed.confidence) {
      logger.info("Case outlook: confidence capped to LOW on thin evidence", { caseId, modelConfidence: parsed.confidence });
    }
    return CaseOutlookRepo.insert(caseId, guarded);
  }
}
