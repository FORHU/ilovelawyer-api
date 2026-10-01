import { SynthesizeSpeechCommand, VoiceId } from "@aws-sdk/client-polly";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import logger from "./logger";
import { FFMPEG_PATH } from "../config";
import { AudioOverviewTurn } from "./response-parser";
import { getPollyClient } from "./polly";
import { AUDIO_OVERVIEW_ENGINE, MAX_TURN_CHARS, TURN_SYNTHESIS_CONCURRENCY } from "../constants";

// Reads MPEG frame headers directly out of the buffer — pure computation, no external binary,
// so it behaves identically on every OS/architecture. The first attempt at this (ffprobe, with
// ffprobe-static as a local-dev fallback) broke turnTimings in production outright: ffprobe-static
// ships no linux/arm64 binary at all, which is exactly what UK production deploys as. Never
// depend on a platform-specific binary for something that has to work everywhere the app runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- no @types package for this
const mp3Duration = require("mp3-duration") as (input: Buffer) => Promise<number>;

// Layer III sample rates by MPEG version bits (header byte 1, bits 3-4): 0 = 2.5, 2 = 2, 3 = 1.
const LAYER3_SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

/** Length in seconds of a clip's leading Xing/Info/VBRI header frame — 0 when it has none.
 *
 * That frame is metadata, not audio, and ffmpeg's concat demuxer drops it when it copies the
 * clip into the merged file. mp3Duration still counts it, so summing raw mp3Duration values put
 * every turn one frame (24ms at Polly's 24kHz) later than the turn before it — about a second
 * late by the end of a 40-turn script, the drift the player's highlight used to lag by.
 * Subtracting this from each clip's mp3Duration gives what that clip actually takes up in the
 * merged file. Same no-external-binary constraint as mp3Duration above: reads the bytes only. */
export function headerFrameSeconds(buffer: Buffer): number {
  let offset = 0;
  // ID3v2 tag ahead of the first frame: 10-byte header + syncsafe size (7 bits per byte).
  if (buffer.length >= 10 && buffer.toString("latin1", 0, 3) === "ID3") {
    offset = 10 + ((buffer[6]! & 0x7f) << 21) + ((buffer[7]! & 0x7f) << 14) + ((buffer[8]! & 0x7f) << 7) + (buffer[9]! & 0x7f);
  }
  while (offset + 4 <= buffer.length && !(buffer[offset] === 0xff && (buffer[offset + 1]! & 0xe0) === 0xe0)) {
    offset++;
  }
  if (offset + 4 > buffer.length) return 0;

  const versionBits = (buffer[offset + 1]! >> 3) & 0x03;
  const layerBits = (buffer[offset + 1]! >> 1) & 0x03;
  const sampleRate = LAYER3_SAMPLE_RATES[versionBits]?.[(buffer[offset + 2]! >> 2) & 0x03];
  if (layerBits !== 1 || !sampleRate) return 0; // not Layer III — never what Polly returns

  const isMpeg1 = versionBits === 3;
  const isMono = buffer[offset + 3]! >> 6 === 3;
  // Xing/Info sits right after the 4-byte header and the side info; VBRI always at byte 36.
  const sideInfoBytes = isMpeg1 ? (isMono ? 17 : 32) : isMono ? 9 : 17;
  const tagAt = (at: number) => buffer.toString("latin1", offset + at, offset + at + 4);
  const xingTag = tagAt(4 + sideInfoBytes);
  if (xingTag !== "Xing" && xingTag !== "Info" && tagAt(36) !== "VBRI") return 0;

  return (isMpeg1 ? 1152 : 576) / sampleRate;
}

type PollyEngine = "generative" | "neural";

async function synthesize(
  text: string,
  voiceId: string,
  engine: PollyEngine,
  output: { OutputFormat: "mp3" } | { OutputFormat: "json"; SpeechMarkTypes: ["sentence"] },
): Promise<Buffer> {
  const client = getPollyClient();
  const result = await client.send(
    new SynthesizeSpeechCommand({
      Text: text.slice(0, MAX_TURN_CHARS),
      ...output,
      // The DB column is a plain string (Prisma has no enum matching Polly's VoiceId union),
      // but it only ever holds a value this service itself wrote from a voice pool — safe cast.
      VoiceId: voiceId as VoiceId,
      Engine: engine,
    }),
  );
  const stream = result.AudioStream;
  if (!stream) throw new Error("Polly returned no AudioStream");
  const chunks: Buffer[] = [];
  // AudioStream is a Node Readable at runtime (this service only ever runs server-side).
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Case Reconstruction's table read — Generative (less robotic-sounding; every voice in
 * table-read-voices.ts is Generative-capable), and no speech marks needed. */
function synthesizeTurn(text: string, voiceId: string): Promise<Buffer> {
  return synthesize(text, voiceId, "generative", { OutputFormat: "mp3" });
}

/** One line of Polly's speech-marks output (newline-delimited JSON, one object per mark).
 * `time` is milliseconds from the start of that request's audio; `start`/`end` are UTF-8 BYTE
 * offsets into the input text, not string indices. */
export interface PollySpeechMark {
  time: number;
  type: string;
  start: number;
  end: number;
  value: string;
}

export function parseSpeechMarks(raw: string): PollySpeechMark[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PollySpeechMark);
}

/** Where one sentence of a turn starts in the merged audio, and which part of that turn's text
 * it is. `start`/`end` are string indices into the turn's `text` (`text.slice(start, end)`). */
export interface SentenceTiming {
  time: number;
  start: number;
  end: number;
}

/** Turns one turn's sentence marks into SentenceTimings: Polly's per-request milliseconds become
 * seconds into the merged audio (offset by the turn's own start), and its UTF-8 byte offsets
 * become string indices — they differ as soon as the script has a curly quote or an em dash. */
export function sentenceTimingsForTurn(text: string, marks: PollySpeechMark[], turnStart: number): SentenceTiming[] {
  const bytes = Buffer.from(text, "utf8");
  const toIndex = (byteOffset: number) => bytes.subarray(0, byteOffset).toString("utf8").length;
  return marks
    .filter((mark) => mark.type === "sentence")
    .map((mark) => ({ time: turnStart + mark.time / 1000, start: toIndex(mark.start), end: toIndex(mark.end) }));
}

/** Audio Overview turn — the audio, plus Polly's sentence speech marks for that same text and
 * voice. Speech marks are a separate request that returns only the marks, no audio. */
async function synthesizeTurnWithMarks(
  text: string,
  voiceId: string,
): Promise<{ audio: Buffer; marks: PollySpeechMark[] }> {
  const audio = await synthesize(text, voiceId, AUDIO_OVERVIEW_ENGINE, { OutputFormat: "mp3" });
  const raw = await synthesize(text, voiceId, AUDIO_OVERVIEW_ENGINE, {
    OutputFormat: "json",
    SpeechMarkTypes: ["sentence"],
  });
  return { audio, marks: parseSpeechMarks(raw.toString("utf8")) };
}

function spawnFfmpeg(binary: string, listPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// FFMPEG_PATH (or bare "ffmpeg" on PATH — what the Docker image's `apk add ffmpeg` provides)
// is tried first; ffmpeg-static's bundled binary is only a fallback, not the default, because
// its prebuilt Linux binary is known not to run on Alpine (musl vs. glibc) — the environment
// this API actually deploys to. So this exists purely to make local dev (Windows/Mac, no
// system package manager reach) work with zero manual setup, without risking production.
async function runFfmpegConcat(listPath: string, outputPath: string): Promise<void> {
  try {
    await spawnFfmpeg(FFMPEG_PATH, listPath, outputPath);
  } catch (err) {
    const isMissingBinary = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissingBinary) throw err;

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional fallback dep
    const ffmpegStaticPath = require("ffmpeg-static") as string | null;
    if (!ffmpegStaticPath) throw err;

    logger.warn("Audio Overview: system ffmpeg not found, falling back to ffmpeg-static", { FFMPEG_PATH });
    await spawnFfmpeg(ffmpegStaticPath, listPath, outputPath);
  }
}

/** Cumulative start second of each turn (turnTimings[0] is always 0) from that turn's clip
 * duration — the offset each turn begins at once every prior clip is concatenated ahead of it.
 * Exported for its own unit test; doesn't touch the filesystem or ffprobe itself. */
export function turnStartTimes(durations: number[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const duration of durations) {
    starts.push(cursor);
    cursor += duration;
  }
  return starts;
}

// Tiny fixed-concurrency pool — Polly synthesis is I/O-bound, TURN_SYNTHESIS_CONCURRENCY turns
// in flight at once is enough to matter for a 20-30 turn script without hammering the account's
// Polly rate limit the way full parallelism would.
const pool = {
  active: 0,
  queue: [] as Array<() => void>,
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= TURN_SYNTHESIS_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  },
};

export interface MergedAudioOverview {
  buffer: Buffer;
  /** Cumulative start second of each turn within `buffer` (turnStartTimes of each turn's
   * probed clip duration) — lets the player highlight/auto-scroll to whichever turn is
   * currently playing (see AudioOverviewTurns on the frontend). */
  turnTimings: number[];
  /** Per turn (index-aligned with `turns`), where each of its sentences starts in `buffer` —
   * sentenceTimingsForTurn of that turn's speech marks, offset by its turnTimings entry. Lets
   * the player highlight the sentence being spoken, not just the turn. */
  sentenceTimings: SentenceTiming[][];
}

/** Synthesizes every turn (bounded concurrency, but written to disk in turn order regardless
 * of completion order), then concatenates them with ffmpeg's concat demuxer — a direct-copy
 * concat (no re-encoding) since every turn is the same Polly neural-MP3 format, which is why
 * this is safe here but wouldn't be for arbitrary mixed-source audio. Chosen over naive Buffer
 * concatenation specifically to avoid the click/glitch each clip's own MP3 framing would
 * otherwise cause at every stitch point (see the grilling session's ADR on this). */
export async function mergeTurnsToMp3(
  turns: AudioOverviewTurn[],
  voiceHostA: string,
  voiceHostB: string,
): Promise<MergedAudioOverview> {
  const workDir = await mkdtemp(path.join(tmpdir(), "audio-overview-"));
  try {
    // Duration is measured on each turn's buffer right here, in memory, the moment it's
    // synthesized — not a separate pass over the written files afterward. mp3Duration is pure
    // computation (see the import comment above): it cannot fail because of what OS/architecture
    // this is running on, so there's no fallback path to reason about. Minus the clip's header
    // frame, which the concat below drops (see headerFrameSeconds) — counting it is what made
    // turnTimings drift later and later across a long script.
    const turnResults = await Promise.all(
      turns.map(async (turn, index) => {
        const { audio, marks } = await pool.run(() =>
          synthesizeTurnWithMarks(turn.text, turn.speaker === "HOST_A" ? voiceHostA : voiceHostB),
        );
        const turnPath = path.join(workDir, `turn-${String(index).padStart(3, "0")}.mp3`);
        await writeFile(turnPath, audio);
        const duration = (await mp3Duration(audio)) - headerFrameSeconds(audio);
        return { turnPath, duration, marks };
      }),
    );
    const turnPaths = turnResults.map((r) => r.turnPath);
    const turnTimings = turnStartTimes(turnResults.map((r) => r.duration));
    const sentenceTimings = turnResults.map((r, i) => sentenceTimingsForTurn(turns[i]!.text, r.marks, turnTimings[i]!));

    const listPath = path.join(workDir, "list.txt");
    const listContent = turnPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, listContent, "utf8");

    const outputPath = path.join(workDir, "merged.mp3");
    await runFfmpegConcat(listPath, outputPath);
    const buffer = await readFile(outputPath);
    return { buffer, turnTimings, sentenceTimings };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) => {
      logger.warn("Audio Overview: failed to clean up temp dir", { err, workDir });
    });
  }
}

export interface CastTurn {
  text: string;
  voiceId: string;
}

/** Case Reconstruction's "table read" (differentiation program, Phase 3 — Rung 2): the same
 * synthesize-many-short-turns-then-ffmpeg-concat pipeline as mergeTurnsToMp3 above, generalized
 * from a fixed HOST_A/HOST_B pair to an arbitrary per-turn voice — one Polly voice per scene
 * actor plus a narrator (see table-read-voices.ts), rather than two fixed hosts. Kept as a
 * separate export rather than rewriting mergeTurnsToMp3 in terms of it, so Audio Overview's
 * already-shipped, already-tested call site is untouched. */
export async function mergeCastTurnsToMp3(turns: CastTurn[]): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), "table-read-"));
  try {
    const turnPaths = await Promise.all(
      turns.map(async (turn, index) => {
        const buffer = await pool.run(() => synthesizeTurn(turn.text, turn.voiceId));
        const turnPath = path.join(workDir, `turn-${String(index).padStart(3, "0")}.mp3`);
        await writeFile(turnPath, buffer);
        return turnPath;
      }),
    );

    const listPath = path.join(workDir, "list.txt");
    const listContent = turnPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, listContent, "utf8");

    const outputPath = path.join(workDir, "merged.mp3");
    await runFfmpegConcat(listPath, outputPath);
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((err) => {
      logger.warn("Table read: failed to clean up temp dir", { err, workDir });
    });
  }
}
