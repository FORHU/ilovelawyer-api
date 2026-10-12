import { TraceRun } from "../services/trace-collector.service";
import LlmUsageSvc from "../services/llm-usage.service";
import { estimateTokensFromChars } from "./token-estimate";
import logger from "./logger";

/** Who a Chat Wonder call is for, passed by the caller (epic #399, #402). Everything is optional
 * except `feature`; an id left out falls back to the call's `trace` run, then to the request
 * context (LlmUsageSvc.record) — a queue or cron run has neither, so its caller names the ids. */
export interface ChatWonderUsageOptions {
  feature: string;
  userId?: string | null;
  organizationId?: string | null;
  caseId?: string | null;
  consultationId?: string | null;
}

/** What Chat Wonder says one turn used (chat-wonder-v2-api#104): the `usage` key of a REST reply,
 * or the `data` of a `{"type":"usage"}` frame. Read by parseReportedUsage. */
export interface ReportedUsage {
  /** The model that took the most input tokens this turn. Null when Chat Wonder didn't name one. */
  model: string | null;
  /** All input tokens, cached ones included. */
  inputTokens: number;
  /** A subset of inputTokens. */
  cachedInputTokens: number | null;
  outputTokens: number;
  /** Research-loop calls. Null when not reported. */
  passCount: number | null;
}

/** Filled in by streamChatWonderMessageOnce as the call runs, so the one row recorded when it ends
 * can say how much was sent and how many passes Chat Wonder made. Internal: callers don't set it. */
export interface ChatWonderUsageProbe {
  /** Characters of everything sent to the model: the question, the case text, the manifest. */
  inputChars: number;
  /** Characters of the reply. 0 when the call failed. */
  outputChars: number;
  /** Distinct research steps ([TRACE] start frames) Chat Wonder reported. */
  traceStarts: number;
  /** Chat Wonder's own numbers, when its `usage` frame arrived before the call ended. */
  reported?: ReportedUsage;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** Reads Chat Wonder's usage block. Returns undefined — so the caller falls back to its estimate —
 * for anything that is not a usable block: missing, not an object, or without real input and output
 * token counts. Never throws. */
export function parseReportedUsage(raw: unknown): ReportedUsage | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const block = raw as Record<string, unknown>;
    const inputTokens = count(block.prompt_tokens);
    const outputTokens = count(block.completion_tokens);
    if (inputTokens === null || outputTokens === null) return undefined;
    const cached = count(block.cached_input_tokens);
    return {
      model: typeof block.model === "string" && block.model.trim() ? block.model.trim() : null,
      inputTokens,
      // A cached count above the input count can't be true; drop it rather than record nonsense.
      cachedInputTokens: cached !== null && cached <= inputTokens ? cached : null,
      outputTokens,
      passCount: count(block.pass_count),
    };
  } catch {
    return undefined;
  }
}

interface FinishedCall {
  usage?: ChatWonderUsageOptions;
  trace?: TraceRun;
  startedAt: number;
  inputChars: number;
  outputChars: number;
  /** Passes after the first: a streamed turn's research steps. Null for a call with no traces. */
  traceStarts: number | null;
  /** Chat Wonder's own numbers, when it sent them. */
  reported?: ReportedUsage;
  success: boolean;
}

/** Records the one LlmUsage row for a Chat Wonder call — exactly one per call, whatever its
 * outcome. When Chat Wonder reported its usage (chat-wonder-v2-api#104) the row is REPORTED with
 * its numbers; otherwise it is ESTIMATED, counting characters / 4 of what we sent and got back.
 *
 * The estimate is a LOWER BOUND. Chat Wonder's research loop resends the whole conversation, plus
 * every tool result gathered so far, on each pass, so the input is multiplied by the pass count but
 * still leaves out the tool results; and a call that failed before the reply streamed records no
 * output. A retry is a second call and gets its own row.
 *
 * When both exist the estimate is logged next to the reported numbers, to judge how far older
 * ESTIMATED rows can be trusted (epic #399, #404). */
export function recordChatWonderUsage(call: FinishedCall): void {
  const passCount = call.traceStarts === null ? null : call.traceStarts + 1;
  const estimate = {
    inputTokens: estimateTokensFromChars(call.inputChars) * (passCount ?? 1),
    outputTokens: estimateTokensFromChars(call.outputChars),
  };
  const reported = call.reported;
  const feature = call.usage?.feature ?? call.trace?.source ?? "unknown";
  if (reported) logger.info("LLM usage estimate vs reported", { feature, estimate, reported });
  // Chat Wonder reports usage on every path (chat-wonder-v2-api#104), so a call that succeeded without
  // a report means an older Chat Wonder is running or a path stopped reporting. The row is still an
  // estimate, but it must be visible: it shows up as "Not reported" on the admin page, and here.
  if (!reported && call.success) logger.warn("Chat Wonder call finished without a usage report; recording an estimate", { feature });
  LlmUsageSvc.record({
    provider: "OPENAI",
    via: "chat-wonder",
    model: reported?.model ?? null,
    feature,
    source: reported ? "REPORTED" : "ESTIMATED",
    inputTokens: reported ? reported.inputTokens : estimate.inputTokens,
    outputTokens: reported ? reported.outputTokens : estimate.outputTokens,
    cachedInputTokens: reported?.cachedInputTokens ?? null,
    passCount: reported?.passCount ?? passCount,
    userId: call.usage?.userId !== undefined ? call.usage.userId : (call.trace?.userId ?? undefined),
    organizationId: call.usage?.organizationId,
    caseId: call.usage?.caseId ?? call.trace?.caseId ?? null,
    consultationId: call.usage?.consultationId ?? null,
    durationMs: Date.now() - call.startedAt,
    success: call.success,
  });
}
