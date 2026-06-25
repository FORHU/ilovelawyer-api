import ragPool from "../lib/ragDb";

export interface RagDocument {
  id: number;
  source_hash: string;
  bucket_slug: string;
  category: string;
  subcategory: string | null;
  title: string | null;
  case_no: string | null;
  year: number | null;
  source_url: string | null;
  concise_summary: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentFilter {
  limit?: number;
  offset?: number;
  category?: string;
  subcategory?: string;
  year?: number;
  yearFrom?: number;
  yearTo?: number;
  libraries?: string[];
}

export default class LegalRagRepo {
  static async listDocuments(filter: DocumentFilter = {}): Promise<{ rows: RagDocument[]; total: number }> {
    const { limit = 20, offset = 0, category, subcategory, year, yearFrom, yearTo, libraries } = filter;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (subcategory) {
      params.push(subcategory);
      conditions.push(`subcategory = $${params.length}`);
    }
    if (year) {
      params.push(year);
      conditions.push(`year = $${params.length}`);
    }
    if (yearFrom) {
      params.push(yearFrom);
      conditions.push(`year >= $${params.length}`);
    }
    if (yearTo) {
      params.push(yearTo);
      conditions.push(`year <= $${params.length}`);
    }
    if (libraries && libraries.length > 0) {
      const libConditions = libraries.map((lib) => {
        params.push(`%${lib}%`);
        return `(title ILIKE $${params.length} OR subcategory ILIKE $${params.length})`;
      });
      conditions.push(`(${libConditions.join(" OR ")})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows: rawRows } = await ragPool.query<RagDocument & { total_count: string }>(
      `SELECT id, source_hash, bucket_slug, category, subcategory, title,
              case_no, year, source_url, concise_summary, created_at, updated_at,
              COUNT(*) OVER() AS total_count
       FROM documents
       ${where}
       ORDER BY year ASC NULLS LAST, case_no ASC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = rawRows.length > 0 ? parseInt(rawRows[0].total_count, 10) : 0;
    return { rows: rawRows, total };
  }

  static async searchDocumentsByKeyword(
    query: string,
    opts: { limit?: number; offset?: number; yearFrom?: number; yearTo?: number; libraries?: string[]; category?: string; subcategory?: string } = {},
  ): Promise<{ rows: RagDocument[]; total: number }> {
    const { limit = 20, offset = 0, yearFrom, yearTo, category, subcategory } = opts;

    const keywords = query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);

    if (keywords.length === 0) return { rows: [], total: 0 };

    const params: unknown[] = [];
    const keywordConditions: string[] = [];

    for (const word of keywords) {
      const pattern = `%${word}%`;
      params.push(pattern);
      const i = params.length;
      keywordConditions.push(`(title ILIKE $${i} OR concise_summary ILIKE $${i} OR full_text ILIKE $${i})`);
    }

    const andConditions: string[] = [`(${keywordConditions.join(" OR ")})`];

    if (category) {
      params.push(category);
      andConditions.push(`category = $${params.length}`);
    }
    if (subcategory) {
      params.push(subcategory);
      andConditions.push(`subcategory = $${params.length}`);
    }
    if (yearFrom) {
      params.push(yearFrom);
      andConditions.push(`year >= $${params.length}`);
    }
    if (yearTo) {
      params.push(yearTo);
      andConditions.push(`year <= $${params.length}`);
    }

    const where = `WHERE ${andConditions.join(" AND ")}`;
    params.push(limit, offset);

    const { rows: rawRows } = await ragPool.query<RagDocument & { total_count: string }>(
      `SELECT id, source_hash, bucket_slug, category, subcategory, title,
              case_no, year, source_url, concise_summary, created_at, updated_at,
              COUNT(*) OVER() AS total_count
       FROM documents
       ${where}
       ORDER BY year ASC NULLS LAST, case_no ASC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = rawRows.length > 0 ? parseInt(rawRows[0].total_count, 10) : 0;
    return { rows: rawRows, total };
  }
}
