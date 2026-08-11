import crypto from "crypto";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewChunk {
  caseDocumentId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  embedding: number[];
}

export interface DocumentChunkRow {
  id: string;
  caseDocumentId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  createdAt: Date;
  embedding: number[] | null;
}

interface RawChunkRow extends Omit<DocumentChunkRow, "embedding"> {
  embedding: string | null;
}

// pgvector's text form is "[0.012,-0.034,...]" — strip the brackets and split, since Prisma has
// no native vector type to parse this into an array for us.
function parseVector(text: string | null): number[] | null {
  if (!text) return null;
  return text.slice(1, -1).split(",").map(Number);
}

// Rows per INSERT statement. A document can produce tens of thousands of chunks (e.g. a 50MB
// PDF) — one round-trip per row blows past Prisma's interactive-transaction timeout, so rows are
// batched into multi-row VALUES statements instead.
const INSERT_BATCH_SIZE = 500;
const COLUMNS_PER_ROW = 6;

// Rows per SELECT page when reading chunks back out with embeddings included — see
// findByDocument for why this needs to be paged rather than a single query.
const SELECT_BATCH_SIZE = 200;

export default class DocumentChunkRepo {
  static async deleteByDocument(caseDocumentId: string, client: DbClient = prisma): Promise<void> {
    await client.$executeRaw`DELETE FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${caseDocumentId}`;
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
          chunk.caseDocumentId,
          chunk.chunkIndex,
          chunk.chunkText,
          chunk.charCount,
          `[${chunk.embedding.join(",")}]`,
        );
      });

      await client.$executeRawUnsafe(
        `INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", embedding, "createdAt")
         VALUES ${placeholders.join(", ")}`,
        ...params,
      );
    }
  }

  /** Ordered chunk ids for a document — for callers (e.g. the Chat Wonder request payload)
   * that only need to reference chunks, not their content. */
  static async findIdsByDocument(caseDocumentId: string, client: DbClient = prisma): Promise<string[]> {
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "CaseDocumentChunk"
      WHERE "caseDocumentId" = ${caseDocumentId}
      ORDER BY "chunkIndex" ASC
    `;
    return rows.map((row) => row.id);
  }

  /** Chunk ids ranked by embedding similarity (pgvector cosine distance, `<=>`) against a
   * query embedding, scoped to one document. This is what actually uses the `embedding`
   * column stored per chunk — `findIdsByDocument` above returns every chunk unfiltered and
   * never touches it. Callers embed the user's question (see `embedding.ts::embedText`) and
   * pass the resulting vector in here to get back only the most relevant chunks. */
  static async findRelevantByDocument(
    caseDocumentId: string,
    queryEmbedding: number[],
    limit = 10,
    client: DbClient = prisma,
  ): Promise<string[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "CaseDocumentChunk"
      WHERE "caseDocumentId" = ${caseDocumentId}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  }

  /**
   * Ordered chunk listing for a document, including each chunk's embedding vector. `embedding`
   * is an `Unsupported` Prisma type, so it's cast to text in SQL and parsed back into a number
   * array here rather than selected via the query builder.
   *
   * Fetched in pages of SELECT_BATCH_SIZE rather than one `$queryRaw` call: each embedding
   * serializes to ~15-20KB of text, and a large document's full chunk set can push a single
   * call's total result size past Prisma's napi string-conversion limit ("Failed to convert
   * rust `String` into napi `string`", prisma/prisma#13864). Paging keeps each call's payload
   * bounded; the final in-memory array is still the full chunk set.
   */
  static async findByDocument(caseDocumentId: string, client: DbClient = prisma): Promise<DocumentChunkRow[]> {
    const rows: RawChunkRow[] = [];
    let offset = 0;

    for (;;) {
      const batch = await client.$queryRaw<RawChunkRow[]>`
        SELECT id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", "createdAt", embedding::text AS embedding
        FROM "CaseDocumentChunk"
        WHERE "caseDocumentId" = ${caseDocumentId}
        ORDER BY "chunkIndex" ASC
        LIMIT ${SELECT_BATCH_SIZE} OFFSET ${offset}
      `;
      rows.push(...batch);
      if (batch.length < SELECT_BATCH_SIZE) break;
      offset += SELECT_BATCH_SIZE;
    }

    return rows.map((row) => ({ ...row, embedding: parseVector(row.embedding) }));
  }

  /**
   * Post-processing verification (task step 4): confirms chunk count and that every
   * persisted row actually has a non-null embedding vector, not just a row count match.
   */
  static async verify(caseDocumentId: string, client: DbClient = prisma): Promise<{ chunkCount: number; embeddedCount: number }> {
    const rows = await client.$queryRaw<{ chunk_count: bigint; embedded_count: bigint }[]>`
      SELECT count(*) AS chunk_count, count(embedding) AS embedded_count
      FROM "CaseDocumentChunk"
      WHERE "caseDocumentId" = ${caseDocumentId}
    `;
    const row = rows[0];
    return { chunkCount: Number(row?.chunk_count ?? 0), embeddedCount: Number(row?.embedded_count ?? 0) };
  }
}
