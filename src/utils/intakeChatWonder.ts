import WebSocket from "ws";
import { CHAT_WONDER_WS_URL } from "../config";
import { STRUCTURED_DATA_WAIT_MS } from "../constants/chatWonder.constants";
import HttpError from "./http-error";
import logger from "./logger";
import { RelatedCase } from "./chatWonder";

/** The intake persona's own, minimal WS client — deliberately NOT a reuse of
 * chatWonder.ts's streamChatWonderMessageOnce, and deliberately NOT a `personaTag` override
 * parameter re-added to it. That exact shared-override shape is what let a lawyer Terminal turn
 * get silently tagged [intake] (the 2026-10-28 incident, fixed in PR #623 by removing it
 * entirely) — re-adding it, even scoped "for intake only," recreates the same risk the fix
 * closed. This file always sends the literal "[intake]" tag, unconditionally, with no override
 * surface for anything else to accidentally use.
 *
 * Leaner than the lawyer client on purpose: no mind map, no decisions/reasoning extraction, no
 * [TRACE] research-step capture, no generated-document frame — none of those apply to intake.
 * What it does carry: plain text streaming, [Sources]/[RELATED_CASES] (intake's citation gate
 * already produces these, same as legal_uk), and the two new tool-result frames,
 * [LAWYER_MATCHES] and [CASE_READY].
 */

export interface IntakeChatWonderStreamResult {
  content: string;
  relatedCases: RelatedCase[];
  sourceMetadata: unknown[];
  /** find_lawyer's returned candidates, straight from the [LAWYER_MATCHES] frame — not yet
   * ranked/filtered again here, that already happened server-side in the matching endpoint. */
  lawyerMatches: unknown[];
  /** True exactly when mark_case_ready fired this turn ([CASE_READY]true). */
  caseReady: boolean;
}

export class IntakeGenerationCancelledError extends Error {
  constructor() {
    super("Generation cancelled");
    this.name = "IntakeGenerationCancelledError";
  }
}

const INTAKE_TAG = "[intake]";

export async function getChatWonderSessionIdForIntake(): Promise<string> {
  // Session-id minting is a plain, stateless GET with no persona concept server-side — reusing
  // chatWonder.ts's getChatWonderSessionId here would only reuse a string constant's worth of
  // logic, not a decision path, so it stays imported rather than duplicated. If this ever grows
  // persona-specific behavior, copy it instead.
  const { getChatWonderSessionId } = await import("./chatWonder");
  return getChatWonderSessionId();
}

export function streamIntakeChatWonderMessage(
  sessionId: string,
  userInput: string,
  onChunk: (text: string) => void,
  documentContext?: string,
  signal?: AbortSignal,
  onAnswerComplete?: () => void,
): Promise<IntakeChatWonderStreamResult> {
  if (signal?.aborted) return Promise.reject(new IntakeGenerationCancelledError());
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let settled = false;
    let sourcesDropped = false;
    let relatedCases: RelatedCase[] = [];
    let sourceMetadata: unknown[] = [];
    let lawyerMatches: unknown[] = [];
    let caseReady = false;
    let postEndTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve({ content: accumulated, relatedCases, sourceMetadata, lawyerMatches, caseReady });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (postEndTimer) clearTimeout(postEndTimer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      if (!(err instanceof IntakeGenerationCancelledError)) logger.error("Intake Chat Wonder: stream failed", { sessionId, err });
      reject(err);
    };

    const onAbort = () => fail(new IntakeGenerationCancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });

    const armPostEndWait = () => {
      if (postEndTimer) return;
      try {
        onAnswerComplete?.();
      } catch (err) {
        logger.warn("Intake Chat Wonder: onAnswerComplete threw, continuing", { sessionId, err });
      }
      postEndTimer = setTimeout(() => finish(), STRUCTURED_DATA_WAIT_MS);
    };

    ws.onopen = () => {
      const payload: { type: string; user_input: string; session_id: string; use_full_legal_chain: boolean; document_context?: string } = {
        type: "chat",
        user_input: `${INTAKE_TAG} ${userInput}`,
        session_id: sessionId,
        use_full_legal_chain: false,
      };
      if (documentContext) payload.document_context = documentContext;
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      let message = typeof event.data === "string" ? event.data : String(event.data);

      // Typed JSON envelopes (usage, etc.) — not answer text, never forwarded as a chunk.
      try {
        const envelope = JSON.parse(message);
        if (envelope && typeof envelope.type === "string") return;
      } catch {
        // not JSON — an ordinary string/tagged frame, fall through
      }

      if (message === "[DONE]" || message.trim() === "[DONE]") {
        finish();
        return;
      }

      const lawyerMatchesIdx = message.indexOf("[LAWYER_MATCHES]");
      if (lawyerMatchesIdx !== -1) {
        try {
          lawyerMatches = JSON.parse(message.slice(lawyerMatchesIdx + "[LAWYER_MATCHES]".length));
        } catch {
          // malformed frame — leave lawyerMatches as whatever it was
        }
        return;
      }

      const caseReadyIdx = message.indexOf("[CASE_READY]");
      if (caseReadyIdx !== -1) {
        caseReady = message.slice(caseReadyIdx + "[CASE_READY]".length).trim() === "true";
        return;
      }

      if (message.startsWith("[Error]")) {
        const detail = message.replace(/^\[Error\]\s*/, "");
        if (accumulated.trim().length === 0) {
          fail(new Error(detail));
        } else {
          logger.warn("Intake Chat Wonder sent [Error] after reply content; keeping the reply", { sessionId, detail });
          finish();
        }
        return;
      }

      if (message.startsWith("[TRACE]")) return; // not answer text; intake has no research-step UI

      const isFinal = message.endsWith("__END__");
      if (isFinal) message = message.slice(0, -"__END__".length);

      const relatedIdx = message.indexOf("[RELATED_CASES]");
      if (relatedIdx !== -1) {
        try {
          relatedCases = JSON.parse(message.slice(relatedIdx + "[RELATED_CASES]".length));
        } catch {
          // malformed frame
        }
        message = message.slice(0, relatedIdx);
      }

      if (sourcesDropped) {
        message = "";
      } else {
        const sourcesIdx = message.indexOf("[Sources]");
        if (sourcesIdx !== -1) {
          sourcesDropped = true;
          try {
            sourceMetadata = JSON.parse(message.slice(sourcesIdx + "[Sources] ".length));
          } catch {
            // malformed frame
          }
          message = message.slice(0, sourcesIdx);
        }
      }

      if (message) {
        accumulated += message;
        onChunk(message);
      }

      if (isFinal) armPostEndWait();
    };

    ws.onerror = () => {
      if (settled) return;
      if (accumulated.trim().length === 0) {
        settled = true;
        if (postEndTimer) clearTimeout(postEndTimer);
        reject(new HttpError("Chat Wonder connection error", 503));
      } else {
        logger.warn("Intake Chat Wonder socket error after reply content; keeping the reply", { sessionId });
        finish();
      }
    };

    ws.onclose = () => {
      if (settled) return;
      if (postEndTimer || accumulated.trim().length > 0) {
        finish();
        return;
      }
      settled = true;
      logger.error("Intake Chat Wonder closed the stream before __END__ with no content", { sessionId });
      reject(new HttpError("Chat Wonder closed the stream before completing the reply", 503));
    };
  });
}
