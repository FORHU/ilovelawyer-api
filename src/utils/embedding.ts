import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  // Without an explicit timeout, the SDK default (10 min) plus its own retries let a single
  // stalled batch stretch a document's extraction to tens of minutes with no observable
  // progress — a 30s timeout plus a capped retry count fails fast instead.
  // Rate-limit 429s are retried in embedTexts (the SDK's 3 retries are too short when two
  // large PDFs hit a 5M TPM cap together).
  if (!_client) _client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 30_000, maxRetries: 0 });
  return _client;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string };
  return e.status === 429 || e.code === "rate_limit_exceeded";
}

function retryAfterMs(err: unknown, attempt: number): number {
  const e = err as { error?: { message?: string }; message?: string };
  const msg = e.error?.message ?? e.message ?? "";
  const msMatch = msg.match(/try again in (\d+)\s*ms/i);
  if (msMatch) return Math.max(Number(msMatch[1]), 200);
  const secMatch = msg.match(/try again in ([\d.]+)\s*s/i);
  if (secMatch) return Math.max(Math.ceil(Number(secMatch[1]) * 1000), 200);
  return Math.min(500 * 2 ** (attempt - 1), 30_000);
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
  const input = texts.map((text) => text.trim().slice(0, 8000));
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await getClient().embeddings.create({
        model: "text-embedding-3-small",
        input,
      });
      return res.data.map((d) => d.embedding);
    } catch (err) {
      if (!isRateLimit(err) || attempt === maxAttempts) throw err;
      await sleep(retryAfterMs(err, attempt));
    }
  }

  throw new Error("embedTexts: exhausted retries");
}
