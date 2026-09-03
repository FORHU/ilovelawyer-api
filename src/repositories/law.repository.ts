import prisma from "../lib/prisma";
import { LawCategory, Prisma } from "@prisma/client";
import TenantRepo from "./tenant.repository";
import HttpError from "../utils/http-error";

export type LawSortBy = "year" | "createdAt";
export type SortDir = "asc" | "desc";

export interface ListLawsParams {
  category?: LawCategory;
  q?: string;
  page: number;
  limit: number;
  sortBy: LawSortBy;
  sortDir: SortDir;
}

export default class LawRepo {
  /** Every Law row belongs to the legal system its data came from. juris.ph is PH-only,
   * so all rows resolve to the PH tenant — never the caller's org. */
  static async resolvePhTenantId(): Promise<string> {
    const tenantId = await TenantRepo.findIdByCode("PH");
    if (!tenantId) throw new HttpError('No Tenant seeded for code "PH"', 500);
    return tenantId;
  }

  /** jurisSourceId -> our row id, for the subset of the given ids we already store. */
  static async findStoredIds(jurisSourceIds: string[]): Promise<Map<string, string>> {
    if (jurisSourceIds.length === 0) return new Map();
    const rows = await prisma.law.findMany({
      where: { jurisSourceId: { in: jurisSourceIds } },
      select: { id: true, jurisSourceId: true },
    });
    return new Map(rows.map((r) => [r.jurisSourceId, r.id]));
  }

  static async createMany(data: Prisma.LawCreateManyInput[]): Promise<void> {
    if (data.length === 0) return;
    // skipDuplicates guards the race where the same jurisSourceId is inserted by a
    // concurrent search between findStoredIds and here.
    await prisma.law.createMany({ data, skipDuplicates: true });
  }

  /** The only write a dedup hit performs — keep the latest relevance signal, nothing else. */
  static async updateScore(jurisSourceId: string, score: number | null): Promise<void> {
    if (score === null || score === undefined) return;
    await prisma.law.updateMany({ where: { jurisSourceId }, data: { score } });
  }

  static async findByJurisSourceIds(jurisSourceIds: string[]) {
    if (jurisSourceIds.length === 0) return [];
    return prisma.law.findMany({ where: { jurisSourceId: { in: jurisSourceIds } } });
  }

  /** Primary lookup for LawSvc.search — plain ILIKE over the stored rows, PH tenant,
   * given category. juris.ph is only consulted when this returns nothing. */
  static async localSearch(params: { category: LawCategory; q: string; limit: number }) {
    const tenantId = await LawRepo.resolvePhTenantId();
    return prisma.law.findMany({
      where: {
        tenantId,
        category: params.category,
        OR: [
          { title: { contains: params.q, mode: "insensitive" } },
          { caseNumber: { contains: params.q, mode: "insensitive" } },
          { raNumber: { contains: params.q, mode: "insensitive" } },
          { facts: { contains: params.q, mode: "insensitive" } },
          { summary: { contains: params.q, mode: "insensitive" } },
        ],
      },
      orderBy: [{ year: { sort: "desc", nulls: "last" } }, { score: { sort: "desc", nulls: "last" } }],
      take: params.limit,
    });
  }

  /** Admin "stored laws" table — DB only, never touches juris.ph. */
  static async list(params: ListLawsParams) {
    const { category, q, page, limit, sortBy, sortDir } = params;

    const where: Prisma.LawWhereInput = {
      ...(category ? { category } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { caseNumber: { contains: q, mode: "insensitive" } },
              { raNumber: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [data, total] = await prisma.$transaction([
      prisma.law.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.law.count({ where }),
    ]);

    return { data, total };
  }
}
