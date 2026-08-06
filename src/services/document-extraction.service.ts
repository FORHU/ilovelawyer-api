import prisma from "../lib/prisma";
import UserDocumentRepo from "../repositories/user-document.repository";
import CaseDocumentChunkRepo from "../repositories/case-document-chunk.repository";
import { getObjectBuffer } from "../utils/s3";
import { extractText } from "../utils/document-text-extraction";
import { chunkText } from "../utils/chunking";
import { embedText } from "../utils/embedding";
import logger from "../utils/logger";

export default class DocumentExtractionSvc {
  /**
   * Extraction → chunking → embedding → storage pipeline for a Case Document (ADR 0010).
   * Dispatched fire-and-forget by the confirm/PATCH/bulk-confirm call sites once a document is
   * linked to a case — never throws, always resolves ragStatus to READY or FAILED.
   */
  static async process(documentId: string): Promise<void> {
    try {
      const doc = await UserDocumentRepo.findByIdWithFile(documentId);
      if (!doc?.file?.s3Key) {
        logger.error("Document extraction: no file/s3Key for document", { documentId });
        await UserDocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      const buffer = await getObjectBuffer(doc.file.s3Key);
      const text = await extractText(buffer, doc.mimeType, doc.name);
      const trimmed = text.trim();

      // Empty extraction (e.g. a scanned/image-only PDF — no OCR) counts as failed, not ready.
      if (!trimmed) {
        await UserDocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      const chunks = chunkText(trimmed);
      if (chunks.length === 0) {
        await UserDocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      const embeddedChunks = await Promise.all(
        chunks.map(async (chunk, index) => ({
          userDocumentId: documentId,
          chunkIndex: index,
          chunkText: chunk,
          charCount: chunk.length,
          embedding: await embedText(chunk),
        })),
      );

      await prisma.$transaction(async (tx) => {
        await CaseDocumentChunkRepo.deleteByDocument(documentId, tx);
        await CaseDocumentChunkRepo.insertMany(embeddedChunks, tx);
      });

      await UserDocumentRepo.updateRagStatus(documentId, "READY");
    } catch (err) {
      logger.error("Document extraction failed", { err, documentId });
      await UserDocumentRepo.updateRagStatus(documentId, "FAILED").catch((updateErr) => {
        logger.error("Failed to mark document FAILED after extraction error", { updateErr, documentId });
      });
    }
  }
}
