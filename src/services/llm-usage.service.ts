import { LlmProvider, LlmUsageSource, Prisma } from "@prisma/client";
import LlmUsageRepo from "../repositories/llm-usage.repository";
import { getRequestContext } from "../lib/request-context";
import { getLlmUsageScope, LlmUsageScope, runInLlmUsageScope } from "../lib/llm-usage-scope";
import { estimateCostUsd } from "../constants/llm-pricing.constants";
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
}
