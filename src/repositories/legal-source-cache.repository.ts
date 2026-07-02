import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

export default class LegalSourceCacheRepo {
  static async findByNormalizedKeyword(normalizedKeyword: string) {
    return prisma.legalSourceAnalysisCache.findUnique({ where: { normalizedKeyword } });
  }

  static async upsert(data: {
    rawKeyword: string;
    normalizedKeyword: string;
    title: string;
    markdownContent: string;
    rawResponse: string;
    sourceUrl?: string | null;
    metadataJson?: unknown;
  }) {
    const { normalizedKeyword, metadataJson, ...rest } = data;
    const json = (metadataJson ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    return prisma.legalSourceAnalysisCache.upsert({
      where: { normalizedKeyword },
      update: { ...rest, metadataJson: json },
      create: { normalizedKeyword, ...rest, metadataJson: json },
    });
  }
}
