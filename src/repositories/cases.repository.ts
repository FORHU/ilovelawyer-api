import legalRagPrisma from "../lib/legal-rag-prisma";
import { Prisma } from "../generated/legal-rag-client";

interface ListParams {
  page: number;
  limit: number;
  category?: string;
  year?: number;
  search?: string;
}

export default class CasesRepo {
  static async list({ page, limit, category, year, search }: ListParams) {
    const skip = (page - 1) * limit;

    const where: Prisma.DocumentWhereInput = {};

    if (category) where.category = { equals: category, mode: "insensitive" };
    if (year) where.year = year;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { case_no: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await legalRagPrisma.$transaction([
      legalRagPrisma.document.count({ where }),
      legalRagPrisma.document.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          case_no: true,
          year: true,
          category: true,
          subcategory: true,
          concise_summary: true,
          source_url: true,
        },
        orderBy: { year: "desc" },
      }),
    ]);

    return {
      total,
      data: rows.map((r) => ({ ...r, id: r.id.toString() })),
    };
  }

  static async findById(id: bigint) {
    const doc = await legalRagPrisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        case_no: true,
        year: true,
        category: true,
        subcategory: true,
        source_url: true,
        summary: true,
        concise_summary: true,
        full_text: true,
        formatted_markdown: true,
        metadata_json: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!doc) return null;
    return { ...doc, id: doc.id.toString() };
  }
}
