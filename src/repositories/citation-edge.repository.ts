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

  static async createMany(edges: CitationEdgeCreateInput[]): Promise<void> {
    if (edges.length === 0) return;
    await prisma.citationEdge.createMany({ data: edges as Prisma.CitationEdgeCreateManyInput[] });
  }
}
