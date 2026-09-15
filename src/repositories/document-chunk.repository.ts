import crypto from "crypto";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

/** One ranked chunk from a case- or consultation-scoped search. */
export interface ScopedChunkHit {
  id: string;
  caseDocumentId: string;
  similarity: number;
}

interface NewChunk {
  caseDocumentId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  embedding: number[];
  pageNumber?: number | null;
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
const COLUMNS_PER_ROW = 7;

// Rows per SELECT page when reading chunks back out with embeddings included — see
// findByDocument for why this needs to be paged rather than a single query.
const SELECT_BATCH_SIZE = 200;

/** Cosine similarity floor (`1 - <=>`). Matches ADR 0010's minSimilarity 0.3 so weak
 * neighbors do not consume the 12k inlined-context budget. */
const MIN_CHUNK_SIMILARITY = 0.3;
/** After the per-document floor, keep only the strongest hits for chat-wonder inlining. */
const GLOBAL_RELEVANT_CHUNK_LIMIT = 24;

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
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, $${base + 7}, now())`,
        );
        params.push(
          crypto.randomUUID(),
          chunk.caseDocumentId,
          chunk.chunkIndex,
          chunk.chunkText,
          chunk.charCount,
          `[${chunk.embedding.join(",")}]`,
          chunk.pageNumber ?? null,
        );
      });

      await client.$executeRawUnsafe(
        `INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", embedding, "pageNumber", "createdAt")
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

  /** Chunk text for a set of ids (preserves input order). Used to inline grounding into
   * chat-wonder's document_context when the callback fetch to this API may fail. */
  static async findTextsByIds(
    ids: string[],
    client: DbClient = prisma,
  ): Promise<{ id: string; caseDocumentId: string; chunkText: string; chunkIndex: number; pageNumber: number | null }[]> {
    if (ids.length === 0) return [];
    const rows = await client.$queryRaw<{ id: string; caseDocumentId: string; chunkText: string; chunkIndex: number; pageNumber: number | null }[]>`
      SELECT id, "caseDocumentId", "chunkText", "chunkIndex", "pageNumber"
      FROM "CaseDocumentChunk"
      WHERE id IN (${Prisma.join(ids)})
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  }

  /** Chunk ids ranked by embedding similarity (pgvector cosine distance, `<=>`) against a
   * query embedding, scoped to one document. This is what actually uses the `embedding`
   * column stored per chunk — `findIdsByDocument` above returns every chunk unfiltered and
   * never touches it. */
  static async vectorIdsByDocument(
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

  /** Most relevant chunk ids for one document, by cosine similarity. Callers embed the user's
   * question (see `embedding.ts::embedText`) and pass the resulting vector.
   *
   * `queryText` is accepted but currently unused — lexical/hybrid ranking (Postgres
   * `ts_rank_cd`, later a fixed-cap additive append) lived here through 2026-09-15 and was
   * removed: two designs (RRF fusion, then additive append) both regressed the brackenmoor
   * benchmark, and chat-wonder-v2-api now does its own BM25-based relevance ranking on the
   * one path that actually needed it (the whole-document fallback fetch in
   * get_case_document, see chat-wonder-v2-api's bm25.py) — see benchmarks/scores.md and this
   * repo's git history on chore/embedding/bm25-approach for the full record. Kept as a
   * parameter (rather than removed from every call site up through chat.service.ts) so a
   * future lexical channel doesn't require re-threading it back through the service layer. */
  static async findRelevantByDocument(
    caseDocumentId: string,
    queryEmbedding: number[],
    queryText: string,
    limit = 10,
    client: DbClient = prisma,
  ): Promise<string[]> {
    void queryText;
    return DocumentChunkRepo.vectorIdsByDocument(caseDocumentId, queryEmbedding, limit, client);
  }

  /** Same ranking + per-document floor as `findRelevantByCase`, but scoped to READY documents
   * attached to a consultation. */
  static async findRelevantByConsultation(
    consultationId: string,
    queryEmbedding: number[],
    queryText: string,
    perDocumentFloor = 3,
    client: DbClient = prisma,
    startRank = 1,
  ): Promise<ScopedChunkHit[]> {
    return DocumentChunkRepo.findRelevantInScope(
      Prisma.sql`d."consultationId" = ${consultationId}`,
      { consultationId },
      queryEmbedding,
      queryText,
      perDocumentFloor,
      client,
      startRank,
    );
  }

  /** Same ranking as `findRelevantByDocument`, but across every READY document under a case —
   * with a per-document floor so a case with many documents doesn't let a few large/textually-
   * similar documents crowd out every chunk slot from smaller or less-similar-worded ones. Each
   * READY document contributes up to `perDocumentFloor` of its own best-ranked chunks (or all of
   * them, if it has fewer); that set is then globally capped so `formatGroundingContext`'s 12k
   * char budget is spent on the strongest hits first. Returns chunk id + owning document id
   * (plus similarity) so callers can build chat-wonder's `case_document_ids` +
   * `case_document_chunk_ids` payload in rank order.
   *
   * A document's ranking is cosine similarity, hits below 0.3 are dropped, and the global
   * order is similarity-desc. (Lexical/hybrid ranking used to layer on top of this — see
   * `findRelevantByDocument`'s docstring for where it went.)
   *
   * `startRank` pages further down each document's own ranking (1-based, inclusive) — the
   * initial call uses the default (rank 1..perDocumentFloor); a follow-up "load more relevant
   * chunks" call passes `startRank = perDocumentFloor + 1` (etc.) to fetch the next slice
   * per document instead of re-returning the same top chunks. */
  static async findRelevantByCase(
    caseId: string,
    queryEmbedding: number[],
    queryText: string,
    perDocumentFloor = 3,
    client: DbClient = prisma,
    startRank = 1,
  ): Promise<ScopedChunkHit[]> {
    return DocumentChunkRepo.findRelevantInScope(
      Prisma.sql`d."caseId" = ${caseId}`,
      { caseId },
      queryEmbedding,
      queryText,
      perDocumentFloor,
      client,
      startRank,
    );
  }

  /** Chunk ids for one case/consultation scope, ranked by cosine similarity within a
   * per-document rank window (`startRank..endRank`) — see `findRelevantByCase`'s docstring for
   * why the window exists. `queryText` is accepted but unused; see `findRelevantByDocument`'s
   * docstring for why (lexical/hybrid ranking lived here through 2026-09-15, then moved to
   * chat-wonder-v2-api). */
  private static async findRelevantInScope(
    scope: Prisma.Sql,
    scopeLog: Record<string, string>,
    queryEmbedding: number[],
    queryText: string,
    perDocumentFloor: number,
    client: DbClient,
    startRank: number,
  ): Promise<ScopedChunkHit[]> {
    void queryText;
    void scopeLog;
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const endRank = startRank + perDocumentFloor - 1;

    return client.$queryRaw<ScopedChunkHit[]>`
      WITH ranked AS (
        SELECT c.id, c."caseDocumentId",
               1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity,
               ROW_NUMBER() OVER (
                 PARTITION BY c."caseDocumentId"
                 ORDER BY c.embedding <=> ${vectorLiteral}::vector
               ) AS doc_rank
        FROM "CaseDocumentChunk" c
        INNER JOIN "Document" d ON d.id = c."caseDocumentId"
        WHERE ${scope}
          AND d."ragStatus" = 'READY'
          AND c.embedding IS NOT NULL
      )
      SELECT id, "caseDocumentId", similarity
      FROM ranked
      WHERE doc_rank BETWEEN ${startRank} AND ${endRank}
        AND similarity >= ${MIN_CHUNK_SIMILARITY}
      ORDER BY similarity DESC
      LIMIT ${GLOBAL_RELEVANT_CHUNK_LIMIT}
    `;
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
  /**
   * Full text of several documents at once, joined from their chunks in chunkIndex order —
   * no embeddings pulled (unlike findByDocument), so it stays cheap for a whole case. Used to
   * inline a small bundle into a chat turn whole (see chatWonder.ts fullTextsFor): the
   * Brackenmoor benchmark showed the model treating a relevance-filtered fetch as the entire
   * exhibit, so for bundles that fit the budget we hand it every document in full up front.
   */
  static async findFullTextsByDocuments(
    caseDocumentIds: string[],
    client: DbClient = prisma,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!caseDocumentIds.length) return out;
    const rows = await client.caseDocumentChunk.findMany({
      where: { caseDocumentId: { in: caseDocumentIds } },
      select: { caseDocumentId: true, chunkIndex: true, chunkText: true },
      orderBy: [{ caseDocumentId: "asc" }, { chunkIndex: "asc" }],
    });
    const parts = new Map<string, string[]>();
    for (const r of rows) {
      const list = parts.get(r.caseDocumentId) ?? [];
      list.push(r.chunkText);
      parts.set(r.caseDocumentId, list);
    }
    for (const [id, list] of parts) out.set(id, list.join("\n"));
    return out;
  }

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
