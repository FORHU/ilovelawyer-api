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
  pageNumber?: number | null;
}

export interface DocumentChunkRow {
  id: string;
  caseDocumentId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  createdAt: Date;
}

// Rows per INSERT statement. A document can produce tens of thousands of chunks (e.g. a 50MB
// PDF) — one round-trip per row blows past Prisma's interactive-transaction timeout, so rows are
// batched into multi-row VALUES statements instead.
const INSERT_BATCH_SIZE = 500;
const COLUMNS_PER_ROW = 7;

// Rows per SELECT page when reading chunks back out — see findByDocument for why this needs to
// be paged rather than a single query.
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

  /** Chunk text on one page of a document, in reading order — the passage a mind map node cites
   * as `{ documentId, page }` (mind-map-jev.ts). Empty when the document has no chunks on that
   * page (or wasn't extracted page-by-page). */
  static async findTextsByPage(
    caseDocumentId: string,
    pageNumber: number,
    client: DbClient = prisma,
  ): Promise<string[]> {
    const rows = await client.$queryRaw<{ chunkText: string }[]>`
      SELECT "chunkText"
      FROM "CaseDocumentChunk"
      WHERE "caseDocumentId" = ${caseDocumentId} AND "pageNumber" = ${pageNumber}
      ORDER BY "chunkIndex" ASC
    `;
    return rows.map((row) => row.chunkText);
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

  /** Same ranking + per-document floor as `findRelevantByCase`, but scoped to READY documents
   * attached to a consultation. Results are similarity-desc, weak hits dropped, then globally
   * capped — see `findRelevantByCase`. */
  static async findRelevantByConsultation(
    consultationId: string,
    queryEmbedding: number[],
    perDocumentFloor = 3,
    client: DbClient = prisma,
    startRank = 1,
  ): Promise<{ id: string; caseDocumentId: string; similarity: number }[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const endRank = startRank + perDocumentFloor - 1;
    return client.$queryRaw<{ id: string; caseDocumentId: string; similarity: number }[]>`
      WITH ranked AS (
        SELECT c.id, c."caseDocumentId",
               1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity,
               ROW_NUMBER() OVER (
                 PARTITION BY c."caseDocumentId"
                 ORDER BY c.embedding <=> ${vectorLiteral}::vector
               ) AS doc_rank
        FROM "CaseDocumentChunk" c
        INNER JOIN "Document" d ON d.id = c."caseDocumentId"
        WHERE d."consultationId" = ${consultationId}
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

  /** Same ranking as `findRelevantByDocument`, but across every READY document under a case —
   * with a per-document floor so a case with many documents doesn't let a few large/textually-
   * similar documents crowd out every chunk slot from smaller or less-similar-worded ones. Each
   * READY document contributes up to `perDocumentFloor` of its own best-ranked chunks (or all of
   * them, if it has fewer); that set is then filtered to cosine similarity >= 0.3 and globally
   * capped so `formatGroundingContext`'s 12k char budget is spent on the strongest hits first.
   * Returns chunk id + owning document id (plus similarity) so callers can build chat-wonder's
   * `case_document_ids` + `case_document_chunk_ids` payload in rank order.
   *
   * `startRank` pages further down each document's own ranking (1-based, inclusive) — the
   * initial call uses the default (rank 1..perDocumentFloor); a follow-up "load more relevant
   * chunks" call passes `startRank = perDocumentFloor + 1` (etc.) to fetch the next slice
   * per document instead of re-returning the same top chunks. */
  /**
   * For each of `chunkIds`, its `perChunk` most similar other chunks among the same set with
   * cosine similarity >= `minSimilarity` — pairs of passages likely about the same thing. Computed
   * in Postgres (never pulls embeddings into JS); the set is the few hundred chunks that contain
   * a fact, so the self-join stays small. Each unordered pair may appear from both sides.
   */
  static async findSimilarChunkPairs(
    chunkIds: string[],
    minSimilarity: number,
    perChunk: number,
    client: DbClient = prisma,
  ): Promise<{ a: string; b: string; similarity: number }[]> {
    if (chunkIds.length < 2) return [];
    return client.$queryRaw<{ a: string; b: string; similarity: number }[]>`
      WITH pairs AS (
        SELECT x.id AS a, y.id AS b, 1 - (x.embedding <=> y.embedding) AS similarity
        FROM "CaseDocumentChunk" x
        JOIN "CaseDocumentChunk" y ON x.id <> y.id
        WHERE x.id = ANY(${chunkIds}) AND y.id = ANY(${chunkIds})
          AND x.embedding IS NOT NULL AND y.embedding IS NOT NULL
      ), ranked AS (
        SELECT a, b, similarity, ROW_NUMBER() OVER (PARTITION BY a ORDER BY similarity DESC) AS rn
        FROM pairs
        WHERE similarity >= ${minSimilarity}
      )
      SELECT a, b, similarity::float8 AS similarity FROM ranked WHERE rn <= ${perChunk}
    `;
  }

  static async findRelevantByCase(
    caseId: string,
    queryEmbedding: number[],
    perDocumentFloor = 3,
    client: DbClient = prisma,
    startRank = 1,
  ): Promise<{ id: string; caseDocumentId: string; similarity: number }[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const endRank = startRank + perDocumentFloor - 1;
    return client.$queryRaw<{ id: string; caseDocumentId: string; similarity: number }[]>`
      WITH ranked AS (
        SELECT c.id, c."caseDocumentId",
               1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity,
               ROW_NUMBER() OVER (
                 PARTITION BY c."caseDocumentId"
                 ORDER BY c.embedding <=> ${vectorLiteral}::vector
               ) AS doc_rank
        FROM "CaseDocumentChunk" c
        INNER JOIN "Document" d ON d.id = c."caseDocumentId"
        WHERE d."caseId" = ${caseId}
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
   * Ordered chunk listing for a document (text only, no embedding — the only consumer of this,
   * chat-wonder-v2-api's get_case_document, reads just `id`/`chunkText`; ranking against a query
   * is done server-side in Postgres via findRelevantBy*, which never materializes embeddings
   * into JS). Fetched in pages of SELECT_BATCH_SIZE rather than one `$queryRaw` call: a large
   * document's full chunk set (tens of thousands of rows, up to EMBEDDING_CHAR_CAP chars each)
   * can still push a single call's total result size past Prisma's napi string-conversion limit
   * ("Failed to convert rust `String` into napi `string`", prisma/prisma#13864). Paging keeps
   * each call's payload bounded; the final in-memory array is still the full chunk set.
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
    const rows: DocumentChunkRow[] = [];
    let offset = 0;

    for (;;) {
      const batch = await client.$queryRaw<DocumentChunkRow[]>`
        SELECT id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", "createdAt"
        FROM "CaseDocumentChunk"
        WHERE "caseDocumentId" = ${caseDocumentId}
        ORDER BY "chunkIndex" ASC
        LIMIT ${SELECT_BATCH_SIZE} OFFSET ${offset}
      `;
      rows.push(...batch);
      if (batch.length < SELECT_BATCH_SIZE) break;
      offset += SELECT_BATCH_SIZE;
    }

    return rows;
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
