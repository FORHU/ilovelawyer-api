import { AuthorityKind, AuthoritySource, AuthorityStance } from "@prisma/client";
import prisma from "../lib/prisma";

export interface CaseAuthorityInput {
  kind: AuthorityKind;
  stance: AuthorityStance;
  title: string;
  subtitle?: string | null;
  citation?: string | null;
  rationale?: string | null;
  findingId?: string | null;
  resolvedLawId?: string | null;
  source?: AuthoritySource;
  jevStance?: AuthorityStance | null;
  jevConfidence?: number | null;
}

export default class CaseAuthorityRepo {
  static async list(caseId: string) {
    return prisma.caseAuthority.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  }

  static async create(caseId: string, data: CaseAuthorityInput) {
    return prisma.caseAuthority.create({ data: { caseId, ...data } });
  }

  static async update(
    id: string,
    caseId: string,
    data: Partial<Pick<CaseAuthorityInput, "stance" | "rationale" | "findingId">>,
  ) {
    const existing = await prisma.caseAuthority.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseAuthority.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const { count } = await prisma.caseAuthority.deleteMany({ where: { id, caseId } });
    return count > 0;
  }

  /** A ground is a LEGAL_ISSUE finding on the same case — anything else must not be linkable.
   * Returns its label (what Jev reads as the ground), or null when it isn't one. */
  static async findGroundLabel(findingId: string, caseId: string) {
    const finding = await prisma.caseFinding.findFirst({
      where: { id: findingId, caseId, category: "LEGAL_ISSUE" },
      select: { label: true },
    });
    return finding?.label ?? null;
  }
}
