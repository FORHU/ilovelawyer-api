import { AsyncLocalStorage } from "async_hooks";

/** Who and what the LLM calls made below this point are for (epic #399). A queue worker, a cron job
 * or a pane generation has no HTTP request context, and an embedding or Jev call deep inside one
 * has no idea which user, organization or case it serves — so the entry point states it once here
 * and LlmUsageSvc.record reads it for every row written underneath. Explicit ids on a call still
 * win; this only fills what the call left out. */
export interface LlmUsageScope {
  userId?: string | null;
  organizationId?: string | null;
  caseId?: string | null;
  consultationId?: string | null;
}

const storage = new AsyncLocalStorage<LlmUsageScope>();

export function getLlmUsageScope(): LlmUsageScope | undefined {
  return storage.getStore();
}

/** Runs `fn` with `scope` on top of any scope already active: a value left undefined keeps the outer
 * one, so a pane generation inside a chat turn does not lose the turn's organization. */
export function runInLlmUsageScope<T>(scope: LlmUsageScope, fn: () => T): T {
  const outer = storage.getStore();
  const merged: LlmUsageScope = { ...outer };
  for (const [key, value] of Object.entries(scope) as [keyof LlmUsageScope, string | null | undefined][]) {
    if (value !== undefined) merged[key] = value;
  }
  return storage.run(merged, fn);
}
