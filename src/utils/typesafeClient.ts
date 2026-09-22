import { TypeSafeClient } from "@typesafe-ai/sdk";

/** Reads TYPESAFE_API_KEY from env. Only constructed when USE_JEV_PROPOSITION is enabled
 * (see citation-proposition.ts) so the SDK's own missing-key error only surfaces when in use. */
let client: TypeSafeClient | null = null;

export function getTypeSafeClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}
