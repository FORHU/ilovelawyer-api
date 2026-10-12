import { LlmProvider, LlmUsageSource, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { LLM_USAGE_TOP_N } from "../constants/llm-usage.constants";

/** Filter value for "rows with no user / organization recorded" (background work nobody could be
 * attributed to). A real id never equals it. */
export const LLM_USAGE_NONE = "none";

export interface LlmUsageFilter {
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  provider?: LlmProvider;
  model?: string;
  feature?: string;
  source?: LlmUsageSource;
  organizationId?: string;
  userId?: string;
  caseId?: string;
}

function toWhere(filter: LlmUsageFilter): Prisma.LlmUsageWhereInput {
  const where: Prisma.LlmUsageWhereInput = {};
  if (filter.provider) where.provider = filter.provider;
  if (filter.model) where.model = filter.model;
  if (filter.feature) where.feature = filter.feature;
  if (filter.source) where.source = filter.source;
  if (filter.organizationId) where.organizationId = filter.organizationId === LLM_USAGE_NONE ? null : filter.organizationId;
  if (filter.userId) where.userId = filter.userId === LLM_USAGE_NONE ? null : filter.userId;
  if (filter.caseId) where.caseId = filter.caseId;
  if (filter.from || filter.to) where.createdAt = { ...(filter.from && { gte: filter.from }), ...(filter.to && { lt: filter.to }) };
  return where;
}

/** The same filter as raw SQL conditions, for the per-day query. */
function toSqlConditions(filter: LlmUsageFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.from) conditions.push(Prisma.sql`"createdAt" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`"createdAt" < ${filter.to}`);
  if (filter.provider) conditions.push(Prisma.sql`"provider" = ${filter.provider}::"LlmProvider"`);
  if (filter.model) conditions.push(Prisma.sql`"model" = ${filter.model}`);
  if (filter.feature) conditions.push(Prisma.sql`"feature" = ${filter.feature}`);
  if (filter.source) conditions.push(Prisma.sql`"source" = ${filter.source}::"LlmUsageSource"`);
  if (filter.organizationId) {
    conditions.push(filter.organizationId === LLM_USAGE_NONE ? Prisma.sql`"organizationId" IS NULL` : Prisma.sql`"organizationId" = ${filter.organizationId}`);
  }
  if (filter.userId) conditions.push(filter.userId === LLM_USAGE_NONE ? Prisma.sql`"userId" IS NULL` : Prisma.sql`"userId" = ${filter.userId}`);
  if (filter.caseId) conditions.push(Prisma.sql`"caseId" = ${filter.caseId}`);
  return conditions;
}

const SUMS = { inputTokens: true, outputTokens: true, cachedInputTokens: true, totalTokens: true, estimatedCostUsd: true } as const;

export interface LlmUsageGroup {
  key: string | null;
  source: LlmUsageSource;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** Sum over the rows that have a price; rows with no price add nothing. */
  costUsd: number;
  /** Calls whose cost is null (no verified price for the model, or no model reported). Their cost is
   * unknown, not zero, so a total over them must not be read as complete. */
  unpricedCalls: number;
}

export interface LlmUsageDayRow {
  day: Date;
  source: LlmUsageSource;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

type GroupedRow = {
  _count: { _all: number; estimatedCostUsd: number };
  _sum: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null; estimatedCostUsd: number | null };
};

function group(key: string | null, source: LlmUsageSource, row: GroupedRow): LlmUsageGroup {
  return {
    key,
    source,
    calls: row._count._all,
    inputTokens: row._sum.inputTokens ?? 0,
    outputTokens: row._sum.outputTokens ?? 0,
    cachedInputTokens: row._sum.cachedInputTokens ?? 0,
    totalTokens: row._sum.totalTokens ?? 0,
    costUsd: row._sum.estimatedCostUsd ?? 0,
    // _count of a column counts its non-null values.
    unpricedCalls: row._count._all - row._count.estimatedCostUsd,
  };
}

export type LlmUsageDimension = "provider" | "model" | "feature" | "organizationId" | "userId";

export default class LlmUsageRepo {
  static async create(data: Prisma.LlmUsageUncheckedCreateInput) {
    return prisma.llmUsage.create({ data });
  }

  /** Newest first. */
  static async list(filter: LlmUsageFilter, take: number, skip: number) {
    return prisma.llmUsage.findMany({ where: toWhere(filter), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, skip });
  }

  static async count(filter: LlmUsageFilter) {
    return prisma.llmUsage.count({ where: toWhere(filter) });
  }

  /** Every row's call count and sums, split by source, for the whole filter. */
  static async totalsBySource(filter: LlmUsageFilter): Promise<LlmUsageGroup[]> {
    const rows = await prisma.llmUsage.groupBy({ by: ["source"], where: toWhere(filter), _count: { _all: true, estimatedCostUsd: true }, _sum: SUMS });
    return rows.map((row) => group(null, row.source, row));
  }

  /** Calls whose cost could not be computed — a model with no verified price (llm-pricing.constants). */
  static async countUnpriced(filter: LlmUsageFilter) {
    return prisma.llmUsage.count({ where: { ...toWhere(filter), estimatedCostUsd: null } });
  }

  /** The filter grouped by one column and by source. A null key (an unknown model, a call with no
   * organization) is kept, not dropped. */
  static async groupBy(filter: LlmUsageFilter, dimension: LlmUsageDimension): Promise<LlmUsageGroup[]> {
    const rows = await prisma.llmUsage.groupBy({
      by: [dimension, "source"],
      where: toWhere(filter),
      _count: { _all: true, estimatedCostUsd: true },
      _sum: SUMS,
    });
    return rows.map((row) => group((row[dimension] as string | null) ?? null, row.source, row));
  }

  /** The `take` organizations or users that used the most tokens (rows with no id are left out). */
  static async topBy(filter: LlmUsageFilter, dimension: "organizationId" | "userId", take = LLM_USAGE_TOP_N): Promise<LlmUsageGroup[]> {
    const rows = await prisma.llmUsage.groupBy({
      by: [dimension],
      // AND, not a spread: for these two dimensions the filter may already name the same column
      // (organizationId, userId), and a spread would let "is not null" replace the caller's filter.
      where: { AND: [toWhere(filter), { [dimension]: { not: null } }] },
      _count: { _all: true, estimatedCostUsd: true },
      _sum: SUMS,
      orderBy: { _sum: { totalTokens: "desc" } },
      take,
    });
    // `source` is not a grouping here, so the row stands for both; the caller shows totals only.
    return rows.map((row) => group(row[dimension] as string, "REPORTED", row));
  }

  /** Per UTC day, split by source. */
  static async byDay(filter: LlmUsageFilter): Promise<LlmUsageDayRow[]> {
    const conditions = toSqlConditions(filter);
    const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ day: Date; source: LlmUsageSource; calls: bigint; totalTokens: bigint | null; costUsd: number | null }[]>(Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS "day", "source", COUNT(*) AS "calls",
             SUM("totalTokens") AS "totalTokens", SUM("estimatedCostUsd") AS "costUsd"
      FROM "LlmUsage" ${where}
      GROUP BY 1, 2 ORDER BY 1 ASC`);
    return rows.map((row) => ({ day: row.day, source: row.source, calls: Number(row.calls), totalTokens: Number(row.totalTokens ?? 0), costUsd: row.costUsd ?? 0 }));
  }

  /** Who owns a case, for attributing the LLM work done on it. Null for an id that is not a case. */
  static async findCaseOwner(caseId: string) {
    return prisma.case.findUnique({ where: { id: caseId }, select: { userId: true, organizationId: true } });
  }

  static async findDocumentOwner(documentId: string) {
    return prisma.document.findUnique({ where: { id: documentId }, select: { userId: true, organizationId: true, caseId: true, consultationId: true } });
  }

  /** The users and organizations with a row in the filter's range, plus whether any rows name none:
   * what the admin page's "who" filters list. They narrow each other: with an organization chosen,
   * only users who have usage in it are listed; with a user chosen, only that user's organizations.
   * Each list ignores its own filter, so choosing one never empties the list it was chosen from.
   * Ids come from the ledger, so a deleted account still appears, nameless. */
  static async distinctPeople(filter: LlmUsageFilter) {
    const range = toWhere({ from: filter.from, to: filter.to });
    const inOrganization = toWhere({ organizationId: filter.organizationId });
    const byUser = toWhere({ userId: filter.userId });
    const [users, orgs, noUser, noOrg] = await Promise.all([
      prisma.llmUsage.groupBy({ by: ["userId"], where: { AND: [range, inOrganization, { userId: { not: null } }] } }),
      prisma.llmUsage.groupBy({ by: ["organizationId"], where: { AND: [range, byUser, { organizationId: { not: null } }] } }),
      prisma.llmUsage.count({ where: { AND: [range, inOrganization, { userId: null }] } }),
      prisma.llmUsage.count({ where: { AND: [range, byUser, { organizationId: null }] } }),
    ]);
    return {
      userIds: users.map((r) => r.userId as string),
      organizationIds: orgs.map((r) => r.organizationId as string),
      hasNoUser: noUser > 0,
      hasNoOrganization: noOrg > 0,
    };
  }

  static async findOrganizationNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  }

  static async findUserNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } });
  }
}
