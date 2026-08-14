import crypto from "crypto";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewChunk {
  transcriptionId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  embedding: number[];
}

// Rows per INSERT statement — see DocumentChunkRepo for why this needs batching.
const INSERT_BATCH_SIZE = 500;
const COLUMNS_PER_ROW = 6;

export default class TranscriptionChunkRepo {
  static async deleteByTranscription(transcriptionId: string, client: DbClient = prisma): Promise<void> {
    await client.$executeRaw`DELETE FROM "TranscriptionChunk" WHERE "transcriptionId" = ${transcriptionId}`;
  }

  static async insertMany(chunks: NewChunk[], client: DbClient = prisma): Promise<void> {
    for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + INSERT_BATCH_SIZE);
      const placeholders: string[] = [];
      const params: unknown[] = [];

      batch.forEach((chunk, row) => {
        const base = row * COLUMNS_PER_ROW;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, now())`,
        );
        params.push(
          crypto.randomUUID(),
          chunk.transcriptionId,
          chunk.chunkIndex,
          chunk.chunkText,
          chunk.charCount,
          `[${chunk.embedding.join(",")}]`,
        );
      });

      await client.$executeRawUnsafe(
        `INSERT INTO "TranscriptionChunk" (id, "transcriptionId", "chunkIndex", "chunkText", "charCount", embedding, "createdAt")
         VALUES ${placeholders.join(", ")}`,
        ...params,
      );
    }
  }

  /** Ordered chunk ids for a transcription — fallback for formatGroundingContext when ranking
   * returned no chunk ids but exactly one transcription matched (mirrors DocumentChunkRepo). */
  static async findIdsByTranscription(transcriptionId: string, client: DbClient = prisma): Promise<string[]> {
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "TranscriptionChunk"
      WHERE "transcriptionId" = ${transcriptionId}
      ORDER BY "chunkIndex" ASC
    `;
    return rows.map((row) => row.id);
  }

  /** Chunk text for a set of ids (preserves input order) — inlined into chat grounding context. */
  static async findTextsByIds(
    ids: string[],
    client: DbClient = prisma,
  ): Promise<{ id: string; transcriptionId: string; chunkText: string; chunkIndex: number }[]> {
    if (ids.length === 0) return [];
    const rows = await client.$queryRaw<{ id: string; transcriptionId: string; chunkText: string; chunkIndex: number }[]>`
      SELECT id, "transcriptionId", "chunkText", "chunkIndex"
      FROM "TranscriptionChunk"
      WHERE id IN (${Prisma.join(ids)})
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  }

  /** Chunk ids ranked by embedding similarity, scoped to READY transcriptions attached to a case. */
  static async findRelevantByCase(
    caseId: string,
    queryEmbedding: number[],
    limit = 20,
    client: DbClient = prisma,
  ): Promise<{ id: string; transcriptionId: string }[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    return client.$queryRaw<{ id: string; transcriptionId: string }[]>`
      SELECT c.id, c."transcriptionId"
      FROM "TranscriptionChunk" c
      INNER JOIN "Transcription" t ON t.id = c."transcriptionId"
      WHERE t."caseId" = ${caseId}
        AND t."ragStatus" = 'READY'
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `;
  }

  /** Same ranking as `findRelevantByCase`, scoped to READY transcriptions attached to a consultation. */
  static async findRelevantByConsultation(
    consultationId: string,
    queryEmbedding: number[],
    limit = 20,
    client: DbClient = prisma,
  ): Promise<{ id: string; transcriptionId: string }[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    return client.$queryRaw<{ id: string; transcriptionId: string }[]>`
      SELECT c.id, c."transcriptionId"
      FROM "TranscriptionChunk" c
      INNER JOIN "Transcription" t ON t.id = c."transcriptionId"
      WHERE t."consultationId" = ${consultationId}
        AND t."ragStatus" = 'READY'
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `;
  }

  /** Post-insert verification: chunk count and that every persisted row has a non-null embedding. */
  static async verify(transcriptionId: string, client: DbClient = prisma): Promise<{ chunkCount: number; embeddedCount: number }> {
    const rows = await client.$queryRaw<{ chunk_count: bigint; embedded_count: bigint }[]>`
      SELECT count(*) AS chunk_count, count(embedding) AS embedded_count
      FROM "TranscriptionChunk"
      WHERE "transcriptionId" = ${transcriptionId}
    `;
    const row = rows[0];
    return { chunkCount: Number(row?.chunk_count ?? 0), embeddedCount: Number(row?.embedded_count ?? 0) };
  }
}
