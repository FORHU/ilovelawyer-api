import { LlmProvider, LlmUsageSource, Prisma } from "@prisma/client";
import LlmUsageRepo, { LlmUsageDayRow, LlmUsageFilter, LlmUsageGroup } from "../repositories/llm-usage.repository";
import { getRequestContext } from "../lib/request-context";
import { getLlmUsageScope, LlmUsageScope, runInLlmUsageScope } from "../lib/llm-usage-scope";
import { estimateCostUsd } from "../constants/llm-pricing.constants";
import { LLM_USAGE_TOP_N } from "../constants/llm-usage.constants";
import logger from "../utils/logger";
import { JevUsageEntry, setJevUsageRecorder } from "../utils/typesafeClient";

export interface LlmUsageEntry {
  provider: LlmProvider;
  /** "chat-wonder" | "direct" */
  via?: string | null;
  /** Null when the provider didn't say (Chat Wonder, until #104). */
  model?: string | null;
  /** An AiGenerationKind, "chat", "embedding", "jev:citation-validity", ... */
  feature: string;
  source: LlmUsageSource;
  inputTokens: number;
  outputTokens: number;
  /** A subset of inputTokens, when the provider reports it. */
  cachedInputTokens?: number | null;
  passCount?: number | null;
  /** Default to the current request's user and organization. Pass null for "no one" (a queue or
   * cron run has no request context). */
  userId?: string | null;
  organizationId?: string | null;
  caseId?: string | null;
  consultationId?: string | null;
  durationMs?: number | null;
  success?: boolean;
}

interface UsageTotals {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  calls: number;
}

const emptyTotals = (): UsageTotals => ({ tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, calls: 0 });

function addGroup(into: UsageTotals, g: LlmUsageGroup) {
  into.tokens += g.totalTokens;
  into.inputTokens += g.inputTokens;
  into.outputTokens += g.outputTokens;
  into.cachedInputTokens += g.cachedInputTokens;
  into.costUsd += g.costUsd;
  into.calls += g.calls;
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string | null;
  /** Calls in this row with no price. When it equals `calls` the row's cost is unknown, not $0. */
  unpricedCalls: number;
  estimated: UsageTotals;
  reported: UsageTotals;
}

/** Folds the per-source groups the repository returns into one row per key, with the ESTIMATED and
 * REPORTED parts kept apart so the page can show how much of a number is a guess. Biggest first. */
function breakdown(groups: LlmUsageGroup[]): UsageBreakdownRow[] {
  const rows = new Map<string | null, UsageBreakdownRow>();
  for (const g of groups) {
    let row = rows.get(g.key);
    if (!row) {
      row = { key: g.key, unpricedCalls: 0, ...emptyTotals(), estimated: emptyTotals(), reported: emptyTotals() };
      rows.set(g.key, row);
    }
    addGroup(row, g);
    row.unpricedCalls += g.unpricedCalls;
    addGroup(g.source === "ESTIMATED" ? row.estimated : row.reported, g);
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens);
}

export default class LlmUsageSvc {
  /** Records one LLM call. Fire-and-forget and never throws: it returns before the row is written,
   * and a bad entry or a failed write is logged, never raised — usage accounting must not slow
   * down, fail or change the call it measures. Unlike SecurityAuditSvc.record this is NOT awaited
   * by callers, because nothing downstream depends on the row existing. */
  static record(entry: LlmUsageEntry): void {
    try {
      const row = LlmUsageSvc.buildRow(entry);
      void Promise.resolve(LlmUsageRepo.create(row)).catch((err) => logger.warn("LLM usage: failed to write row", { err, feature: entry.feature }));
    } catch (err) {
      logger.warn("LLM usage: could not build row", { err, feature: entry?.feature });
    }
  }

  /** Records one Jev call, as reported by jevAsk's usage hook (#403, #407). Rows are named
   * `jev:<feature>` so a Jev check never shares a feature name with a Chat Wonder generation
   * (`mind-map` vs `mindMap`) in the admin breakdown. Attribution comes from the usage scope and
   * request context, like every other row. */
  static recordJev(entry: JevUsageEntry): void {
    LlmUsageSvc.record({
      provider: LlmProvider.TYPESAFE,
      via: "direct",
      source: LlmUsageSource.REPORTED,
      feature: `jev:${entry.feature || "unknown"}`,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      durationMs: entry.durationMs,
      success: entry.success,
    });
  }

  /** Plugs the ledger into jevAsk, so every Jev call records exactly one row. jevAsk is the only
   * way to call Jev (test/jev-ask-guard.spec.ts), so nothing else records Jev usage. Called once
   * at startup (src/server.ts). */
  static registerJevRecorder(): void {
    setJevUsageRecorder(LlmUsageSvc.recordJev);
  }

  private static buildRow(entry: LlmUsageEntry): Prisma.LlmUsageUncheckedCreateInput {
    const context = getRequestContext();
    const scope = getLlmUsageScope();
    const inputTokens = Math.max(0, Math.round(entry.inputTokens));
    const outputTokens = Math.max(0, Math.round(entry.outputTokens));
    const cachedInputTokens = entry.cachedInputTokens == null ? null : Math.max(0, Math.round(entry.cachedInputTokens));
    return {
      provider: entry.provider,
      via: entry.via ?? null,
      model: entry.model ?? null,
      feature: entry.feature,
      source: entry.source,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      // Cached tokens are part of inputTokens, so they are not added again.
      totalTokens: inputTokens + outputTokens,
      passCount: entry.passCount ?? null,
      estimatedCostUsd: estimateCostUsd(entry.model, { inputTokens, outputTokens, cachedInputTokens }),
      // An id the call names wins, then the scope an entry point set (queue, cron, pane run), then
      // the HTTP request's own user and organization.
      userId: entry.userId !== undefined ? entry.userId : (scope?.userId ?? context?.userId() ?? null),
      organizationId: entry.organizationId !== undefined ? entry.organizationId : (scope?.organizationId ?? context?.organizationId() ?? null),
      caseId: entry.caseId ?? scope?.caseId ?? null,
      consultationId: entry.consultationId ?? scope?.consultationId ?? null,
      durationMs: entry.durationMs ?? null,
      success: entry.success ?? true,
    };
  }

  /** Runs `fn` (a pane generation, say) with its case's user and organization as the usage scope, so
   * every LLM call under it, Jev and embeddings included, is attributed. A request's own user wins
   * over the case owner (the person who clicked is who used it); a queue run has only the owner.
   * Never throws and never delays `fn` on a failed lookup: an id that is not a case (a Law id) or a
   * lookup error just runs `fn` with no scope. */
  static async runInCaseScope<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    let scope: LlmUsageScope | undefined;
    try {
      const owner = await LlmUsageRepo.findCaseOwner(caseId);
      if (owner) {
        const context = getRequestContext();
        scope = { caseId, userId: context?.userId() ?? owner.userId, organizationId: context?.organizationId() ?? owner.organizationId };
      }
    } catch (err) {
      logger.warn("LLM usage: could not look up the case owner", { err, caseId });
    }
    return scope ? runInLlmUsageScope(scope, fn) : fn();
  }

  /** The same for a document's extraction, whose owner the document row already names. */
  static async runInDocumentScope<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
    let scope: LlmUsageScope | undefined;
    try {
      const doc = await LlmUsageRepo.findDocumentOwner(documentId);
      if (doc) scope = { userId: doc.userId, organizationId: doc.organizationId, caseId: doc.caseId, consultationId: doc.consultationId };
    } catch (err) {
      logger.warn("LLM usage: could not look up the document owner", { err, documentId });
    }
    return scope ? runInLlmUsageScope(scope, fn) : fn();
  }

  /** The users and organizations the admin page can filter by, named. */
  static async people(filter: LlmUsageFilter) {
    const ids = await LlmUsageRepo.distinctPeople(filter);
    const [orgs, users] = await Promise.all([LlmUsageRepo.findOrganizationNames(ids.organizationIds), LlmUsageRepo.findUserNames(ids.userIds)]);
    const orgName = new Map(orgs.map((o) => [o.id, o.name] as const));
    const user = new Map(users.map((u) => [u.id, u] as const));
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    return {
      users: ids.userIds
        .map((id) => ({ id, label: user.get(id)?.name || user.get(id)?.email || "Deleted account", email: user.get(id)?.email ?? null }))
        .sort(byLabel),
      organizations: ids.organizationIds.map((id) => ({ id, label: orgName.get(id) || "Deleted organization" })).sort(byLabel),
      hasNoUser: ids.hasNoUser,
      hasNoOrganization: ids.hasNoOrganization,
    };
  }

  /** One page of calls, newest first, with the names an id stands for (there are no foreign keys to
   * join on, and a deleted user or organization simply has no name). */
  static async list(filter: LlmUsageFilter, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([LlmUsageRepo.list(filter, pageSize, (page - 1) * pageSize), LlmUsageRepo.count(filter)]);
    const names = await LlmUsageSvc.loadNames(
      rows.map((r) => r.organizationId),
      rows.map((r) => r.userId),
    );
    return {
      rows: rows.map((row) => ({
        ...row,
        organizationName: (row.organizationId && names.organizations.get(row.organizationId)) || null,
        userName: (row.userId && names.users.get(row.userId)) || null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** The totals and breakdowns behind the admin LLM Usage page. */
  static async summary(filter: LlmUsageFilter) {
    const [bySource, unpricedCalls, provider, model, feature, day, topOrgs, topUsers] = await Promise.all([
      LlmUsageRepo.totalsBySource(filter),
      LlmUsageRepo.countUnpriced(filter),
      LlmUsageRepo.groupBy(filter, "provider"),
      LlmUsageRepo.groupBy(filter, "model"),
      LlmUsageRepo.groupBy(filter, "feature"),
      LlmUsageRepo.byDay(filter),
      LlmUsageRepo.topBy(filter, "organizationId", LLM_USAGE_TOP_N),
      LlmUsageRepo.topBy(filter, "userId", LLM_USAGE_TOP_N),
    ]);
    const totals = { ...emptyTotals(), unpricedCalls, estimated: emptyTotals(), reported: emptyTotals() };
    for (const g of bySource) {
      addGroup(totals, g);
      addGroup(g.source === "ESTIMATED" ? totals.estimated : totals.reported, g);
    }
    const names = await LlmUsageSvc.loadNames(
      topOrgs.map((g) => g.key),
      topUsers.map((g) => g.key),
    );
    return {
      totals,
      byProvider: breakdown(provider),
      byModel: breakdown(model),
      byFeature: breakdown(feature),
      byDay: LlmUsageSvc.foldDays(day),
      topOrganizations: breakdown(topOrgs).map((r) => ({ ...r, name: (r.key && names.organizations.get(r.key)) || null })),
      topUsers: breakdown(topUsers).map((r) => ({ ...r, name: (r.key && names.users.get(r.key)) || null })),
    };
  }

  private static foldDays(rows: LlmUsageDayRow[]) {
    const days = new Map<string, { day: string; calls: number; tokens: number; costUsd: number; estimatedTokens: number; reportedTokens: number }>();
    for (const r of rows) {
      const key = r.day.toISOString().slice(0, 10);
      const d = days.get(key) ?? { day: key, calls: 0, tokens: 0, costUsd: 0, estimatedTokens: 0, reportedTokens: 0 };
      d.calls += r.calls;
      d.tokens += r.totalTokens;
      d.costUsd += r.costUsd;
      if (r.source === "ESTIMATED") d.estimatedTokens += r.totalTokens;
      else d.reportedTokens += r.totalTokens;
      days.set(key, d);
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Display names for organization and user ids: the organization's name, the user's name or
   * else email. One batched lookup each. */
  private static async loadNames(organizationIds: (string | null)[], userIds: (string | null)[]) {
    const orgIds = [...new Set(organizationIds.filter((id): id is string => !!id))];
    const uIds = [...new Set(userIds.filter((id): id is string => !!id))];
    const [orgs, users] = await Promise.all([LlmUsageRepo.findOrganizationNames(orgIds), LlmUsageRepo.findUserNames(uIds)]);
    return {
      organizations: new Map(orgs.map((o) => [o.id, o.name] as const)),
      users: new Map(users.map((u) => [u.id, u.name || u.email] as const)),
    };
  }
}
