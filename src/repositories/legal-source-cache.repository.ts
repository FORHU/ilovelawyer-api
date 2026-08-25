import prisma from "../lib/prisma";
import { Prisma, Jurisdiction } from "@prisma/client";

export default class LegalSourceCacheRepo {
  /** Cached per (normalizedKeyword, jurisdiction) — a UK query for "unfair dismissal" must
   * never be served the PH-analyzed cache entry for the same keyword. */
  static async findByNormalizedKeyword(normalizedKeyword: string, jurisdiction: Jurisdiction) {
    return prisma.legalSourceAnalysisCache.findUnique({
      where: { normalizedKeyword_jurisdiction: { normalizedKeyword, jurisdiction } },
    });
  }

  static async upsert(data: {
    rawKeyword: string;
    normalizedKeyword: string;
    jurisdiction: Jurisdiction;
    title: string;
    markdownContent: string;
    rawResponse: string;
    sourceUrl?: string | null;
    metadataJson?: unknown;
  }) {
    const { normalizedKeyword, jurisdiction, metadataJson, ...rest } = data;
    const json = (metadataJson ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    return prisma.legalSourceAnalysisCache.upsert({
      where: { normalizedKeyword_jurisdiction: { normalizedKeyword, jurisdiction } },
      update: { ...rest, metadataJson: json },
      create: { normalizedKeyword, jurisdiction, ...rest, metadataJson: json },
    });
  }
}
