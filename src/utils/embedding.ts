import OpenAI from "openai";
import { OPENAI_API_KEY } from "../config";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return _client;
}

export async function embedText(text: string): Promise<number[]> {
  const res = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: text.trim().slice(0, 8000),
  });
  return res.data[0].embedding;
}
