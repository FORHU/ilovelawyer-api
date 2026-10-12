import { TraceRun } from "../services/trace-collector.service";
import LlmUsageSvc from "../services/llm-usage.service";
import { estimateTokensFromChars } from "./token-estimate";

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

/** Filled in by streamChatWonderMessageOnce as the call runs, so the one row recorded when it ends
 * can say how much was sent and how many passes Chat Wonder made. Internal: callers don't set it. */
export interface ChatWonderUsageProbe {
  /** Characters of everything sent to the model: the question, the case text, the manifest. */
  inputChars: number;
  /** Characters of the reply. 0 when the call failed. */
  outputChars: number;
  /** Distinct research steps ([TRACE] start frames) Chat Wonder reported. */
  traceStarts: number;
}

interface FinishedCall {
  usage?: ChatWonderUsageOptions;
  trace?: TraceRun;
  startedAt: number;
  inputChars: number;
  outputChars: number;
  /** Passes after the first: a streamed turn's research steps. Null for a call with no traces. */
  traceStarts: number | null;
  success: boolean;
}

/** Records the one LlmUsage row for a Chat Wonder call — exactly one per call, whatever its
 * outcome. Chat Wonder does not report its usage yet (chat-wonder-v2-api#104), so the row is an
 * ESTIMATE: characters / 4 of what we sent and got back, with no model and so no cost.
 *
 * The estimate is a LOWER BOUND. Chat Wonder's research loop resends the whole conversation, plus
 * every tool result gathered so far, on each pass, so the input is multiplied by the pass count but
 * still leaves out the tool results; and a call that failed before the reply streamed records no
 * output. A retry is a second call and gets its own row. */
export function recordChatWonderUsage(call: FinishedCall): void {
  const passCount = call.traceStarts === null ? null : call.traceStarts + 1;
  LlmUsageSvc.record({
    provider: "OPENAI",
    via: "chat-wonder",
    model: null,
    feature: call.usage?.feature ?? call.trace?.source ?? "unknown",
    source: "ESTIMATED",
    inputTokens: estimateTokensFromChars(call.inputChars) * (passCount ?? 1),
    outputTokens: estimateTokensFromChars(call.outputChars),
    passCount,
    userId: call.usage?.userId !== undefined ? call.usage.userId : (call.trace?.userId ?? undefined),
    organizationId: call.usage?.organizationId,
    caseId: call.usage?.caseId ?? call.trace?.caseId ?? null,
    consultationId: call.usage?.consultationId ?? null,
    durationMs: Date.now() - call.startedAt,
    success: call.success,
  });
}
