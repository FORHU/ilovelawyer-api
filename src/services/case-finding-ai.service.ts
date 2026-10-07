import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseRepo from "../repositories/case.repository";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";
import { FINDINGS_FORMAT_VERSION } from "../constants";
import HttpError from "../utils/http-error";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { getCaseFindingPromptBuilder } from "../legal/prompt-registry";
import { extractCaseFindings } from "../utils/case-finding-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import FindingJevSvc from "./finding-jev.service";
import logger from "../utils/logger";

// A findings run that failed this recently isn't retried on open — a case whose documents keep
// failing to parse would otherwise re-run on every Terminal load.
const OUTDATED_RETRY_AFTER_MS = 60 * 60 * 1000;

/** The findings panels with their own Regenerate: all five. */
export type RegenerableCategory = "LEGAL_ISSUE" | "WEAKNESS" | "STRENGTH" | "ATTACK_STRATEGY" | "DEFENSE_STRATEGY";
/** Each panel's own job kind, so only that panel shows its Regenerate running. */
export const CATEGORY_REGENERATE_KIND = {
  LEGAL_ISSUE: "legalIssueRegenerate",
  WEAKNESS: "weaknessRegenerate",
  STRENGTH: "strengthRegenerate",
  ATTACK_STRATEGY: "attackRegenerate",
  DEFENSE_STRATEGY: "defenseRegenerate",
} as const;
const CATEGORY_BLOCK: Record<RegenerableCategory, string> = {
  LEGAL_ISSUE: "[LEGAL_ISSUES]",
  WEAKNESS: "[WEAKNESSES]",
  STRENGTH: "[STRENGTHS]",
  ATTACK_STRATEGY: "[ATTACK_STRATEGY]",
  DEFENSE_STRATEGY: "[DEFENSE_STRATEGY]",
};

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

  /**
   * One findings panel's "Regenerate": claims that panel's lock before the job is queued, so a
   * double click or a second viewer gets a 409 straight away. Refused while the whole findings
   * batch is regenerating (caseFinding, or the caseRefresh that runs it) — both replace AI rows,
   * and that run is about to rewrite this panel anyway.
   */
  static async beginCategory(caseId: string, userId: string, category: RegenerableCategory): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    const [findings, refresh] = await Promise.all([
      AiGenerationLockSvc.getStatus(caseId, "caseFinding"),
      AiGenerationLockSvc.getStatus(caseId, "caseRefresh"),
    ]);
    if (findings?.status === "IN_PROGRESS" || refresh?.status === "IN_PROGRESS") {
      throw new HttpError("The case's findings are already updating", 409);
    }
    await AiGenerationLockSvc.begin(caseId, CATEGORY_REGENERATE_KIND[category]);
  }

  /** Run by AiGenerationQueue's worker after beginCategory claimed the lock. */
  static async runQueuedCategory(caseId: string, category: RegenerableCategory): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, CATEGORY_REGENERATE_KIND[category], () =>
      CaseFindingAiSvc.generateFromDocumentsInner(caseId, category),
    );
  }

  /** With `only`, asks for that one category, Jev-checks it and replaces just its AI rows — the
   * other panels and the case's findings format stamp are left alone. */
  private static async generateFromDocumentsInner(caseId: string, only?: RegenerableCategory) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const clientSide = await CaseAccess.resolveClientSide(caseId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return CaseFindingRepo.list(caseId);

    const buildCaseFindingPrompt = getCaseFindingPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    // Same prompt and block layout (the parser expects all five), with the other blocks left empty.
    const focus = only
      ? `

## THIS RUN
Only the ${CATEGORY_BLOCK[only]} block is needed this time. Fill it as above and reply with the other four blocks as empty arrays.`
      : "";
    const prompt = `${buildCaseFindingPrompt(ready, ukJurisdiction, clientSide)}${focus}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    // Streamed, not one blocking REST call: on a large bundle (20+ documents) the reply takes longer
    // than callChatWonderRest's 90s limit, which sits just under Cloudflare's ~100s edge timeout
    // in front of Chat Wonder — the run failed and the case kept its old findings. Same fix as
    // CaseReconstructionSvc's narrative and RedTeamSvc.generate.
    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseFindings", caseId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
    }

    const text = String(result.content || "");
    const parsed = extractCaseFindings(text);
    logger.info("Chat Wonder case finding reply", {
      caseId,
      readyCount: ready.length,
      chunkCount: pack.chunkIds.length,
      factChunkCount: pack.factCount,
      replyChars: text.length,
      findingCount: parsed?.length ?? null,
    });

    if (!parsed) {
      // A panel's Regenerate must report the failure; the background run just stays outdated (below).
      if (only) throw new HttpError("Chat Wonder returned no usable findings", 502);
      return CaseFindingRepo.list(caseId);
    }
    const batch = only ? parsed.filter((p) => p.category === only) : parsed;
    // Jev re-rates the categories it has a check for (see finding-jev.service.ts).
    const rows = await FindingJevSvc.verifyParsed(caseId, batch);
    logger.info("Case findings verified", { caseId, only: only ?? null, jevChecked: rows.filter((r) => r.jev !== undefined).length });
    if (only) return CaseFindingRepo.replaceAiFindings(caseId, rows, only);
    const saved = await CaseFindingRepo.replaceAiFindings(caseId, rows);
    // Only a parsed, saved batch counts as current — an unparseable reply leaves the case outdated
    // so the next load (after OUTDATED_RETRY_AFTER_MS) tries again.
    await CaseRepo.setFindingsFormatVersion(caseId, FINDINGS_FORMAT_VERSION);
    return saved;
  }
}
