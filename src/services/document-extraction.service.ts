import { Prisma, RagStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { emitToUser, type DocumentSocketEvent, type DocumentSocketPayload } from "../lib/socket";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { downloadObjectToTempFile } from "../utils/s3";
import { extractPagesFromFile, type ExtractedPage } from "../utils/document-text-extraction";
import { transcribeS3Media } from "./transcription.service";
import { MEDIA_DOCUMENT_EXTENSIONS, MEDIA_DOCUMENT_MIME_TYPES } from "../constants";
import { chunkPages, resolveChunkingProfile } from "../utils/chunking";
import { embedTexts, isRateLimit } from "../utils/embedding";
import { categorizeDocument } from "../utils/chatWonder";
import logger from "../utils/logger";
import LlmUsageSvc from "./llm-usage.service";

/** mp3/mp4 evidence — transcribed via AWS Transcribe rather than text-extracted. */
function isMediaDocument(mimeType?: string | null, filename?: string): boolean {
  if (mimeType && MEDIA_DOCUMENT_MIME_TYPES.includes(mimeType)) return true;
  const ext = filename?.split(".").pop()?.toLowerCase();
  return !!ext && MEDIA_DOCUMENT_EXTENSIONS.includes(ext);
}

/**
 * Transcribes mp3/mp4 evidence. Music, sound effects and silent screen recordings complete
 * successfully in Transcribe but return zero words — an empty transcript would otherwise fall
 * into the "no text extracted" branch, mark the document FAILED, and get re-swept (and
 * re-transcribed, billably) forever. A short placeholder indexes it as a normal READY document
 * so the file is still findable by name and the case's evidence list isn't stuck on an error.
 */
async function transcribeMedia(s3Key: string, documentId: string, filename: string): Promise<string> {
  const transcript = (await transcribeS3Media(s3Key, `document-${documentId}`)).trim();
  if (transcript) return transcript;
  logger.info("Document extraction: media has no recognizable speech", { documentId, name: filename });
  return `[Audio/video file "${filename}" — no speech was detected, so there is no transcript to index.]`;
}

/** Chunks embedded and stored per round (see process). A multiple of every chunking tier's
 * embeddingBatchSize (100, 50, 32), so rounds never split a batch. */
export const EMBED_ROUND_CHUNKS = 3_200;

/** The first `maxChars` of a document's text, for auto-categorization — built page by page so a
 * very large document is never joined into one string just to read its opening. */
export function leadingText(pages: ExtractedPage[], maxChars: number): string {
  let out = "";
  for (const page of pages) {
    if (out.length >= maxChars) break;
    out += (out ? "\n\n" : "") + page.text.slice(0, maxChars);
  }
  return out.slice(0, maxChars);
}

export interface ProcessOptions {
  /** Called once the file's size is known (from the row, then again from the actual download),
   * so DocumentExtractionQueue can stretch its hard timeout for a large file. */
  onFileSize?: (bytes: number) => void;
}

export default class DocumentExtractionSvc {
  /**
   * Best-effort live push to the uploader (same `user:<id>` room chat uses). Document.ragStatus
   * in the DB is the source of truth and the web app still reconciles from it, so a failed or
   * skipped emit only costs latency — it must never affect the job, hence the try/catch even
   * though emitToUser documents itself as never throwing.
   */
  private static emit(
    doc: { id: string; userId: string; caseId: string | null; consultationId: string | null },
    event: DocumentSocketEvent,
    ragStatus: RagStatus,
    extra: Pick<DocumentSocketPayload, "pageCount" | "category"> = {},
  ): void {
    try {
      const payload: DocumentSocketPayload = {
        documentId: doc.id,
        caseId: doc.caseId,
        consultationId: doc.consultationId,
        ragStatus,
        ...extra,
      };
      emitToUser(doc.userId, event, payload);
    } catch (err) {
      logger.warn("Document extraction: emitToUser failed, continuing without it", { err, event, documentId: doc.id });
    }
  }

  /** Writes ragStatus, then pushes `event`. `updateRagStatus` returns the row, so the emit needs
   * no extra query and works even where the document was never loaded (the catch block). Throws
   * exactly what updateRagStatus throws (e.g. P2025 for a deleted document) — no emit then. */
  private static async setStatus(documentId: string, ragStatus: RagStatus, event: DocumentSocketEvent): Promise<void> {
    const doc = await DocumentRepo.updateRagStatus(documentId, ragStatus);
    DocumentExtractionSvc.emit(doc, event, ragStatus);
  }

  /**
   * Extraction → chunking → embedding → storage pipeline for a Case Document (ADR 0010).
   * Pulled by `DocumentExtractionQueue` after confirm/PATCH/bulk-confirm — never throws,
   * always resolves ragStatus to READY or FAILED.
   */
  static async process(documentId: string, options: ProcessOptions = {}): Promise<void> {
    // Embeddings and categorization made below are attributed, in the usage ledger, to the user and
    // organization that own the document — a queue worker has no request to say so.
    return LlmUsageSvc.runInDocumentScope(documentId, () => DocumentExtractionSvc.processDocument(documentId, options));
  }

  private static async processDocument(documentId: string, options: ProcessOptions = {}): Promise<void> {
    // Set once a multi-round document starts writing chunks outside a transaction — a failure
    // after that must not leave a partial set behind (see the catch).
    let partialChunksWritten = false;
    try {
      const doc = await DocumentRepo.findByIdWithFile(documentId);
      if (!doc?.file?.s3Key) {
        logger.error("Document extraction: no file/s3Key for document", { documentId });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      if (doc.ragStatus !== "PENDING") {
        await DocumentRepo.updateRagStatus(documentId, "PENDING");
      }

      logger.info("Document extraction: started", { documentId, name: doc.name });
      if (doc.fileSize) options.onFileSize?.(doc.fileSize);
      // Also resets a re-run FAILED row's badge back to "indexing" on a connected client.
      DocumentExtractionSvc.emit(doc, "document:started", "PENDING");

      // Stage timings — the only way to tell "this document is slow because of OCR/rate
      // limiting/queue backlog" apart from each other after the fact, since none of that
      // showed up as elapsed time anywhere before this.
      const tStart = Date.now();
      // mp3/mp4 evidence has no text layer — transcribe it with AWS Transcribe (the same helpers
      // the Transcription page uses, reading straight from S3 so the file is never buffered here)
      // and index the transcript through the normal pipeline below. A failed/timed-out job throws,
      // which the catch at the bottom resolves to ragStatus FAILED.
      // Everything else is streamed to a temp file rather than buffered (uploads go up to 1 GB),
      // and the file is removed as soon as extraction is done with it.
      const isMedia = isMediaDocument(doc.mimeType, doc.name);
      const download = isMedia ? null : await downloadObjectToTempFile(doc.file.s3Key);
      const tDownloaded = Date.now();
      let extracted: Awaited<ReturnType<typeof extractPagesFromFile>>;
      if (download) {
        options.onFileSize?.(download.bytes);
        try {
          extracted = await extractPagesFromFile(download.path, download.bytes, doc.mimeType, doc.name, doc.file.s3Key);
        } finally {
          await download.cleanup();
        }
      } else {
        extracted = {
          pages: [{ pageNumber: 1, text: await transcribeMedia(doc.file.s3Key, documentId, doc.name) }],
          method: "text",
          ocrAttempted: false,
        };
      }
      const { pages, method, ocrAttempted } = extracted;
      const tExtracted = Date.now();
      logger.info("Document extraction: timing (download, extract)", {
        documentId,
        downloadMs: tDownloaded - tStart,
        extractMs: tExtracted - tDownloaded,
        method,
        ocrAttempted,
        pageCount: pages.length,
      });
      const trimmedPages = pages.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text.length > 0);

      await DocumentRepo.updateExtractionMeta(documentId, {
        pageCount: pages.length,
        extractionMethod: method,
        ocrAttempted,
      });

      // Empty extraction (scanned PDF with failed OCR) counts as failed, not ready.
      if (trimmedPages.length === 0) {
        logger.warn("Document extraction: no text extracted", { documentId, name: doc.name, ocrAttempted });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      // Kicked off now (not awaited) so it runs alongside chunking/embedding below rather
      // than adding its own latency to the pipeline — independent of chunk storage, so a
      // failure here (already swallowed inside categorizeDocument) never affects ragStatus.
      // Sliced to what Chat Wonder's categorization prompt actually reads (first 3000
      // chars) so a large document doesn't ship its full text over the wire for nothing.
      // Skipped entirely when the client already supplied a category (e.g. uploaded straight
      // into a folder) — that choice must stick, not get silently overwritten once this resolves.
      let categoryPromise: Promise<string | null>;
      if (doc.category?.trim()) {
        logger.info("Document extraction: skipping auto-categorization, category already set", {
          documentId,
          category: doc.category,
        });
        categoryPromise = Promise.resolve(null);
      } else {
        categoryPromise = categorizeDocument(leadingText(trimmedPages, 3000), doc.name, {
          userId: doc.userId,
          caseId: doc.caseId,
          consultationId: doc.consultationId,
        });
      }

      const totalChars = trimmedPages.reduce((sum, page) => sum + page.text.length, 0);
      const profile = resolveChunkingProfile({
        pageCount: pages.length,
        totalChars,
        fileSizeBytes: doc.fileSize ?? null,
      });
      const chunks = chunkPages(trimmedPages, profile);
      const tChunked = Date.now();
      if (chunks.length === 0) {
        logger.warn("Document extraction: no chunks", { documentId, name: doc.name });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      const embeddingBatchSize = profile.embeddingBatchSize;
      const embeddingConcurrency = profile.embeddingConcurrency;
      const totalBatches = Math.ceil(chunks.length / embeddingBatchSize);

      logger.info("Document extraction: embedding", {
        documentId,
        chunks: chunks.length,
        batches: totalBatches,
        rounds: Math.ceil(chunks.length / EMBED_ROUND_CHUNKS),
        tier: profile.tier,
        chunkSize: profile.chunkSize,
        fileSizeBytes: doc.fileSize,
        pageCount: pages.length,
        totalChars,
      });

      // Embedded and stored EMBED_ROUND_CHUNKS at a time, so memory holds one round's embeddings,
      // not the whole document's (1536 floats per chunk — a large upload has hundreds of
      // thousands of chunks). A document that fits in one round keeps the atomic replace (old
      // chunks swapped for new in one transaction); a larger one clears its old chunks first and
      // fills in round by round. It is PENDING meanwhile, which keeps it out of case/consultation
      // retrieval (READY only), and a failure part-way deletes what was written (see the catch).
      const singleRound = chunks.length <= EMBED_ROUND_CHUNKS;
      if (!singleRound) {
        partialChunksWritten = true;
        await DocumentChunkRepo.deleteByDocument(documentId);
      }
      let embedMs = 0;
      let storeMs = 0;
      for (let roundStart = 0; roundStart < chunks.length; roundStart += EMBED_ROUND_CHUNKS) {
        const roundChunks = chunks.slice(roundStart, roundStart + EMBED_ROUND_CHUNKS);
        const batches: string[][] = [];
        for (let i = 0; i < roundChunks.length; i += embeddingBatchSize) {
          batches.push(roundChunks.slice(i, i + embeddingBatchSize).map((c) => c.text));
        }

        const tRoundStart = Date.now();
        const rows: { caseDocumentId: string; chunkIndex: number; chunkText: string; charCount: number; embedding: number[]; pageNumber: number | null }[] = [];
        for (let i = 0; i < batches.length; i += embeddingConcurrency) {
          const group = batches.slice(i, i + embeddingConcurrency);
          const groupEmbeddings = await Promise.all(group.map((batch) => embedTexts(batch)));
          group.forEach((batch, g) => {
            const baseInRound = (i + g) * embeddingBatchSize;
            batch.forEach((chunk, j) =>
              rows.push({
                caseDocumentId: documentId,
                chunkIndex: roundStart + baseInRound + j,
                chunkText: chunk,
                charCount: chunk.length,
                embedding: groupEmbeddings[g][j],
                pageNumber: roundChunks[baseInRound + j]?.pageNumber ?? null,
              }),
            );
          });
          logger.info("Document extraction: embedding progress", {
            documentId,
            completedBatches: Math.min(roundStart / embeddingBatchSize + i + embeddingConcurrency, totalBatches),
            totalBatches,
            tier: profile.tier,
          });
        }
        const tRoundEmbedded = Date.now();
        embedMs += tRoundEmbedded - tRoundStart;

        if (singleRound) {
          // Default interactive-transaction timeout (5s) is tuned for small transactions.
          await prisma.$transaction(
            async (tx) => {
              await DocumentChunkRepo.deleteByDocument(documentId, tx);
              await DocumentChunkRepo.insertMany(rows, tx);
            },
            { timeout: Math.min(600_000, Math.max(120_000, rows.length * 40)) },
          );
        } else {
          await DocumentChunkRepo.insertMany(rows);
        }
        storeMs += Date.now() - tRoundEmbedded;
      }

      const tStored = Date.now();
      logger.info("Document extraction: timing (chunk, embed, store)", {
        documentId,
        chunkMs: tChunked - tExtracted,
        embedMs,
        storeMs,
        totalMs: tStored - tStart,
        chunks: chunks.length,
      });

      const { chunkCount, embeddedCount } = await DocumentChunkRepo.verify(documentId);
      if (chunkCount !== chunks.length || embeddedCount !== chunkCount) {
        logger.error("Document extraction: chunk verification mismatch", {
          documentId,
          expected: chunks.length,
          chunkCount,
          embeddedCount,
        });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      await DocumentRepo.updateRagStatus(documentId, "READY");
      logger.info("Document extraction: ready", { documentId, name: doc.name, chunks: chunks.length });

      const category = await categoryPromise;
      let savedCategory: string | null = doc.category ?? null;
      if (category) {
        await DocumentRepo.updateCategory(documentId, category)
          .then(() => {
            savedCategory = category;
          })
          .catch((categoryErr) => {
            logger.warn("Failed to save document category", { categoryErr, documentId });
          });
      }

      // After the category write (not right after READY) so a client that refetches on this
      // event already sees the category. The DB row has been READY since a moment ago, so a
      // client that polls instead loses nothing.
      DocumentExtractionSvc.emit(doc, "document:ready", "READY", { pageCount: pages.length, category: savedCategory });

      if (doc.caseId) {
        // Best-effort — must never bubble into the outer catch and flip an already-READY
        // document back to FAILED just because the audit-log insert failed.
        await OrganizationRepo.writeAudit({
          caseId: doc.caseId,
          action: "document.ready",
          payload: { id: documentId, name: doc.name },
        }).catch((auditErr) => {
          logger.warn("Failed to write document.ready audit event", { auditErr, documentId });
        });

        const { scheduleCasePostExtraction } = await import("../queues/case-post-extraction");
        scheduleCasePostExtraction(doc.caseId, doc.userId);
      }
    } catch (err) {
      logger.error("Document extraction failed", { err, documentId });
      if (partialChunksWritten) {
        await DocumentChunkRepo.deleteByDocument(documentId).catch((cleanupErr) => {
          logger.error("Failed to delete partial chunks after extraction error", { cleanupErr, documentId });
        });
      }
      // 429 is transient — leave PENDING so the next boot/retry can embed instead of
      // permanently skipping RAG for this document.
      const ragStatus = isRateLimit(err) ? "PENDING" : "FAILED";
      await DocumentExtractionSvc.setStatus(
        documentId,
        ragStatus,
        ragStatus === "PENDING" ? "document:retrying" : "document:failed",
      ).catch((updateErr) => {
        // P2025: the document was deleted (or its user/org cascaded away) while extraction
        // was still in flight — expected race with delete, not a real failure to surface.
        if (updateErr instanceof Prisma.PrismaClientKnownRequestError && updateErr.code === "P2025") {
          logger.info("Skipped ragStatus update: document no longer exists", { documentId, ragStatus });
          return;
        }
        logger.error("Failed to update ragStatus after extraction error", { updateErr, documentId, ragStatus });
      });
    }
  }
}
