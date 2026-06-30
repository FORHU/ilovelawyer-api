import ragPool from "../lib/db-rag";

interface ListParams {
  page: number;
  limit: number;
  category?: string;
  year?: number;
  search?: string;
}

interface CaseSummaryRow {
  id: number;
  title: string | null;
  case_no: string | null;
  year: number | null;
  category: string;
  subcategory: string | null;
  concise_summary: string | null;
  source_url: string | null;
  total_count: string;
}

interface CaseDetailRow {
  id: number;
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

export default class CasesRepo {
  static async list({ page, limit, category, year, search }: ListParams) {
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (category) {
      params.push(category);
      conditions.push(`category ILIKE $${params.length}`);
    }
    if (year) {
      params.push(year);
      conditions.push(`year = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(title ILIKE $${params.length} OR case_no ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await ragPool.query<CaseSummaryRow>(
      `SELECT id, title, case_no, year, category, subcategory, concise_summary, source_url,
              COUNT(*) OVER() AS total_count
       FROM documents
       ${where}
       ORDER BY year DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    return {
      total,
      data: rows.map(({ total_count, id, ...rest }) => ({ id: id.toString(), ...rest })),
    };
  }

  static async findById(id: bigint) {
    const { rows } = await ragPool.query<CaseDetailRow>(
      `SELECT id, title, case_no, year, category, subcategory, source_url, summary,
              concise_summary, full_text, formatted_markdown, metadata_json, created_at, updated_at
       FROM documents
       WHERE id = $1
       LIMIT 1`,
      [id.toString()],
    );

    const doc = rows[0];
    if (!doc) return null;

    return { ...doc, id: doc.id.toString() };
  }
}
