import { TypeSafeClient, type Questions, type SystemOneRequest, type SystemOneResult } from "@typesafe-ai/sdk";
import logger from "./logger";

/** Reads TYPESAFE_API_KEY from env and is constructed lazily on first use, so the SDK's own
 * missing-key error only surfaces when a USE_JEV_* flag is actually on. The model comes from
 * TYPESAFE_DEFAULT_MODEL, which the SDK reads itself and which defaults to the moving
 * `jev-latest` alias — pin it per environment so a TypeSafe release can't change verdicts
 * unannounced. Every call goes through jevAsk below; test/jev-ask-guard.spec.ts enforces it. */
let client: TypeSafeClient | null = null;

export function getTypeSafeClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}

/** The SDK's own timeout is per attempt (10s) with up to two retries and no overall cap, so a
 * degraded Jev could hold a check for 30s or more. This caps the whole call, retries included. */
export const JEV_DEFAULT_TIMEOUT_MS = 30_000;

/** Jev timed out or failed. Callers already fall back to the result they'd have without Jev. */
export class JevUnavailableError extends Error {
  readonly feature: string;
  readonly reason: "timeout" | "error";
  readonly cause?: unknown;

  constructor(feature: string, reason: "timeout" | "error", cause?: unknown) {
    super(reason === "timeout" ? `Jev timed out (${feature})` : `Jev failed (${feature})`);
    this.name = "JevUnavailableError";
    this.feature = feature;
    this.reason = reason;
    this.cause = cause;
  }
}

export interface JevUsageEntry {
  feature: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
}

type JevUsageRecorder = (entry: JevUsageEntry) => void | Promise<void>;

let usageRecorder: JevUsageRecorder | null = null;

/** Where each call's token usage goes (the LLM usage ledger, #403). Unset, usage is only logged. */
export function setJevUsageRecorder(recorder: JevUsageRecorder | null): void {
  usageRecorder = recorder;
}

function recordUsage(entry: JevUsageEntry): void {
  if (!usageRecorder) return;
  try {
    Promise.resolve(usageRecorder(entry)).catch((err) => logger.warn("Jev usage record failed", { feature: entry.feature, err }));
  } catch (err) {
    logger.warn("Jev usage record failed", { feature: entry.feature, err });
  }
}

/**
 * The one way to ask Jev anything. `feature` names the check in logs and usage records.
 * Throws JevUnavailableError on a timeout or any SDK failure; the request itself is aborted on
 * timeout, so its retries stop too.
 */
export async function jevAsk<const Q extends Questions>(
  feature: string,
  request: SystemOneRequest<Q>,
  opts: { timeoutMs?: number } = {},
): Promise<SystemOneResult<Q>> {
  const timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JevUnavailableError(feature, "timeout"));
    }, timeoutMs);
  });
  const started = Date.now();

  try {
    const result = await Promise.race([getTypeSafeClient().systemOne(request, { signal: controller.signal }), timedOut]);
    const durationMs = Date.now() - started;
    const model = result?.model ?? null;
    const inputTokens = result?.usage?.input_tokens ?? 0;
    const outputTokens = result?.usage?.output_tokens ?? 0;
    logger.info("Jev call", { feature, model, inputTokens, outputTokens, durationMs });
    recordUsage({ feature, model, inputTokens, outputTokens, durationMs, success: true });
    return result;
  } catch (err) {
    const durationMs = Date.now() - started;
    const failure = err instanceof JevUnavailableError ? err : new JevUnavailableError(feature, "error", err);
    logger.warn("Jev call failed", { feature, reason: failure.reason, durationMs, err: failure.cause });
    recordUsage({ feature, model: null, inputTokens: 0, outputTokens: 0, durationMs, success: false });
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
