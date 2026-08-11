import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  // Without an explicit timeout, the SDK default (10 min) plus its own retries let a single
  // stalled batch stretch a document's extraction to tens of minutes with no observable
  // progress — a 30s timeout plus a capped retry count fails fast instead.
  if (!_client) _client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 30_000, maxRetries: 3 });
  return _client;
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

/** Embeds multiple chunks in a single OpenAI request. Callers with many chunks must batch
 * through this insteag one embedText() per chunk — a large document can produce
 * tens of thousands of chunks, and issuing that many concurrent HTTP requests exhausts local
 * sockets and OpenAI's rate limit alike. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map((text) => text.trim().slice(0, 8000)),
  });
  return res.data.map((d) => d.embedding);
}
