import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getCaseStrategyPromptBuilder } from "../legal/prompt-registry";
import { extractCaseStrategy } from "../utils/case-strategy-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import CaseTimelineSvc from "./case-timeline.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";

export default class CaseStrategySvc {
  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseStrategy", () => CaseStrategySvc.generateFromDocumentsInner(caseId, userId));
  }

  private static async generateFromDocumentsInner(caseId: string, userId?: string) {
    const tStart = Date.now();
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return ProceduralDeadlineRepo.listProcedureItems(caseId);

    const buildCaseStrategyPrompt = getCaseStrategyPromptBuilder(tenantCode);
    const tPackStart = Date.now();
    const pack = await buildFactExcerptPack(ready);
    const packMs = Date.now() - tPackStart;
    const prompt = `${buildCaseStrategyPrompt(ready, ukJurisdiction)}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    const tCallStart = Date.now();
    let usedSessionRetry = false;
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode);
    } catch (err) {
      logger.warn("Chat Wonder case strategy: first call failed, retrying with a new session", {
        err,
        caseId,
        durationMs: Date.now() - tCallStart,
      });
      usedSessionRetry = true;
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode);
    }
    const callMs = Date.now() - tCallStart;
    logger.info("Chat Wonder case strategy: main call done", { caseId, durationMs: callMs, usedSessionRetry, packMs });

    const text = result.content;
    let parsed = extractCaseStrategy(text);

    // The [DATES] block is one of three the model must produce in the same reply — if it came
    // back missing/unparseable this time, retry once before giving up on the timeline update
    // rather than silently leaving it stale (strategy/todos from the first reply are kept either
    // way, since those parsed fine). This retry is a second full round-trip — the likeliest place
    // for a slow run to double its own latency, hence the explicit timing.
    let datesRetryMs: number | null = null;
    if (parsed && parsed.dates === undefined) {
      logger.warn("Chat Wonder case strategy reply: DATES block missing, retrying once", { caseId });
      const tRetryStart = Date.now();
      try {
        const retrySessionId = await getChatWonderSessionId();
        const retryResult = await streamChatWonderMessage(retrySessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode);
        const retryParsed = extractCaseStrategy(retryResult.content);
        if (retryParsed?.dates !== undefined) parsed = { ...parsed, dates: retryParsed.dates };
      } catch (err) {
        logger.warn("Chat Wonder case strategy: DATES retry failed", { err, caseId, durationMs: Date.now() - tRetryStart });
      }
      datesRetryMs = Date.now() - tRetryStart;
    }

    logger.info("Chat Wonder case strategy reply", {
      caseId,
      readyCount: ready.length,
      chunkCount: pack.chunkIds.length,
      factChunkCount: pack.factCount,
      replyChars: text.length,
      strategyCount: parsed?.strategy.length ?? null,
      todoCount: parsed?.todos.length ?? null,
      dateCount: parsed?.dates?.length ?? null,
      packMs,
      callMs,
      datesRetryMs,
      totalMsSoFar: Date.now() - tStart,
    });

    if (!parsed) return ProceduralDeadlineRepo.listProcedureItems(caseId);

    if (parsed.strategy.length > 0 || parsed.todos.length > 0) {
      const items = [
        ...parsed.strategy.map((item) => ({ kind: "STRATEGY", label: item.label, sourceLabel: item.sourceLabel })),
        ...parsed.todos.map((item) => ({ kind: "TODO", label: item.label, sourceLabel: item.sourceLabel })),
      ];
      await ProceduralDeadlineRepo.replaceAiProcedureItems(caseId, items);
    }

    if (parsed.dates === undefined) {
      logger.warn("Chat Wonder case strategy: DATES block missing after retry, timeline left unchanged", { caseId });
    } else {
      if (parsed.dates.length === 0 && ready.length > 0) {
        logger.warn("Chat Wonder case strategy: DATES block parsed but empty", { caseId, readyCount: ready.length });
      }
      const readyIds = new Set(ready.map((doc) => doc.id));
      const dates = parsed.dates.map((item) => ({
        ...item,
        // Drop a hallucinated documentId rather than store a dangling reference — the excerpt
        // pack only ever hands the model ids from `ready`.
        documentId: item.documentId && readyIds.has(item.documentId) ? item.documentId : null,
      }));
      const tWriteStart = Date.now();
      await CaseTimelineSvc.replaceDocumentDates(caseId, ready.map((doc) => doc.id), dates, userId);
      logger.info("Chat Wonder case strategy: timeline write done", { caseId, durationMs: Date.now() - tWriteStart });
    }

    logger.info("Chat Wonder case strategy: total", { caseId, totalMs: Date.now() - tStart });
    return ProceduralDeadlineRepo.listProcedureItems(caseId);
  }
}
