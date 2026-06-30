import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

interface ListParams {
  page: number;
  limit: number;
  category?: string;
  year?: number;
  search?: string;
}

interface CaseSummaryRow {
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

interface CaseDetailRow {
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

export default class CasesRepo {
  static async list({ page, limit, category, year, search }: ListParams) {
    const offset = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [];
    if (category) conditions.push(Prisma.sql`category ILIKE ${category}`);
    if (year) conditions.push(Prisma.sql`year = ${year}`);
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(Prisma.sql`(title ILIKE ${pattern} OR case_no ILIKE ${pattern})`);
    }

    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

    const rows = await prisma.$queryRaw<CaseSummaryRow[]>`
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
    const rows = await prisma.$queryRaw<CaseDetailRow[]>`
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
}
