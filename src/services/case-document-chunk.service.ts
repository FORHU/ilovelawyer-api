import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import CaseDocumentChunkRepo, { CaseDocumentChunkRow } from "../repositories/case-document-chunk.repository";
import HttpError from "../utils/http-error";
import { RagStatus } from "@prisma/client";

const CACHE_TTL_S = 300; // 5 minutes
const cacheKey = (caseDocumentId: string) => `case_document_chunks:${caseDocumentId}`;

export interface CaseDocumentWithChunks {
  caseDocumentId: string;
  name: string;
  caseId: string | null;
  ragStatus: RagStatus;
  chunks: CaseDocumentChunkRow[];
}

export default class CaseDocumentChunkSvc {
  static async listByDocument(caseDocumentId: string): Promise<CaseDocumentWithChunks> {
    const key = cacheKey(caseDocumentId);

    const cached = await redis.get<CaseDocumentWithChunks>(key);
    if (cached) return cached;

    const doc = await prisma.document.findUnique({ where: { id: caseDocumentId }, select: { id: true } });
    if (!doc) throw new HttpError("Case document not found", 404);

    const chunks = await CaseDocumentChunkRepo.findByDocument(caseDocumentId);
    const result: CaseDocumentWithChunks = {
      caseDocumentId: doc.id,
      name: doc.name,
      caseId: doc.caseId,
      ragStatus: doc.ragStatus,
      chunks,
    };
    await redis.set(key, result, CACHE_TTL_S);
    return result;
  }
}
