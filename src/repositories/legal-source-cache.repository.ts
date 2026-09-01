import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { TenantCode } from "../types/tenant-code";
import TenantRepo from "./tenant.repository";
import HttpError from "../utils/http-error";

export default class LegalSourceCacheRepo {
  /** Cached per (normalizedKeyword, tenantId) — a UK query for "unfair dismissal" must
   * never be served the PH-analyzed cache entry for the same keyword. Public callers pass
   * the TenantCode; the real FK (tenantId) is resolved internally so this repo's callers
   * never need to know the Tenant table's id shape. */
  static async findByNormalizedKeyword(normalizedKeyword: string, tenantCode: TenantCode) {
    const tenantId = await LegalSourceCacheRepo.requireTenantId(tenantCode);
    return prisma.legalSourceAnalysisCache.findUnique({
      where: { normalizedKeyword_tenantId: { normalizedKeyword, tenantId } },
    });
  }

  static async upsert(data: {
    rawKeyword: string;
    normalizedKeyword: string;
    tenantCode: TenantCode;
    title: string;
    markdownContent: string;
    rawResponse: string;
    sourceUrl?: string | null;
    metadataJson?: unknown;
  }) {
    const { normalizedKeyword, tenantCode, metadataJson, ...rest } = data;
    const tenantId = await LegalSourceCacheRepo.requireTenantId(tenantCode);
    const json = (metadataJson ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    return prisma.legalSourceAnalysisCache.upsert({
      where: { normalizedKeyword_tenantId: { normalizedKeyword, tenantId } },
      update: { ...rest, metadataJson: json },
      create: { normalizedKeyword, tenantId, ...rest, metadataJson: json },
    });
  }

  private static async requireTenantId(tenantCode: TenantCode): Promise<string> {
    const tenantId = await TenantRepo.findIdByCode(tenantCode);
    if (!tenantId) throw new HttpError(`No Tenant seeded for code "${tenantCode}"`, 500);
    return tenantId;
  }
}
