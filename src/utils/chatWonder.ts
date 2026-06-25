import axios from "axios";
import { CHAT_WONDER_API_URL, CHAT_WONDER_WS_URL } from "../config";
import HttpError from "./http-error";

const SESSION_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const LEGAL_TAG = "[legal ai]";

function stripLegalTag(input: string): string {
  const lower = input.toLowerCase();
  if (!lower.startsWith(LEGAL_TAG)) return input;
  return input.slice(LEGAL_TAG.length).trimStart();
}

function withLegalTag(input: string): string {
  return `${LEGAL_TAG} ${stripLegalTag(input)}`;
}

const RELATED_QUERIES_RULE = `

At the end of your response, output this tag:

[RELATED_QUERIES]["term1","term2","term3"][/RELATED_QUERIES]

Rules — strictly in priority order:
1. EXACT article/section numbers from laws you cited (e.g. "Article 279", "Section 5", "Article 68") — always prefer the specific provision over the parent statute name
2. EXACT statute names+numbers you cited (e.g. "Republic Act 9262", "Presidential Decree 603") — only include if no specific article covers it
3. EXACT GR numbers or case names you cited (e.g. "GR No. 123456", "People v. Genosa")
4. If the question is not about Philippine law, output: [RELATED_QUERIES][][/RELATED_QUERIES]

Strict limits:
- 3 to 5 terms maximum, each DISTINCT
- Every term must appear verbatim in a Philippine legal document title or provision
- NEVER include vague topic words — if a term could describe a chapter heading rather than a law title or article number, drop it
- Bad: ["illegal dismissal","employee rights","labor law","social services"] — topic summaries, not document identifiers
- Good: ["Article 297","Republic Act 8042","GR No. 185222","Section 10"] — specific provisions and identifiers

CRITICAL: NEVER mention "Related Queries" in your prose. Output only the tag at the very bottom, after all text.`;

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
