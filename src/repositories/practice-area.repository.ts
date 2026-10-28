import type { PracticeArea, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { LawyerCountry } from "../constants/lawyer-application.constants";

/** A practice area as a lawyer's profile carries it. */
export type PracticeAreaRef = Pick<PracticeArea, "id" | "name" | "caseArea" | "isActive" | "sortOrder">;

/** How a profile query includes its practice areas; toPracticeAreaRefs reads the result. */
export const PRACTICE_AREAS_INCLUDE = { practiceAreas: { include: { practiceArea: true } } } satisfies Prisma.LawyerClientProfileInclude;

/** A profile's practice areas from PRACTICE_AREAS_INCLUDE, in the site's picker order. */
export function toPracticeAreaRefs(links: { practiceArea: PracticeArea }[]): PracticeAreaRef[] {
  return links
    .map(({ practiceArea: { id, name, caseArea, isActive, sortOrder } }) => ({ id, name, caseArea, isActive, sortOrder }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

const ORDER = [{ sortOrder: "asc" }, { name: "asc" }] satisfies Prisma.PracticeAreaOrderByWithRelationInput[];

export default class PracticeAreaRepo {
  /** What a lawyer on this site can pick. */
  static async listActive(country: LawyerCountry) {
    return prisma.practiceArea.findMany({ where: { country, isActive: true }, orderBy: ORDER, select: { id: true, name: true } });
  }

  /** Every area on the site, inactive ones too, with how many lawyers hold each. */
  static async listForAdmin(country: LawyerCountry) {
    return prisma.practiceArea.findMany({ where: { country }, orderBy: ORDER, include: { _count: { select: { lawyers: true } } } });
  }

  static async find(id: string) {
    return prisma.practiceArea.findUnique({ where: { id }, include: { _count: { select: { lawyers: true } } } });
  }

  static async findByIds(ids: string[]): Promise<PracticeArea[]> {
    if (ids.length === 0) return [];
    return prisma.practiceArea.findMany({ where: { id: { in: ids } } });
  }

  /** The area on this site with this name, whatever its case — the unique index's rule. */
  static async findByName(country: LawyerCountry, name: string) {
    return prisma.practiceArea.findFirst({ where: { country, name: { equals: name, mode: "insensitive" } } });
  }

  static async listIds(country: LawyerCountry): Promise<string[]> {
    return (await prisma.practiceArea.findMany({ where: { country }, select: { id: true } })).map((r) => r.id);
  }

  static async maxSortOrder(country: LawyerCountry): Promise<number> {
    const { _max } = await prisma.practiceArea.aggregate({ where: { country }, _max: { sortOrder: true } });
    return _max.sortOrder ?? -1;
  }

  static async create(data: Pick<PracticeArea, "country" | "name" | "caseArea" | "sortOrder">) {
    return prisma.practiceArea.create({ data });
  }

  static async update(id: string, data: Partial<Pick<PracticeArea, "name" | "caseArea" | "isActive">>) {
    return prisma.practiceArea.update({ where: { id }, data });
  }

  /** Fails on the foreign key if a lawyer holds it (LawyerPracticeArea's onDelete: Restrict). */
  static async delete(id: string) {
    return prisma.practiceArea.delete({ where: { id } });
  }

  /** Numbers the site's areas in the order given. */
  static async reorder(ids: string[]) {
    await prisma.$transaction(ids.map((id, sortOrder) => prisma.practiceArea.update({ where: { id }, data: { sortOrder } })));
  }
}
