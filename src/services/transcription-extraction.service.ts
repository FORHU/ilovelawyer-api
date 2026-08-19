import prisma from "../lib/prisma";
import TranscriptionRepo from "../repositories/transcription.repository";
import TranscriptionChunkRepo from "../repositories/transcription-chunk.repository";
import { chunkText } from "../utils/chunking";
import { embedTexts } from "../utils/embedding";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// Same batching/concurrency tuning as DocumentExtractionSvc (src/services/document-extraction.service.ts)
// — no reason to retune for transcripts, which reuse the exact same chunk/embed pipeline.
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_CONCURRENCY = 5;

export default class TranscriptionExtractionSvc {
  /**
   * Chunking → embedding → storage pipeline for a Transcription (ADR 0013). Unlike
   * DocumentExtractionSvc, there's no extraction step — `Transcription.transcript` is already
   * plain text (AWS Transcribe result, fetched and speaker-formatted in transcription.service.ts).
   * Dispatched explicitly via POST /api/transcriptions/:id/chunk, not fire-and-forget — this call
   * is awaited end to end so the caller gets back the final ragStatus.
   */
  static async process(transcriptionId: string): Promise<{ ragStatus: "READY" | "FAILED"; chunkCount: number }> {
    const transcription = await TranscriptionRepo.findByIdAny(transcriptionId);
    if (!transcription) throw new HttpError("Transcription not found", 404);

    const trimmed = (transcription.transcript ?? "").trim();

    // Empty transcript (job never completed, or AWS returned nothing) counts as failed, not ready.
    if (!trimmed) {
      await TranscriptionRepo.updateRagStatus(transcriptionId, "FAILED");
      return { ragStatus: "FAILED", chunkCount: 0 };
    }

    const chunks = chunkText(trimmed);
    if (chunks.length === 0) {
      await TranscriptionRepo.updateRagStatus(transcriptionId, "FAILED");
      return { ragStatus: "FAILED", chunkCount: 0 };
    }

    try {
      const batches: string[][] = [];
      for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        batches.push(chunks.slice(i, i + EMBEDDING_BATCH_SIZE));
      }

      const embeddedChunks: { transcriptionId: string; chunkIndex: number; chunkText: string; charCount: number; embedding: number[] }[] = [];
      for (let i = 0; i < batches.length; i += EMBEDDING_CONCURRENCY) {
        const group = batches.slice(i, i + EMBEDDING_CONCURRENCY);
        const groupEmbeddings = await Promise.all(group.map((batch) => embedTexts(batch)));
        group.forEach((batch, g) => {
          const baseChunkIndex = (i + g) * EMBEDDING_BATCH_SIZE;
          batch.forEach((chunk, j) =>
            embeddedChunks.push({
              transcriptionId,
              chunkIndex: baseChunkIndex + j,
              chunkText: chunk,
              charCount: chunk.length,
              embedding: groupEmbeddings[g][j],
            }),
          );
        });
      }

      await prisma.$transaction(
        async (tx) => {
          await TranscriptionChunkRepo.deleteByTranscription(transcriptionId, tx);
          await TranscriptionChunkRepo.insertMany(embeddedChunks, tx);
        },
        { timeout: 120_000 },
      );

      const { chunkCount, embeddedCount } = await TranscriptionChunkRepo.verify(transcriptionId);
      if (chunkCount !== embeddedChunks.length || embeddedCount !== chunkCount) {
        logger.error("Transcription chunking: chunk verification mismatch", {
          transcriptionId,
          expected: embeddedChunks.length,
          chunkCount,
          embeddedCount,
        });
        await TranscriptionRepo.updateRagStatus(transcriptionId, "FAILED");
        return { ragStatus: "FAILED", chunkCount };
      }

      await TranscriptionRepo.updateRagStatus(transcriptionId, "READY");
      return { ragStatus: "READY", chunkCount };
    } catch (err) {
      logger.error("Transcription chunking failed", { err, transcriptionId });
      await TranscriptionRepo.updateRagStatus(transcriptionId, "FAILED").catch((updateErr) => {
        logger.error("Failed to mark transcription FAILED after chunking error", { updateErr, transcriptionId });
      });
      return { ragStatus: "FAILED", chunkCount: 0 };
    }
  }
}
