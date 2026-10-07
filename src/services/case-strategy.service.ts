import CaseAccess from "../utils/case-access";
import { docsForPrompt, excerptsWithHandles } from "../utils/case-document-handles";
import DocumentRepo from "../repositories/document.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { getCaseStrategyPromptBuilder } from "../legal/prompt-registry";
import { extractCaseStrategy, attachKeyDateDocuments } from "../utils/case-strategy-parse";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import CaseTimelineSvc from "./case-timeline.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import OrganizationRepo from "../repositories/organization.repository";
import { STRATEGY_GENERATED_ACTION } from "../utils/strategy-staleness";
import { checkStrategyItems, isCaseStrategyJevEnabled } from "../utils/case-strategy-jev";
import logger from "../utils/logger";

export default class CaseStrategySvc {
  /** Fast half of a lawyer-triggered refresh of the Case Strategy panel — access check + claiming
   * the AiGenerationJob row — called from the controller before handing off to AiGenerationQueue
   * (SQS), same begin/runQueued split as Refresh analysis and Timeline generate. Refreshes only
   * this panel's pass (plan, to-dos, key dates), not contradictions/findings/outlook/map. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "caseStrategyRefresh");
  }

  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseStrategyRefresh", async () => {
      await CaseStrategySvc.generateFromDocuments(caseId, userId);
    });
  }

  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseStrategy", () => CaseStrategySvc.generateFromDocumentsInner(caseId, userId));
  }

  /** Judges the plan's recommended-approach items against the case data (case-strategy-jev.ts) and
   * saves the verdicts. Awaited inside the generation lock so the panel's "done" poll sees them,
   * but a Jev failure never fails the generation — the plan is already saved. */
  private static async checkPlan(caseId: string, userId: string | undefined): Promise<void> {
    if (!isCaseStrategyJevEnabled() || !userId) return;
    try {
      const items = (await ProceduralDeadlineRepo.listProcedureItems(caseId)).filter((i) => i.kind === "STRATEGY");
      if (!items.length) return;
      // Dynamic: same circularity the mind map's Jev context avoids (snapshot -> repositories).
      const CaseMindMapSvc = (await import("./case-mind-map.service")).default;
      const context = await CaseMindMapSvc.jevContext(caseId, userId);
      const results = await checkStrategyItems(items.map((i) => ({ id: i.id, label: i.label })), context);
      const applied = await ProceduralDeadlineRepo.saveChecks(caseId, results);
      logger.info("Case strategy: Jev check done", { caseId, checked: results.length, applied });
    } catch (err) {
      logger.warn("Case strategy: Jev check failed", { err, caseId });
    }
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
    // Documents are listed, and excerpts headed, by a short handle (D1, D2, …): a key date's
    // documentId is copied back far more reliably than a 36-character id, which the model garbles
    // often enough that most dates lost their source. resolveDocumentRef maps it back below.
    const prompt = `${buildCaseStrategyPrompt(docsForPrompt(ready), ukJurisdiction)}

${wrapExtractedText("Use only these excerpts and the attached case documents.", excerptsWithHandles(pack.text, ready))}
`;

    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseStrategy", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    const tCallStart = Date.now();
    let usedSessionRetry = false;
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
    } catch (err) {
      logger.warn("Chat Wonder case strategy: first call failed, retrying with a new session", {
        err,
        caseId,
        durationMs: Date.now() - tCallStart,
      });
      usedSessionRetry = true;
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
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
        const retryResult = await streamChatWonderMessage(retrySessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { trace });
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
      const dates = attachKeyDateDocuments(parsed.dates, ready);
      const unsourced = dates.filter((d) => !d.documentId).length;
      if (unsourced) {
        logger.info("Chat Wonder case strategy: key dates with no matching document", {
          caseId,
          unsourced,
          total: dates.length,
          sample: parsed.dates.filter((d, i) => !dates[i]!.documentId).slice(0, 5).map((d) => d.documentId),
        });
      }
      const tWriteStart = Date.now();
      await CaseTimelineSvc.replaceDocumentDates(caseId, ready.map((doc) => doc.id), dates, userId);
      logger.info("Chat Wonder case strategy: timeline write done", { caseId, durationMs: Date.now() - tWriteStart });
    }

    await CaseStrategySvc.checkPlan(caseId, userId);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: STRATEGY_GENERATED_ACTION,
      payload: { strategy: parsed.strategy.length, todos: parsed.todos.length, dates: parsed.dates?.length ?? null },
    });
    logger.info("Chat Wonder case strategy: total", { caseId, totalMs: Date.now() - tStart });
    return ProceduralDeadlineRepo.listProcedureItems(caseId);
  }
}
