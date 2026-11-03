import { PollyClient, SynthesizeSpeechCommand, OutputFormat, VoiceId } from "@aws-sdk/client-polly";
import { awsClientConfig } from "../lib/aws-client-config";
import HttpError from "./http-error";

// Shared by every Polly caller (Audio Overview, Case Reconstruction narration, the ad-hoc
// /tts route) — was previously constructed separately in each, with identical credentials.
export function getPollyClient(): PollyClient {
  return new PollyClient({ ...awsClientConfig });
}

const pollyClient = getPollyClient();

/** One-shot text-to-speech, buffered in full — what the /tts route and the voice-chat reply step
 * both need. Not for a transcript long enough to exceed Polly's per-request limits; callers that
 * accept arbitrarily long text should chunk before calling this, same as the /tts route's own
 * 3000-char cap. */
export async function synthesizeSpeechToBuffer(text: string, voiceId: VoiceId | string = "Joanna"): Promise<Buffer> {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: OutputFormat.MP3,
    VoiceId: voiceId as VoiceId,
    Engine: "neural",
  });

  const result = await pollyClient.send(command);
  if (!result.AudioStream) throw new HttpError("Polly returned no audio", 502);

  const chunks: Uint8Array[] = [];
  for await (const chunk of result.AudioStream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
