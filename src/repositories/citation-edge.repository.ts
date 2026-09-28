import prisma from "../lib/prisma";
import { CitationTreatment, Prisma } from "@prisma/client";

export interface CitationEdgeCreateInput {
  fromLawId: string;
  toLawId?: string | null;
  toRawReference?: string | null;
  toRawTitle?: string | null;
  treatment: CitationTreatment;
  /** UK-only: "case" | "legislation" | "si" | "eu", from the UK Legal MCP's citations_network
   * grouping. Left undefined/null for PH edges. */
  citationType?: string | null;
  excerpt?: string | null;
  confidence?: number | null;
}

export default class CitationEdgeRepo {
  static async listByFromLaw(fromLawId: string) {
    return prisma.citationEdge.findMany({
      where: { fromLawId },
      include: { toLaw: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Edges from later decisions that treated any of `toLawIds` negatively — what the Citation
   * Map's adverse sweep looks for. Only edges already extracted into the corpus exist here. */
  static async listNegativeTreatmentsOf(toLawIds: string[]) {
    if (toLawIds.length === 0) return [];
    return prisma.citationEdge.findMany({
      where: { toLawId: { in: toLawIds }, treatment: { in: ["OVERRULED", "ABANDONED", "DISTINGUISHED"] } },
      include: { fromLaw: { select: { title: true, caseNumber: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  static async createMany(edges: CitationEdgeCreateInput[]): Promise<void> {
    if (edges.length === 0) return;
    await prisma.citationEdge.createMany({ data: edges as Prisma.CitationEdgeCreateManyInput[] });
  }
}
