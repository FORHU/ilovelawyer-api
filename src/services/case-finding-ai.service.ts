import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseRepo from "../repositories/case.repository";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";
import { FINDINGS_FORMAT_VERSION } from "../constants";
import HttpError from "../utils/http-error";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { getCaseFindingPromptBuilder } from "../legal/prompt-registry";
import { extractCaseFindings } from "../utils/case-finding-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import FindingJevSvc from "./finding-jev.service";
import logger from "../utils/logger";

// A findings run that failed this recently isn't retried on open — a case whose documents keep
// failing to parse would otherwise re-run on every Terminal load.
const OUTDATED_RETRY_AFTER_MS = 60 * 60 * 1000;

// Mirrors CaseStrategySvc.generateFromDocuments — same prompt->parse->replace-AI-rows shape,
// a different prompt/parser/table (CaseFinding instead of ProcedureItem).
export default class CaseFindingAiSvc {
  /**
   * Called on every Terminal load (CaseSnapshotSvc.get) with the case row it already has. A case
   * whose findings predate FINDINGS_FORMAT_VERSION gets one findings-only regeneration queued
   * (AiGenerationQueue kind "caseFinding") — the automatic refresh only re-runs findings when the
   * documents change, and there's no manual refresh any more. Claims the "caseFinding" lock
   * before enqueueing, so repeated loads queue it once and the panels see it running straight
   * away. Skipped when current, with no READY documents, or after a failure in the last hour.
   * Never throws — a Terminal load must not fail over this.
   */
  static async scheduleIfOutdated(caseRecord: { id: string; userId: string; findingsFormatVersion: number | null }): Promise<void> {
    if ((caseRecord.findingsFormatVersion ?? 1) >= FINDINGS_FORMAT_VERSION) return;
    const caseId = caseRecord.id;
    try {
      const job = await AiGenerationJobRepo.findBySubjectAndKind(caseId, "caseFinding");
      if (job?.status === "FAILED" && job.finishedAt && Date.now() - job.finishedAt.getTime() < OUTDATED_RETRY_AFTER_MS) return;
      if (!(await DocumentRepo.listAllByCase(caseId)).some((d) => d.ragStatus === "READY")) return;
      try {
        await AiGenerationLockSvc.begin(caseId, "caseFinding");
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409) return; // already running
        throw err;
      }
      // Dynamic import — ai-generation.queue.ts imports this service for its RUNNERS table.
      const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
      AiGenerationQueue.enqueue({ kind: "caseFinding", caseId, userId: caseRecord.userId });
      logger.info("Case findings: outdated format, regeneration queued", {
        caseId,
        from: caseRecord.findingsFormatVersion,
        to: FINDINGS_FORMAT_VERSION,
      });
    } catch (err) {
      logger.warn("Case findings: couldn't queue an outdated-format regeneration", { err, caseId });
    }
  }

  /** Run by AiGenerationQueue's worker after scheduleIfOutdated claimed the job row. */
  static async runQueued(caseId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseFinding", () => CaseFindingAiSvc.generateFromDocumentsInner(caseId));
  }

  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseFinding", () => CaseFindingAiSvc.generateFromDocumentsInner(caseId));
  }

  private static async generateFromDocumentsInner(caseId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return CaseFindingRepo.list(caseId);

    const buildCaseFindingPrompt = getCaseFindingPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseFindingPrompt(ready, ukJurisdiction)}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    let sessionId = await getChatWonderSessionId();
    let payload: { response?: string; intermediate_response?: string };
    try {
      payload = await callChatWonderRest(
        prompt,
        sessionId,
        { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds },
        tenantCode,
      );
    } catch {
      sessionId = await getChatWonderSessionId();
      payload = await callChatWonderRest(
        prompt,
        sessionId,
        { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds },
        tenantCode,
      );
    }

    const text = String(payload.response || payload.intermediate_response || "");
    const parsed = extractCaseFindings(text);
    logger.info("Chat Wonder case finding reply", {
      caseId,
      readyCount: ready.length,
      chunkCount: pack.chunkIds.length,
      factChunkCount: pack.factCount,
      replyChars: text.length,
      findingCount: parsed?.length ?? null,
    });

    if (!parsed) return CaseFindingRepo.list(caseId);
    // Jev re-rates the categories it has a check for (see finding-jev.service.ts).
    const rows = await FindingJevSvc.verifyParsed(caseId, parsed);
    logger.info("Case findings verified", { caseId, jevChecked: rows.filter((r) => r.jev !== undefined).length });
    const saved = await CaseFindingRepo.replaceAiFindings(caseId, rows);
    // Only a parsed, saved batch counts as current — an unparseable reply leaves the case outdated
    // so the next load (after OUTDATED_RETRY_AFTER_MS) tries again.
    await CaseRepo.setFindingsFormatVersion(caseId, FINDINGS_FORMAT_VERSION);
    return saved;
  }
}
