import { PollyClient } from "@aws-sdk/client-polly";
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION } from "../config";

// Shared by every Polly caller (Audio Overview, Case Reconstruction narration, the ad-hoc
// /tts route) — was previously constructed separately in each, with identical credentials.
export function getPollyClient(): PollyClient {
  return new PollyClient({
    region: AWS_REGION,
    credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
}
