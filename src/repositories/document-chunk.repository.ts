import crypto from "crypto";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { isHybridRetrievalEnabled } from "../config";
import { buildLexicalQuery } from "../utils/hybridSearch";
import logger from "../utils/logger";

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
/** Lexical hits are *appended* to the vector selection, never fused into it — see
 * `findRelevantInScope`. These bound how much they can add: at most one extra chunk per
 * document, and at most this many extra chunks overall. Deliberately small; the lexical
 * channel's job is to catch the one exhibit/section reference cosine missed, not to
 * re-rank the pool. */
const LEXICAL_PER_DOC_CAP = 1;
const LEXICAL_EXTRA_SLOTS = 4;
/** A chunk whose digit-stripped text recurs this many times across the scope is a running page
 * header/footer ("… D07 / p.2" — identical on every page of every bundle document once digits
 * are removed), not content. Applied to the lexical channel only: a header line carrying the
 * document code matches an OR of exhibit references almost by construction, so without this it
 * would win the lexical ranking outright. The vector half is left exactly as the flag-off path
 * computes it. */
const BOILERPLATE_REPEAT_THRESHOLD = 3;

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

  /** Chunk ids ranked by Postgres full-text match, scoped to one document — the lexical
   * counterpart to `vectorIdsByDocument`. Catches exact tokens (section numbers, party names,
   * `[2019] UKSC 41`) that cosine similarity under-ranks. `queryText` is the raw question;
   * see `buildLexicalQuery` for how it becomes an OR of its references.
   * `websearch_to_tsquery` is used because it never throws on arbitrary user input. */
  static async lexicalIdsByDocument(
    caseDocumentId: string,
    queryText: string,
    limit = 10,
    client: DbClient = prisma,
  ): Promise<string[]> {
    const tsQuery = buildLexicalQuery(queryText);
    if (!tsQuery) return [];
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "CaseDocumentChunk"
      WHERE "caseDocumentId" = ${caseDocumentId}
        AND "chunkTsv" @@ websearch_to_tsquery('english', ${tsQuery})
      ORDER BY ts_rank_cd("chunkTsv", websearch_to_tsquery('english', ${tsQuery})) DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  }

  /** Most relevant chunk ids for one document. Callers embed the user's question (see
   * `embedding.ts::embedText`) and pass both the vector and the original text.
   *
   * With HYBRID_RETRIEVAL_ENABLED off (or a query with no exact references) this is the
   * vector-only ranking. With it on, the vector top-N is returned *unchanged* and up to
   * `LEXICAL_EXTRA_SLOTS` lexical-only chunks are appended after it — hybrid can only add
   * to what vector-only would have returned, never reorder or displace it (see
   * `findRelevantInScope` for why). A lexical failure (column missing, DB hiccup) degrades
   * to vector-only for that call rather than failing the chat turn. */
  static async findRelevantByDocument(
    caseDocumentId: string,
    queryEmbedding: number[],
    queryText: string,
    limit = 10,
    client: DbClient = prisma,
  ): Promise<string[]> {
    if (!isHybridRetrievalEnabled() || !buildLexicalQuery(queryText)) {
      return DocumentChunkRepo.vectorIdsByDocument(caseDocumentId, queryEmbedding, limit, client);
    }

    let degraded = false;
    const [vectorIds, lexicalIds] = await Promise.all([
      DocumentChunkRepo.vectorIdsByDocument(caseDocumentId, queryEmbedding, limit, client),
      // Over-fetch by `limit`: a lexical hit already in the vector selection adds nothing, so
      // fetch enough that overlap can't starve the append.
      DocumentChunkRepo.lexicalIdsByDocument(caseDocumentId, queryText, limit + LEXICAL_EXTRA_SLOTS, client).catch((err) => {
        degraded = true;
        logger.warn("hybrid retrieval: lexical search failed, using vector-only", { caseDocumentId, err });
        return [] as string[];
      }),
    ]);

    const selected = new Set(vectorIds);
    const appended = lexicalIds.filter((id) => !selected.has(id)).slice(0, LEXICAL_EXTRA_SLOTS);

    logger.debug("hybrid retrieval", {
      caseDocumentId,
      path: degraded ? "hybrid-degraded" : "hybrid",
      vectorSelected: vectorIds.length,
      lexicalCandidates: lexicalIds.length,
      lexicalAppended: appended.length,
      lexicalAppendedIds: appended,
    });
    return [...vectorIds, ...appended];
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
   * Vector-only (flag off): a document's ranking is cosine similarity, hits below 0.3 are
   * dropped, and the global order is similarity-desc. Hybrid (flag on): that exact vector
   * selection is returned first, then up to `LEXICAL_EXTRA_SLOTS` chunks that matched only
   * lexically are appended after it — so hybrid is a superset of vector-only and a lexical
   * hit can never take a floor slot away from a vector hit.
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

  /** Vector selection first, lexical appended second — never fused.
   *
   * The earlier implementation RRF-fused the two rankings and then sliced each document's
   * `startRank..endRank` window out of the *fused* order. With a per-document floor of 3 that
   * window is three slots wide, so every lexical hit that landed in it evicted a vector hit —
   * hybrid was substitutive, and the 2026-09-15 brackenmoor run scored 57.7 against
   * vector-only's 64 (see benchmarks/scores.md). RRF assumes a wide top-k to fuse into; over a
   * 3-slot window it is a coin flip on whether you traded down.
   *
   * So the vector half here is the untouched `vectorOnlyInScope` query — byte-identical to
   * what the flag-off path returns — and lexical-only chunks are appended after it, bounded by
   * `LEXICAL_PER_DOC_CAP` and `LEXICAL_EXTRA_SLOTS`. Any benchmark delta is therefore fully
   * attributable to the appended chunks, which is what makes the next A/B debuggable. */
  private static async findRelevantInScope(
    scope: Prisma.Sql,
    scopeLog: Record<string, string>,
    queryEmbedding: number[],
    queryText: string,
    perDocumentFloor: number,
    client: DbClient,
    startRank: number,
  ): Promise<ScopedChunkHit[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const endRank = startRank + perDocumentFloor - 1;
    const tsQuery = isHybridRetrievalEnabled() ? buildLexicalQuery(queryText) : "";

    if (!tsQuery) {
      return DocumentChunkRepo.vectorOnlyInScope(scope, vectorLiteral, startRank, endRank, client);
    }

    // `startRank` pages the vector window down each document; page the lexical window in step so
    // a "load more" call appends the *next* lexical hits rather than the ones page 1 already had.
    const page = Math.floor((startRank - 1) / perDocumentFloor);
    const lexicalStart = page * LEXICAL_PER_DOC_CAP + 1;
    const lexicalEnd = lexicalStart + LEXICAL_PER_DOC_CAP - 1;

    let degraded = false;
    const [vectorHits, lexicalHits] = await Promise.all([
      DocumentChunkRepo.vectorOnlyInScope(scope, vectorLiteral, startRank, endRank, client),
      DocumentChunkRepo.lexicalCandidatesInScope(scope, vectorLiteral, tsQuery, lexicalEnd, client).catch((err) => {
        degraded = true;
        logger.warn("hybrid retrieval: lexical search failed, using vector-only", { ...scopeLog, err });
        return [] as ScopedChunkHit[];
      }),
    ]);

    const appended = DocumentChunkRepo.appendableLexicalHits(vectorHits, lexicalHits, lexicalStart, lexicalEnd);
    logger.debug("hybrid retrieval", {
      ...scopeLog,
      path: degraded ? "hybrid-degraded" : "hybrid",
      vectorSelected: vectorHits.length,
      lexicalCandidates: lexicalHits.length,
      lexicalAppended: appended.length,
      lexicalAppendedIds: appended.map((h) => h.id),
      selectedIds: [...vectorHits, ...appended].map((h) => h.id),
    });
    return [...vectorHits, ...appended];
  }

  /** The pre-hybrid query, unchanged: per-document vector rank window, similarity floor, global
   * similarity-desc order and cap. */
  private static vectorOnlyInScope(
    scope: Prisma.Sql,
    vectorLiteral: string,
    startRank: number,
    endRank: number,
    client: DbClient,
  ): Promise<ScopedChunkHit[]> {
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

  /** READY chunks in scope, annotated with how often their digit-stripped text recurs across the
   * scope — see BOILERPLATE_REPEAT_THRESHOLD. Backs the lexical candidate query. */
  private static scopedChunksSql(scope: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT c.id, c."caseDocumentId", c.embedding, c."chunkTsv",
             count(*) OVER (
               PARTITION BY regexp_replace(lower(c."chunkText"), '[0-9]+', '', 'g')
             ) AS repeats
      FROM "CaseDocumentChunk" c
      INNER JOIN "Document" d ON d.id = c."caseDocumentId"
      WHERE ${scope}
        AND d."ragStatus" = 'READY'
    `;
  }

  /** Up to `maxDocRank` full-text hits per document, returned in scope-wide `ts_rank_cd` order —
   * the pool `appendableLexicalHits` draws from. Similarity is carried along (0 when the chunk
   * has no embedding) so an appended hit still carries a value for callers that read it.
   * Deliberately has no similarity floor: these chunks are extra, not competing for a floor
   * slot, so a lexically exact hit with weak cosine is exactly what we want here. */
  private static lexicalCandidatesInScope(
    scope: Prisma.Sql,
    vectorLiteral: string,
    tsQuery: string,
    maxDocRank: number,
    client: DbClient,
  ): Promise<ScopedChunkHit[]> {
    return client.$queryRaw<ScopedChunkHit[]>`
      WITH scoped AS (${DocumentChunkRepo.scopedChunksSql(scope)}),
      ranked AS (
        SELECT id, "caseDocumentId",
               COALESCE(1 - (embedding <=> ${vectorLiteral}::vector), 0) AS similarity,
               ts_rank_cd("chunkTsv", websearch_to_tsquery('english', ${tsQuery})) AS lexical_rank,
               ROW_NUMBER() OVER (
                 PARTITION BY "caseDocumentId"
                 ORDER BY ts_rank_cd("chunkTsv", websearch_to_tsquery('english', ${tsQuery})) DESC
               ) AS doc_rank
        FROM scoped
        WHERE repeats < ${BOILERPLATE_REPEAT_THRESHOLD}
          AND "chunkTsv" @@ websearch_to_tsquery('english', ${tsQuery})
      )
      SELECT id, "caseDocumentId", similarity
      FROM ranked
      WHERE doc_rank <= ${maxDocRank}
      ORDER BY lexical_rank DESC, similarity DESC
    `;
  }

  /** The lexical-only chunks that may be appended to `vectorHits`.
   *
   * Takes each document's `lexicalStart..lexicalEnd` slice of the lexical ranking, drops
   * anything the vector half already selected, and caps the result at `LEXICAL_EXTRA_SLOTS`
   * scope-wide in lexical-rank order. Ranking happens before the overlap filter so a chunk
   * both channels found consumes its document's slot rather than silently promoting the next
   * lexical hit — the per-document cap stays honest across pages. */
  private static appendableLexicalHits(
    vectorHits: ScopedChunkHit[],
    lexicalHits: ScopedChunkHit[],
    lexicalStart: number,
    lexicalEnd: number,
  ): ScopedChunkHit[] {
    const alreadySelected = new Set(vectorHits.map((h) => h.id));
    const rankPerDoc = new Map<string, number>();
    const appended: ScopedChunkHit[] = [];

    for (const hit of lexicalHits) {
      const rank = (rankPerDoc.get(hit.caseDocumentId) ?? 0) + 1;
      rankPerDoc.set(hit.caseDocumentId, rank);
      if (rank < lexicalStart || rank > lexicalEnd) continue;
      if (alreadySelected.has(hit.id)) continue;
      appended.push(hit);
      if (appended.length >= LEXICAL_EXTRA_SLOTS) break;
    }
    return appended;
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
