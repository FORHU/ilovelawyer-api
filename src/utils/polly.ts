import { PollyClient } from "@aws-sdk/client-polly";
import { awsClientConfig } from "../lib/aws-client-config";

// Shared by every Polly caller (Audio Overview, Case Reconstruction narration, the ad-hoc
// /tts route) — was previously constructed separately in each, with identical credentials.
export function getPollyClient(): PollyClient {
  return new PollyClient({ ...awsClientConfig });
}
