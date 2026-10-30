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

/** One line of Polly's speech-marks output (newline-delimited JSON, one object per mark). `time`
 * is milliseconds from the start of that request's audio; `start`/`end` are UTF-8 BYTE offsets
 * into the input text, not string indices — same shape Audio Overview's own Polly calls get
 * (audio-overview-render.ts), duplicated here rather than imported since that module pulls in
 * ffmpeg/mp3-duration for its multi-turn concatenation, which a single voice-chat reply has no use
 * for. */
export interface PollySpeechMark {
  time: number;
  type: string;
  start: number;
  end: number;
  value: string;
}

function parseSpeechMarks(raw: string): PollySpeechMark[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PollySpeechMark);
}

/** A mark converted from Polly's byte offsets to string indices into the same text, and from
 * milliseconds to seconds — what the client actually renders against. */
export interface MarkTiming {
  time: number;
  start: number;
  end: number;
}

function markTimingsFor(text: string, marks: PollySpeechMark[], type: "sentence" | "word"): MarkTiming[] {
  const bytes = Buffer.from(text, "utf8");
  const toIndex = (byteOffset: number) => bytes.subarray(0, byteOffset).toString("utf8").length;
  return marks
    .filter((mark) => mark.type === type)
    .map((mark) => ({ time: mark.time / 1000, start: toIndex(mark.start), end: toIndex(mark.end) }));
}

/** Audio plus Polly's sentence and word speech marks for that same text/voice — a second request
 * that returns only timing, no audio, billed by the same characters as the first. What the voice
 * chat reply player needs to highlight the transcript in sync with playback (ported from Audio
 * Overview's synthesizeTurnWithMarks, trimmed to one turn starting at time 0 — a chat reply is
 * never concatenated with anything else). */
export async function synthesizeSpeechWithMarks(
  text: string,
  voiceId: VoiceId | string = "Joanna",
): Promise<{ audio: Buffer; sentenceTimings: MarkTiming[]; wordTimings: MarkTiming[] }> {
  const [audio, marksJson] = await Promise.all([
    synthesizeSpeechToBuffer(text, voiceId),
    (async () => {
      const result = await pollyClient.send(
        new SynthesizeSpeechCommand({
          Text: text,
          OutputFormat: OutputFormat.JSON,
          SpeechMarkTypes: ["sentence", "word"],
          VoiceId: voiceId as VoiceId,
          Engine: "neural",
        }),
      );
      if (!result.AudioStream) throw new HttpError("Polly returned no speech marks", 502);
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.AudioStream as AsyncIterable<Uint8Array>) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    })(),
  ]);
  const marks = parseSpeechMarks(marksJson);
  return {
    audio,
    sentenceTimings: markTimingsFor(text, marks, "sentence"),
    wordTimings: markTimingsFor(text, marks, "word"),
  };
}
