import { LlmProvider, LlmUsageSource, Prisma } from "@prisma/client";
import LlmUsageRepo from "../repositories/llm-usage.repository";
import { getRequestContext } from "../lib/request-context";
import { estimateCostUsd } from "../constants/llm-pricing.constants";
import logger from "../utils/logger";

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

  private static buildRow(entry: LlmUsageEntry): Prisma.LlmUsageUncheckedCreateInput {
    const context = getRequestContext();
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
      // An id the call names wins, then the HTTP request's own user and organization.
      userId: entry.userId !== undefined ? entry.userId : (context?.userId() ?? null),
      organizationId: entry.organizationId !== undefined ? entry.organizationId : (context?.organizationId() ?? null),
      caseId: entry.caseId ?? null,
      consultationId: entry.consultationId ?? null,
      durationMs: entry.durationMs ?? null,
      success: entry.success ?? true,
    };
  }
}
