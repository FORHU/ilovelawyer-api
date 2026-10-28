import type { CaseArea, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { LawyerCountry } from "../constants/lawyer-application.constants";
import { CLIENT_CASE_COUNTRY } from "../constants/case-area.constants";

const ORDER = [{ sortOrder: "asc" }, { name: "asc" }] satisfies Prisma.CaseAreaOrderByWithRelationInput[];

export default class CaseAreaRepo {
  /** Every area on the site, switched-off ones too, in picker order. */
  static async list(country: LawyerCountry): Promise<CaseArea[]> {
    return prisma.caseArea.findMany({ where: { country }, orderBy: ORDER });
  }

  static async find(id: string) {
    return prisma.caseArea.findUnique({ where: { id } });
  }

  /** The area on this site with this name, whatever its case — the unique index's rule. */
  static async findByName(country: LawyerCountry, name: string) {
    return prisma.caseArea.findFirst({ where: { country, name: { equals: name, mode: "insensitive" } } });
  }

  static async findByCode(country: LawyerCountry, code: string) {
    return prisma.caseArea.findUnique({ where: { country_code: { country, code } } });
  }

  /** How many cases have each of the site's codes, and how many of its practice areas map to each.
   * Cases carry no site: they're all CLIENT_CASE_COUNTRY's, so another site's areas count none. */
  static async usage(country: LawyerCountry, codes: string[]): Promise<Map<string, { cases: number; practiceAreas: number }>> {
    const usage = new Map(codes.map((code) => [code, { cases: 0, practiceAreas: 0 }]));
    if (codes.length === 0) return usage;
    const [cases, practiceAreas] = await Promise.all([
      country === CLIENT_CASE_COUNTRY
        ? prisma.$queryRaw<{ code: string; n: number }[]>`
            SELECT code, count(*)::int AS n FROM "Case", unnest("caseAreas") AS code
            WHERE code = ANY(${codes}) GROUP BY code`
        : [],
      prisma.practiceArea.groupBy({ by: ["caseArea"], where: { country, caseArea: { in: codes } }, _count: { _all: true } }),
    ]);
    for (const { code, n } of cases) usage.get(code)!.cases = n;
    for (const row of practiceAreas) usage.get(row.caseArea!)!.practiceAreas = row._count._all;
    return usage;
  }

  static async maxSortOrder(country: LawyerCountry): Promise<number> {
    const { _max } = await prisma.caseArea.aggregate({ where: { country }, _max: { sortOrder: true } });
    return _max.sortOrder ?? -1;
  }

  static async create(data: Pick<CaseArea, "country" | "code" | "name" | "description" | "sortOrder">) {
    return prisma.caseArea.create({ data });
  }

  static async update(id: string, data: Partial<Pick<CaseArea, "name" | "description" | "isActive">>) {
    return prisma.caseArea.update({ where: { id }, data });
  }

  static async delete(id: string) {
    return prisma.caseArea.delete({ where: { id } });
  }

  /** Numbers the site's areas in the order given. */
  static async reorder(ids: string[]) {
    await prisma.$transaction(ids.map((id, sortOrder) => prisma.caseArea.update({ where: { id }, data: { sortOrder } })));
  }
}
