import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

interface ListParams {
  page: number;
  limit: number;
  category?: string;
  subcategory?: string;
  /** When true, filters to rows with subcategory IS NULL (exact — excludes any tagged subcategory). Takes precedence over `subcategory`. */
  noSubcategory?: boolean;
  year?: number;
  search?: string;
}

interface LegalRagSummaryRow {
  id: bigint;
  title: string | null;
  case_no: string | null;
  year: number | null;
  category: string;
  subcategory: string | null;
  concise_summary: string | null;
  source_url: string | null;
  total_count: bigint;
}

interface LegalRagDetailRow {
  id: bigint;
  title: string | null;
  case_no: string | null;
  year: number | null;
  category: string;
  subcategory: string | null;
  source_url: string | null;
  summary: string | null;
  concise_summary: string | null;
  full_text: string | null;
  formatted_markdown: string | null;
  metadata_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface VectorSearchRow {
  chunk_text: string;
  document_id: bigint;
  title: string | null;
  category: string;
}

interface RelatedCaseTermRow {
  id: bigint;
  title: string | null;
  case_no: string | null;
  year: number | null;
  category: string;
  source_url: string | null;
  concise_summary: string | null;
}

interface RelatedRow {
  id: bigint;
  title: string | null;
  case_no: string | null;
  category: string;
  subcategory: string | null;
  year: number | null;
  concise_summary: string | null;
  similarity: number;
}

interface ChunkVectorSearchRow {
  id: bigint;
  document_id: bigint;
  chunk_index: number;
  chunk_text: string;
  char_count: number;
  created_at: Date;
  similarity: number;
  doc_title: string | null;
  doc_category: string;
  doc_subcategory: string | null;
  doc_case_no: string | null;
  doc_year: number | null;
  doc_source_url: string | null;
  doc_concise_summary: string | null;
}

export default class LegalRagRepo {
  static async getCategories(): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ category: string }[]>`
      SELECT DISTINCT category FROM documents WHERE category IS NOT NULL ORDER BY category ASC
    `;
    return rows.map((r) => r.category);
  }

  static async getSubcategories(category: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ subcategory: string }[]>`
      SELECT DISTINCT subcategory FROM documents
      WHERE category = ${category} AND subcategory IS NOT NULL
      ORDER BY subcategory ASC
    `;
    return rows.map((r) => r.subcategory);
  }

  /**
   * `noSubcategory: true` filters to subcategory IS NULL exactly, excluding any tagged
   * subcategory — required whenever a section item must not overlap with a sibling item
   * that filters on a specific subcategory value under the same category.
   */
  static async countByCategory(category: string, subcategory?: string, noSubcategory?: boolean): Promise<number> {
    const conditions: Prisma.Sql[] = [Prisma.sql`category = ${category}`];
    if (noSubcategory) conditions.push(Prisma.sql`subcategory IS NULL`);
    else if (subcategory) conditions.push(Prisma.sql`subcategory = ${subcategory}`);

    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM documents WHERE ${Prisma.join(conditions, " AND ")}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  static async searchByVector(embedding: number[], limit = 5): Promise<VectorSearchRow[]> {
    const vector = `[${embedding.join(",")}]`;
    return prisma.$queryRawUnsafe<VectorSearchRow[]>(
      `SELECT dc.chunk_text, dc.document_id, d.title, d.category
       FROM document_chunks dc
       JOIN documents d ON dc.document_id = d.id
       ORDER BY dc.embedding <=> $1::vector
       LIMIT $2`,
      vector,
      limit,
    );
  }

  static async vectorSearch(
    embedding: number[],
    { limit = 10, offset = 0, minSimilarity = 0.3 }: { limit?: number; offset?: number; minSimilarity?: number } = {},
  ): Promise<ChunkVectorSearchRow[]> {
    const vector = `[${embedding.join(",")}]`;
    return prisma.$queryRawUnsafe<ChunkVectorSearchRow[]>(
      `SELECT
         dc.id, dc.document_id, dc.chunk_index, dc.chunk_text, dc.char_count, dc.created_at,
         1 - (dc.embedding <=> $1::vector) AS similarity,
         d.title       AS doc_title,
         d.category    AS doc_category,
         d.subcategory AS doc_subcategory,
         d.case_no     AS doc_case_no,
         d.year        AS doc_year,
         d.source_url  AS doc_source_url,
         d.concise_summary AS doc_concise_summary
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE 1 - (dc.embedding <=> $1::vector) >= $2
       ORDER BY dc.embedding <=> $1::vector
       LIMIT $3 OFFSET $4`,
      vector,
      minSimilarity,
      limit,
      offset,
    );
  }

  /** Resolves a citation term (e.g. "Article 297", "GR No. 185222") — as surfaced by Chat
   * Wonder's [RELATED_QUERIES] tag — to the document it identifies, preferring an exact
   * case-number hit over a looser title match. */
  static async findForRelatedTerm(term: string): Promise<RelatedCaseTermRow | null> {
    const pattern = `%${term}%`;
    const rows = await prisma.$queryRaw<RelatedCaseTermRow[]>`
      SELECT id, title, case_no, year, category, source_url, concise_summary
      FROM documents
      WHERE title ILIKE ${pattern} OR case_no ILIKE ${pattern}
      ORDER BY
        CASE WHEN case_no ILIKE ${pattern} THEN 0 ELSE 1 END,
        year DESC NULLS LAST
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  static async findRelated(id: bigint, limit = 5): Promise<RelatedRow[]> {
    const rows = await prisma.$queryRaw<RelatedRow[]>`
      WITH avg_embedding AS (
        SELECT avg(embedding)::vector AS embedding
        FROM document_chunks
        WHERE document_id = ${id}
      )
      SELECT DISTINCT ON (d.id)
        d.id, d.title, d.case_no, d.category, d.subcategory, d.year, d.concise_summary,
        1 - (dc.embedding <=> avg_embedding.embedding) AS similarity
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      CROSS JOIN avg_embedding
      WHERE d.id != ${id}
        AND avg_embedding.embedding IS NOT NULL
        AND 1 - (dc.embedding <=> avg_embedding.embedding) >= 0.5
      ORDER BY d.id, dc.embedding <=> avg_embedding.embedding
      LIMIT 20
    `;

    return rows.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  static async list({ page, limit, category, subcategory, noSubcategory, year, search }: ListParams) {
    const offset = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [];
    if (category) conditions.push(Prisma.sql`category ILIKE ${category}`);
    if (noSubcategory) conditions.push(Prisma.sql`subcategory IS NULL`);
    else if (subcategory) conditions.push(Prisma.sql`subcategory ILIKE ${subcategory}`);
    if (year) conditions.push(Prisma.sql`year = ${year}`);
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(Prisma.sql`(title ILIKE ${pattern} OR case_no ILIKE ${pattern})`);
    }

    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

    const rows = await prisma.$queryRaw<LegalRagSummaryRow[]>`
      SELECT id, title, case_no, year, category, subcategory, concise_summary, source_url,
             COUNT(*) OVER() AS total_count
      FROM documents
      ${where}
      ORDER BY year DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;

    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

    return {
      total,
      data: rows.map(({ total_count, id, ...rest }) => ({ id: id.toString(), ...rest })),
    };
  }

  static async findById(id: bigint) {
    const rows = await prisma.$queryRaw<LegalRagDetailRow[]>`
      SELECT id, title, case_no, year, category, subcategory, source_url, summary,
             concise_summary, full_text, formatted_markdown, metadata_json, created_at, updated_at
      FROM documents
      WHERE id = ${id}
      LIMIT 1
    `;

    const doc = rows[0];
    if (!doc) return null;

    return { ...doc, id: doc.id.toString() };
  }

  static async findByIdForSourcePage(id: bigint) {
    const rows = await prisma.$queryRaw<LegalRagDetailRow[]>`
      SELECT id, title, case_no, year, category, subcategory, source_url, summary,
             concise_summary, full_text, formatted_markdown, metadata_json
      FROM documents
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  static async findByTitleOrCaseNo(titleHint: string) {
    const loose = `%${titleHint}%`;
    const rows = await prisma.$queryRaw<LegalRagDetailRow[]>`
      SELECT id, title, case_no, year, category, subcategory, source_url, summary,
             concise_summary, full_text, formatted_markdown, metadata_json
      FROM documents
      WHERE title ILIKE ${loose} OR case_no ILIKE ${loose}
      ORDER BY
        CASE
          WHEN lower(title) = lower(${titleHint}) THEN 0
          WHEN title ILIKE ${loose} THEN 1
          WHEN case_no ILIKE ${loose} THEN 2
          ELSE 3
        END,
        year DESC NULLS LAST,
        id DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
}
