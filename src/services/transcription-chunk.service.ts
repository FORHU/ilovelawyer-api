import prisma from "../lib/prisma";
import TranscriptionChunkRepo from "../repositories/transcription-chunk.repository";
import { embedText } from "../utils/embedding";

const DEFAULT_LIMIT = 20;

/** Shape mirrors DocumentChunkSvc's RelevantCaseChunks, scoped to transcriptions instead. */
export interface RelevantTranscriptionChunks {
  transcriptionIds: string[];
  transcriptionChunkIds: string[];
}

export default class TranscriptionChunkSvc {
  static async relevantChunksForCase(
    caseId: string,
    query: string,
    limit = DEFAULT_LIMIT,
  ): Promise<RelevantTranscriptionChunks> {
    return TranscriptionChunkSvc.relevantChunksForScope({ caseId }, query, limit);
  }

  static async relevantChunksForConsultation(
    consultationId: string,
    query: string,
    limit = DEFAULT_LIMIT,
  ): Promise<RelevantTranscriptionChunks> {
    return TranscriptionChunkSvc.relevantChunksForScope({ consultationId }, query, limit);
  }

  private static async relevantChunksForScope(
    scope: { caseId: string } | { consultationId: string },
    query: string,
    limit: number,
  ): Promise<RelevantTranscriptionChunks> {
    const where =
      "caseId" in scope
        ? { caseId: scope.caseId, ragStatus: "READY" as const }
        : { consultationId: scope.consultationId, ragStatus: "READY" as const };

    try {
      const queryEmbedding = await embedText(query);
      const rows =
        "caseId" in scope
          ? await TranscriptionChunkRepo.findRelevantByCase(scope.caseId, queryEmbedding, limit)
          : await TranscriptionChunkRepo.findRelevantByConsultation(scope.consultationId, queryEmbedding, limit);
      const transcriptionIds = [...new Set(rows.map((r) => r.transcriptionId))];
      return {
        transcriptionIds,
        transcriptionChunkIds: rows.map((r) => r.id),
      };
    } catch {
      const transcriptions = await prisma.transcription.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      return {
        transcriptionIds: transcriptions.map((t) => t.id),
        transcriptionChunkIds: [],
      };
    }
  }

  /**
   * Build plain-text transcript context from ranked chunks, labeled separately from Case
   * Document grounding (ADR 0013: a parallel, independent block — never merged/ranked together).
   */
  static async formatGroundingContext(grounding: RelevantTranscriptionChunks, charCap = 12_000): Promise<string> {
    if (!grounding.transcriptionIds.length) return "";

    let chunkIds = grounding.transcriptionChunkIds ?? [];
    if (!chunkIds.length && grounding.transcriptionIds.length === 1) {
      chunkIds = await TranscriptionChunkRepo.findIdsByTranscription(grounding.transcriptionIds[0]);
    }
    if (!chunkIds.length) return "";

    const rows = await TranscriptionChunkRepo.findTextsByIds(chunkIds);
    if (!rows.length) return "";

    const transcriptions = await prisma.transcription.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.transcriptionId))] } },
      select: { id: true, title: true },
    });
    const titleById = new Map(transcriptions.map((t) => [t.id, t.title ?? "Untitled Transcription"]));

    const byTranscription = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTranscription.get(row.transcriptionId) ?? [];
      list.push(row.chunkText);
      byTranscription.set(row.transcriptionId, list);
    }

    const blocks: string[] = [];
    let used = 0;
    for (const [transcriptionId, texts] of byTranscription) {
      const header = `Transcript "${titleById.get(transcriptionId) ?? transcriptionId}" (id: ${transcriptionId}):`;
      let body = texts.join("\n\n");
      const room = charCap - used - header.length - 2;
      if (room <= 0) break;
      if (body.length > room) body = `${body.slice(0, room).trimEnd()}\n\n[...truncated...]`;
      blocks.push(`${header}\n${body}`);
      used += header.length + body.length + 2;
    }

    if (!blocks.length) return "";
    return (
      "[CASE TRANSCRIPTS — audio transcripts the user recorded/uploaded. Reference them directly " +
      "when relevant; do NOT treat them as public legal precedent. Do not ask the user to re-record " +
      "or re-upload these.]\n\n" +
      blocks.join("\n\n")
    );
  }
}
