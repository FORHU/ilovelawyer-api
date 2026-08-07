import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return _client;
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

/** Embeds multiple chunks in a single OpenAI request. Callers with many chunks must batch
 * through this instead of firing one embedText() per chunk — a large document can produce
 * tens of thousands of chunks, and issuing that many concurrent HTTP requests exhausts local
 * sockets and OpenAI's rate limit alike. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map((text) => text.trim().slice(0, 8000)),
  });
  return res.data.map((d) => d.embedding);
}
