import { TypeSafeClient } from "@typesafe-ai/sdk";

/** Reads TYPESAFE_API_KEY from env. Shared by the three Jev pilots (citation-proposition.ts,
 * citation-validity.ts, message-triage.ts) and constructed lazily on first use, so the SDK's own
 * missing-key error only surfaces when one of their USE_JEV_* flags is actually on. */
let client: TypeSafeClient | null = null;

export function getTypeSafeClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}
