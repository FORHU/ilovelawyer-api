import axios from "axios";
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

function stripSources(chunk: string): string {
  const idx = chunk.indexOf("[Sources]");
  return idx !== -1 ? chunk.slice(0, idx) : chunk;
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

export function streamChatWonderMessage(
  sessionId: string,
  userInput: string,
  onChunk: (text: string) => void,
  documentContext?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CHAT_WONDER_WS_URL);
    let accumulated = "";
    let sourcesDropped = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve(accumulated);
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

      const message = typeof event.data === "string" ? event.data : String(event.data);

      if (message === "__END__") {
        finish();
        return;
      }

      if (message.endsWith("__END__")) {
        const content = message.slice(0, -"__END__".length);
        if (content) {
          const clean = stripSources(content);
          accumulated += clean;
          onChunk(clean);
        }
        finish();
        return;
      }

      if (sourcesDropped) return;

      const idx = message.indexOf("[Sources]");
      if (idx !== -1) {
        sourcesDropped = true;
        if (idx > 0) {
          const clean = message.slice(0, idx);
          accumulated += clean;
          onChunk(clean);
        }
        return;
      }

      accumulated += message;
      onChunk(message);
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
