import axios from "axios";
import WebSocket from "ws";
import { CHAT_WONDER_API_URL, CHAT_WONDER_WS_URL } from "../config";
import HttpError from "./http-error";
import { RELATED_QUERIES_RULE, SESSION_RETRIES, RETRY_DELAY_MS, LEGAL_TAG } from "../constants/chatWonder.constants";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callChatWonderRest(prompt: string, sessionId: string): Promise<{ response?: string; intermediate_response?: string; source_metadata?: unknown }> {
  const { data } = await axios.post(`${CHAT_WONDER_API_URL}/chat`, {
    user_input: prompt,
    session_id: sessionId,
  });
  return data;
}

export async function getChatWonderSessionId(): Promise<string> {
  for (let attempt = 1; attempt <= SESSION_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(`${CHAT_WONDER_API_URL}/session-id`);
      if (!data?.session_id) {
        throw new Error("Chat Wonder returned no session_id");
      }
      return data.session_id;
    } catch {
      if (attempt < SESSION_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new HttpError("Could not initialize chat session. Chat Wonder may be unreachable.", 503);
}

export interface RelatedCase {
  type: string;
  title: string | null;
  url: string | null;
  case_number: string | null;
  ra_number: string | null;
  year: unknown;
  snippet: string | null;
  relevance: number | null;
  vetted: boolean;
}

function stripLegalTag(input: string): string {
  const lower = input.toLowerCase();
  if (!lower.startsWith(LEGAL_TAG)) return input;
  return input.slice(LEGAL_TAG.length).trimStart();
}

function withLegalTag(input: string): string {
  return `${LEGAL_TAG} ${stripLegalTag(input)}`;
}

export async function generateTitleViaWs(prompt: string): Promise<string> {
  const sessionId = await getChatWonderSessionId();

  return new Promise((resolve) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let settled = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(""), 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "chat",
        user_input: prompt,
        session_id: sessionId,
        use_full_legal_chain: false,
      }));
    };

    ws.onmessage = (event) => {
      if (settled) return;
      const msg = typeof event.data === "string" ? event.data : String(event.data);
      if (msg === "__END__" || msg.endsWith("__END__")) {
        const content = msg.endsWith("__END__") ? msg.slice(0, -"__END__".length) : "";
        if (content) accumulated += content;
        clearTimeout(timeout);
        finish(accumulated.trim());
        return;
      }
      accumulated += msg;
    };

    ws.onerror = () => { clearTimeout(timeout); finish(""); };
    ws.onclose  = () => { clearTimeout(timeout); finish(accumulated.trim()); };
  });
}

export interface ChatWonderStreamResult {
  content: string;
  /** Raw search terms Chat Wonder tagged via [RELATED_QUERIES] — article/section numbers,
   * statute names, GR numbers it cited. Callers resolve these against the legal document
   * store to build the actual RelatedCase records; Chat Wonder never returns cases directly. */
  relatedQueries: string[];
}

export function streamChatWonderMessage(
  sessionId: string,
  userInput: string,
  onChunk: (text: string) => void,
  documentContext?: string,
): Promise<ChatWonderStreamResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let sourcesDropped = false;
    let settled = false;
    let relatedQueries: string[] = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve({ content: accumulated, relatedQueries });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(err);
    };

    ws.onopen = () => {
      const payload: {
        type: string;
        user_input: string;
        session_id: string;
        use_full_legal_chain: boolean;
        document_context?: string;
      } = {
        type: "chat",
        user_input: withLegalTag(userInput) + RELATED_QUERIES_RULE,
        session_id: sessionId,
        use_full_legal_chain: false,
      };
      if (documentContext) {
        payload.document_context = documentContext;
      }
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      if (settled) return;

      let message = typeof event.data === "string" ? event.data : String(event.data);

      if (message === "__END__") {
        finish();
        return;
      }

      // Chat Wonder sends these as plain streamed text, not a distinct protocol frame —
      // without this check they'd be silently appended to the answer and shown to the
      // user as if the AI had said "[Error] Unknown session." Must reject, not resolve,
      // so callers can detect this and retry with a fresh session_id instead of
      // displaying it as a real response.
      if (message.startsWith("[Error]")) {
        fail(new Error(message.replace(/^\[Error\]\s*/, "")));
        return;
      }

      // Note whether this frame carries the terminator so it can still get its
      // [RELATED_QUERIES]/[Sources] stripped below instead of being flushed raw —
      // Chat Wonder often ships the tag and __END__ together in the final frame.
      const isFinal = message.endsWith("__END__");
      if (isFinal) message = message.slice(0, -"__END__".length);

      const relatedMatch = message.match(/\[RELATED_QUERIES\]([\s\S]*?)\[\/RELATED_QUERIES\]/i);
      if (relatedMatch) {
        try {
          relatedQueries = JSON.parse(relatedMatch[1]);
        } catch {
          // malformed frame — leave relatedQueries as whatever it was (usually [])
        }
        message = message.replace(relatedMatch[0], "");
      }

      if (sourcesDropped) {
        message = "";
      } else {
        const idx = message.indexOf("[Sources]");
        if (idx !== -1) {
          sourcesDropped = true;
          message = message.slice(0, idx);
        }
      }

      if (message) {
        accumulated += message;
        onChunk(message);
      }

      if (isFinal) finish();
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new HttpError("Chat Wonder connection error", 503));
    };

    ws.onclose = () => {
      finish();
    };
  });
}
