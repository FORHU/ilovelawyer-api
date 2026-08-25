import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { getCaseFindingPromptBuilder } from "../legal/prompt-registry";
import { extractCaseFindings } from "../utils/case-finding-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import logger from "../utils/logger";

// Mirrors CaseStrategySvc.generateFromDocuments — same prompt->parse->replace-AI-rows shape,
// a different prompt/parser/table (CaseFinding instead of ProcedureItem).
export default class CaseFindingAiSvc {
  static async generateFromDocuments(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    const jurisdiction = await CaseAccess.resolveJurisdiction(caseId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) return CaseFindingRepo.list(caseId);

    const buildCaseFindingPrompt = getCaseFindingPromptBuilder(jurisdiction);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseFindingPrompt(ready)}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    let sessionId = await getChatWonderSessionId();
    let payload: { response?: string; intermediate_response?: string };
    try {
      payload = await callChatWonderRest(prompt, sessionId, {
        caseDocumentIds: ready.map((d) => d.id),
        caseDocumentChunkIds: pack.chunkIds,
      });
    } catch {
      sessionId = await getChatWonderSessionId();
      payload = await callChatWonderRest(prompt, sessionId, {
        caseDocumentIds: ready.map((d) => d.id),
        caseDocumentChunkIds: pack.chunkIds,
      });
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
    return CaseFindingRepo.replaceAiFindings(caseId, parsed);
  }
}
