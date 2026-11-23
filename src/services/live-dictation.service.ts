import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type LanguageCode,
  type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";
import prisma from "../lib/prisma";
import { awsClientConfig } from "../lib/aws-client-config";
import { assertClientAiOpen } from "../constants/client-sites.constants";
import type { TenantCode } from "../types/tenant-code";
import ClientCaseSvc from "./client-case.service";
import ConsentSvc from "./consent.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/**
 * Live voice input for the client app (sockets/client-dictation.socket.ts): the browser streams raw
 * microphone audio while the person talks, AWS Transcribe Streaming sends words back as they are
 * recognised, and the client sees them appear in the composer. Unlike ClientDictationSvc (record,
 * upload, poll), nothing touches S3 and no job is left behind: the audio passes through memory and
 * the text goes back to the socket that sent it. Nothing is stored.
 */

/** A spoken answer, not a recording of a hearing. The same limit the record-then-upload input has. */
export const MAX_LIVE_DICTATION_SECONDS = 180;
/** Past the audio limit, a stream that never stops sending (a stuck tab) is closed on the clock too. */
const WALL_CLOCK_GRACE_SECONDS = 15;
/** The browser downsamples to this unless it says otherwise. Transcribe takes 8 kHz to 48 kHz PCM. */
export const DEFAULT_SAMPLE_RATE = 16_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;

/** The language a site's clients are heard in: one language per site, so Transcribe doesn't have to
 * guess it and partial results start sooner. PH's AI isn't open yet (CLIENT_AI_OPEN_TENANTS), so its
 * entry is a placeholder until its intake persona settles the language. */
export const LIVE_DICTATION_LANGUAGE: Record<TenantCode, LanguageCode> = {
  UK: "en-GB",
  KR: "ko-KR",
  PH: "en-US",
};

/** The sample rate a start asked for, or the default. Whole hertz in Transcribe's PCM range only. */
export function liveSampleRate(requested: unknown): number {
  if (requested === undefined || requested === null) return DEFAULT_SAMPLE_RATE;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < MIN_SAMPLE_RATE || requested > MAX_SAMPLE_RATE) {
    throw new HttpError("That sample rate isn't supported.", 400, "DICTATION_BAD_SAMPLE_RATE");
  }
  return requested;
}

/** One recognised stretch of speech. A partial one is still being revised as the person talks; a
 * final one AWS won't change again. */
export interface LiveTranscriptPiece {
  text: string;
  partial: boolean;
}

/** What an AWS event says, as pieces. An exception event is thrown, as the SDK does for a failed call. */
export function piecesOf(event: TranscriptResultStream): LiveTranscriptPiece[] {
  const failure =
    event.BadRequestException ?? event.LimitExceededException ?? event.InternalFailureException ?? event.ConflictException ?? event.ServiceUnavailableException;
  if (failure) {
    const name = event.BadRequestException
      ? "BadRequestException"
      : event.LimitExceededException
        ? "LimitExceededException"
        : event.InternalFailureException
          ? "InternalFailureException"
          : event.ConflictException
            ? "ConflictException"
            : "ServiceUnavailableException";
    throw Object.assign(new Error(failure.Message ?? name), { name });
  }
  const pieces: LiveTranscriptPiece[] = [];
  for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
    const text = result.Alternatives?.[0]?.Transcript?.trim();
    if (text) pieces.push({ text, partial: result.IsPartial === true });
  }
  return pieces;
}

/** Turns streamed audio into transcript pieces. The default talks to AWS; a test passes its own. */
export type StreamTranscriber = (input: {
  languageCode: LanguageCode;
  sampleRate: number;
  audio: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}) => AsyncIterable<LiveTranscriptPiece>;

export const awsStreamTranscriber: StreamTranscriber = async function* ({ languageCode, sampleRate, audio, signal }) {
  const client = new TranscribeStreamingClient({ ...awsClientConfig });
  try {
    const response = await client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: languageCode,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: sampleRate,
        AudioStream: (async function* () {
          for await (const chunk of audio) yield { AudioEvent: { AudioChunk: chunk } };
        })(),
      }),
      { abortSignal: signal },
    );
    for await (const event of response.TranscriptResultStream ?? []) {
      yield* piecesOf(event);
    }
  } finally {
    client.destroy();
  }
};

/** Audio chunks in the order they came, read by the transcriber as fast as AWS takes them. */
class AudioQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null;
  private ended = false;

  push(chunk: Uint8Array) {
    if (this.ended) return;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: chunk, done: false });
    } else {
      this.chunks.push(chunk);
    }
  }

  end() {
    this.ended = true;
    this.chunks = [];
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: undefined, done: true });
    }
  }

  /** Ends after what's already queued is read, for a stop (the last words still count). */
  finish() {
    this.ended = true;
    if (this.waiting && this.chunks.length === 0) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export interface LiveDictationEvents {
  /** The stretch being spoken now, replacing the previous partial. */
  partial(text: string): void;
  /** A finished stretch, to keep. The partial it came from is replaced by it. */
  final(text: string): void;
  /** The stream is closed: every final stretch, joined. */
  end(text: string): void;
  /** The stream failed. Finals already sent still stand. */
  error(message: string, code: string): void;
}

/** What a failed stream tells the person. They can always type instead. */
export function liveDictationFailure(err: unknown): { message: string; code: string } {
  const name = (err as { name?: string } | null)?.name;
  const message = (err as Error | null)?.message ?? "";
  if (name === "LimitExceededException") {
    return { message: "Voice input is busy right now. Try again in a moment, or type instead.", code: "DICTATION_BUSY" };
  }
  // AWS closes a stream that stops receiving audio for 15 seconds.
  if (name === "BadRequestException" && /no new audio|timed out|timeout/i.test(message)) {
    return { message: "We stopped listening because no sound came through. Try again, or type instead.", code: "DICTATION_NO_AUDIO" };
  }
  return { message: "We couldn't turn that into text. You can type instead.", code: "DICTATION_FAILED" };
}

/**
 * One person talking, from the first chunk to the end of the stream. `push` feeds it audio (16-bit
 * little-endian mono PCM at `sampleRate`), `stop` ends it and waits for the last words, and `cancel`
 * drops it with nothing more sent. It stops by itself after MAX_LIVE_DICTATION_SECONDS of audio.
 */
export class LiveDictationSession {
  private readonly audio = new AudioQueue();
  private readonly abort = new AbortController();
  private readonly finals: string[] = [];
  private readonly maxBytes: number;
  /** AWS takes at most a second of audio per event; 200 ms is what it recommends. */
  private readonly eventBytes: number;
  private bytes = 0;
  private state: "running" | "stopping" | "closed" = "running";
  private readonly clock: ReturnType<typeof setTimeout>;
  /** Settles once the stream is closed, however it closed. Never rejects. */
  readonly done: Promise<void>;

  constructor(
    private readonly options: {
      languageCode: LanguageCode;
      sampleRate: number;
      events: LiveDictationEvents;
      transcribe?: StreamTranscriber;
      maxSeconds?: number;
    },
  ) {
    const maxSeconds = options.maxSeconds ?? MAX_LIVE_DICTATION_SECONDS;
    this.maxBytes = options.sampleRate * 2 * maxSeconds;
    this.eventBytes = Math.floor((options.sampleRate * 2) / 5 / 2) * 2;
    this.clock = setTimeout(() => this.stop(), (maxSeconds + WALL_CLOCK_GRACE_SECONDS) * 1000);
    this.clock.unref?.();
    this.done = this.run();
  }

  get open() {
    return this.state !== "closed";
  }

  push(chunk: Uint8Array) {
    if (this.state !== "running" || chunk.byteLength === 0) return;
    const room = this.maxBytes - this.bytes;
    const audio = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    for (let at = 0; at < audio.byteLength; at += this.eventBytes) {
      this.audio.push(audio.subarray(at, at + this.eventBytes));
    }
    this.bytes += audio.byteLength;
    if (this.bytes >= this.maxBytes) this.stop();
  }

  stop() {
    if (this.state !== "running") return;
    this.state = "stopping";
    this.audio.finish();
  }

  cancel() {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.clock);
    this.audio.end();
    this.abort.abort();
  }

  private async run(): Promise<void> {
    const { languageCode, sampleRate, events, transcribe = awsStreamTranscriber } = this.options;
    try {
      for await (const piece of transcribe({ languageCode, sampleRate, audio: this.audio, signal: this.abort.signal })) {
        if (this.state === "closed") return;
        if (piece.partial) {
          events.partial(piece.text);
        } else {
          this.finals.push(piece.text);
          events.final(piece.text);
        }
      }
      if (this.state !== "closed") events.end(this.finals.join(" "));
    } catch (err) {
      if (this.state !== "closed") {
        logger.warn("Live dictation stream failed", { err, languageCode });
        const { message, code } = liveDictationFailure(err);
        events.error(message, code);
      }
    } finally {
      this.state = "closed";
      clearTimeout(this.clock);
      this.audio.end();
    }
  }
}

/** How many streams a person may start: each one is billed by AWS for as long as it runs. Kept in
 * this process's memory, so with several API instances each counts on its own. */
export class LiveDictationLimiter {
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  /** Counts a start, or throws when this person has had their share of the window. */
  take(userId: string, now = Date.now()) {
    const recent = (this.starts.get(userId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.starts.set(userId, recent);
      throw new HttpError("You've used voice input a lot just now. Try again in a few minutes, or type instead.", 429, "DICTATION_RATE_LIMITED");
    }
    recent.push(now);
    this.starts.set(userId, recent);
  }
}

export default class LiveDictationSvc {
  /** Who may stream and in which language: a client account (read fresh, like requireClientAccount),
   * on a site whose AI is open, with AI-processing consent on, as the record-then-upload input asks. */
  static async authorize(userId: string): Promise<LanguageCode> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, name: true, username: true } });
    if (user?.role !== "USER") throw new HttpError("This is only available in the client app", 403, "CLIENT_ACCOUNT_ONLY");
    const workspace = await ClientCaseSvc.workspaceFor(userId, user.name || user.username);
    assertClientAiOpen(workspace.tenantCode);
    await ConsentSvc.assertAllowed(userId, "AI_PROCESSING");
    return LIVE_DICTATION_LANGUAGE[workspace.tenantCode];
  }
}
