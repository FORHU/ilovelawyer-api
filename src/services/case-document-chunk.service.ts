import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import CaseDocumentChunkRepo, { CaseDocumentChunkRow } from "../repositories/case-document-chunk.repository";
import HttpError from "../utils/http-error";

const CACHE_TTL_S = 300; // 5 minutes
const cacheKey = (caseDocumentId: string) => `case_document_chunks:${caseDocumentId}`;

export default class CaseDocumentChunkSvc {
  static async listByDocument(caseDocumentId: string): Promise<CaseDocumentChunkRow[]> {
    const key = cacheKey(caseDocumentId);

    const cached = await redis.get<CaseDocumentChunkRow[]>(key);
    if (cached) return cached;

    const doc = await prisma.caseDocument.findUnique({ where: { id: caseDocumentId }, select: { id: true } });
    if (!doc) throw new HttpError("Case document not found", 404);

    const chunks = await CaseDocumentChunkRepo.findByDocument(caseDocumentId);
    await redis.set(key, chunks, CACHE_TTL_S);
    return chunks;
  }
}
