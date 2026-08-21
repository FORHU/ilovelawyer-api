import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { buildCaseReconstructionPrompt } from "../constants/case-reconstruction.constants";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import logger from "../utils/logger";

const MAX_NARRATIVE_CHARS = 12000;

function cleanNarrative(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim()
    .slice(0, MAX_NARRATIVE_CHARS);
}

export default class CaseReconstructionSvc {
  static async get(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseReconstructionRepo.get(caseId);
  }

  /** A dedicated action, not folded into CaseRefreshSvc.refresh — narrative generation is a
   * heavier, slower single-shot call than the short tagged-list prompts refresh already runs,
   * so it's the lawyer's call when to (re)generate rather than happening on every refresh. */
  static async generate(caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) throw new HttpError("No indexed documents to reconstruct from yet", 422);

    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseReconstructionPrompt(ready)}

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

    const narrative = cleanNarrative(String(payload.response || payload.intermediate_response || ""));
    logger.info("Chat Wonder case reconstruction reply", { caseId, readyCount: ready.length, narrativeChars: narrative.length });
    if (!narrative) throw new HttpError("Chat Wonder returned no reconstruction text", 502);

    const row = await CaseReconstructionRepo.upsert(caseId, narrative);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generate", payload: { id: row.id } });
    return row;
  }

  static async update(caseId: string, userId: string, narrative: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseReconstructionRepo.upsert(caseId, narrative);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.update", payload: { id: row.id } });
    return row;
  }
}
