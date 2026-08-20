import CaseAccess from "../utils/case-access";
import EvidenceRepo from "../repositories/evidence.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { extractFacts, findContradictions, ContradictionHit } from "../utils/fact-extract";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { buildContradictionPrompt } from "../constants/contradiction-scan.constants";
import { extractContradictionHits, uniqueContradictionHits } from "../utils/contradiction-scan";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import logger from "../utils/logger";

export default class EvidenceIntelligenceSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const [matrix, contradictions] = await Promise.all([
      EvidenceRepo.listMatrix(caseId),
      EvidenceRepo.listContradictions(caseId),
    ]);
    return { matrix, contradictions };
  }

  static async upsertMatrix(
    caseId: string,
    userId: string,
    documentId: string,
    data: {
      authenticity?: string;
      admissibility?: string;
      probative?: string;
      originalFile?: boolean;
      needsVerify?: boolean;
      notes?: string | null;
    },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    if (!docs.some((d) => d.id === documentId)) throw new HttpError("Document not found on this case", 404);
    const row = await EvidenceRepo.upsertMatrix(caseId, documentId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "evidence.matrix.upsert", payload: { documentId } });
    return row;
  }

  static async scanContradictions(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY");

    const regexHits = uniqueContradictionHits(await scanWithRegex(ready));
    let hits = regexHits;

    try {
      const llmHits = await scanWithChatWonder(ready);
      // undefined = missing/unparseable block → keep regex. [] = model found none → show none.
      if (llmHits) hits = uniqueContradictionHits(llmHits);
    } catch (err) {
      logger.warn("Chat Wonder contradiction scan failed; using regex fallback", { err, caseId });
    }

    return EvidenceRepo.replaceContradictions(caseId, hits);
  }

  static async traces(caseId: string, userId: string, documentId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const doc = docs.find((d) => d.id === documentId);
    if (!doc) throw new HttpError("Document not found on this case", 404);
    const ids = await DocumentChunkRepo.findIdsByDocument(documentId);
    const chunks = await DocumentChunkRepo.findTextsByIds(ids);
    return {
      documentId,
      name: doc.name,
      pageCount: doc.pageCount,
      extractionMethod: doc.extractionMethod,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        pageNumber: chunk.pageNumber,
      })),
    };
  }
}

type ReadyDoc = { id: string; name: string };

async function scanWithRegex(ready: ReadyDoc[]): Promise<ContradictionHit[]> {
  const perDoc: { documentId: string; facts: ReturnType<typeof extractFacts> }[] = [];
  for (const doc of ready) {
    const chunks = await DocumentChunkRepo.findTextsByIds(await DocumentChunkRepo.findIdsByDocument(doc.id));
    const text = chunks.map((c) => c.chunkText).join("\n");
    perDoc.push({ documentId: doc.id, facts: extractFacts(text) });
  }

  const hits: ContradictionHit[] = [];
  for (let i = 0; i < perDoc.length; i++) {
    for (let j = i + 1; j < perDoc.length; j++) {
      hits.push(...findContradictions(perDoc[i], perDoc[j]));
    }
  }
  return hits;
}

async function scanWithChatWonder(ready: ReadyDoc[]): Promise<ContradictionHit[] | undefined> {
  if (ready.length < 1) return undefined;

  const caseDocumentIds = ready.map((doc) => doc.id);
  const pack = await buildFactExcerptPack(ready);
  const prompt = `${buildContradictionPrompt(ready)}

## EXTRACTED TEXT
Excerpts below were taken from the indexed files, including later pages of a bundled PDF. Compare facts across these excerpts. Quote from them.

${pack.text || "(no indexed text)"}
`;

  const grounding = {
    caseDocumentIds,
    caseDocumentChunkIds: pack.chunkIds,
  };
  let sessionId = await getChatWonderSessionId();
  let payload: { response?: string; intermediate_response?: string };

  try {
    payload = await callChatWonderRest(prompt, sessionId, grounding);
  } catch {
    sessionId = await getChatWonderSessionId();
    payload = await callChatWonderRest(prompt, sessionId, grounding);
  }

  const text = String(payload.response || payload.intermediate_response || "");
  const parsed = extractContradictionHits(text, new Set(caseDocumentIds));
  logger.info("Chat Wonder contradiction scan reply", {
    readyCount: ready.length,
    chunkCount: pack.chunkIds.length,
    factChunkCount: pack.factCount,
    replyChars: text.length,
    parsedCount: parsed === undefined ? null : parsed.length,
  });
  return parsed;
}

