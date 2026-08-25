import prisma from "../lib/prisma";
import { CitationValidityStatus } from "@prisma/client";

export default class CitationCheckRepo {
  static async list(caseId: string) {
    return prisma.citationCheck.findMany({ where: { caseId }, orderBy: { checkedAt: "desc" } });
  }

  static async create(
    caseId: string,
    data: {
      quotedText: string;
      citedReference?: string | null;
      sourceUrl?: string | null;
      officialText?: string | null;
      status: CitationValidityStatus;
      notes: string;
    },
  ) {
    return prisma.citationCheck.create({ data: { caseId, ...data } });
  }
}
