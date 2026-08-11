import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import DocumentChunkRepo, { DocumentChunkRow } from "../repositories/document-chunk.repository";
import HttpError from "../utils/http-error";
import { RagStatus } from "@prisma/client";

const CACHE_TTL_S = 300; // 5 minutes
const cacheKey = (caseDocumentId: string) => `case_document_chunks:${caseDocumentId}`;

export interface DocumentWithChunks {
  caseDocumentId: string;
  name: string;
  caseId: string | null;
  ragStatus: RagStatus;
  chunks: DocumentChunkRow[];
}

export default class DocumentChunkSvc {
  static async listByDocument(caseDocumentId: string): Promise<DocumentWithChunks> {
    const key = cacheKey(caseDocumentId);

    const cached = await redis.get<DocumentWithChunks>(key);
    if (cached) return cached;

    const doc = await prisma.document.findUnique({
      where: { id: caseDocumentId },
      select: { id: true, name: true, caseId: true, ragStatus: true },
    });
    if (!doc) throw new HttpError("Case document not found", 404);

    const chunks = await DocumentChunkRepo.findByDocument(caseDocumentId);
    const result: DocumentWithChunks = {
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
