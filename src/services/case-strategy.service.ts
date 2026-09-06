import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
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
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return ProceduralDeadlineRepo.listProcedureItems(caseId);

    const buildCaseStrategyPrompt = getCaseStrategyPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseStrategyPrompt(ready)}

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
    const parsed = extractCaseStrategy(text);
    logger.info("Chat Wonder case strategy reply", {
      caseId,
      readyCount: ready.length,
      chunkCount: pack.chunkIds.length,
      factChunkCount: pack.factCount,
      replyChars: text.length,
      strategyCount: parsed?.strategy.length ?? null,
      todoCount: parsed?.todos.length ?? null,
      dateCount: parsed?.dates.length ?? null,
    });

    if (!parsed) return ProceduralDeadlineRepo.listProcedureItems(caseId);

    if (parsed.strategy.length > 0 || parsed.todos.length > 0) {
      const items = [
        ...parsed.strategy.map((item) => ({ kind: "STRATEGY", label: item.label, sourceLabel: item.sourceLabel })),
        ...parsed.todos.map((item) => ({ kind: "TODO", label: item.label, sourceLabel: item.sourceLabel })),
      ];
      await ProceduralDeadlineRepo.replaceAiProcedureItems(caseId, items);
    }

    if (parsed.dates.length > 0) {
      await CaseTimelineSvc.replaceDocumentDates(caseId, parsed.dates, userId);
    }

    return ProceduralDeadlineRepo.listProcedureItems(caseId);
  }
}
