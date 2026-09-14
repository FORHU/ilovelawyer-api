import { SynthesizeSpeechCommand, VoiceId } from "@aws-sdk/client-polly";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import logger from "./logger";
import { FFMPEG_PATH } from "../config";
import { AudioOverviewTurn } from "./response-parser";
import { getPollyClient } from "./polly";
import { MAX_TURN_CHARS, TURN_SYNTHESIS_CONCURRENCY } from "../constants";

async function synthesizeTurn(text: string, voiceId: string): Promise<Buffer> {
  const client = getPollyClient();
  const result = await client.send(
    new SynthesizeSpeechCommand({
      Text: text.slice(0, MAX_TURN_CHARS),
      OutputFormat: "mp3",
      // The DB column is a plain string (Prisma has no enum matching Polly's VoiceId union),
      // but it only ever holds a value this service itself wrote from VOICE_POOL — safe cast.
      VoiceId: voiceId as VoiceId,
      // Generative, not Neural — noticeably less robotic-sounding, and every voice in
      // VOICE_POOL is confirmed Generative-capable (see that file's comment).
      Engine: "generative",
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

/** Synthesizes every turn (bounded concurrency, but written to disk in turn order regardless
 * of completion order), then concatenates them with ffmpeg's concat demuxer — a direct-copy
 * concat (no re-encoding) since every turn is the same Polly neural-MP3 format, which is why
 * this is safe here but wouldn't be for arbitrary mixed-source audio. Chosen over naive Buffer
 * concatenation specifically to avoid the click/glitch each clip's own MP3 framing would
 * otherwise cause at every stitch point (see the grilling session's ADR on this). */
export async function mergeTurnsToMp3(turns: AudioOverviewTurn[], voiceHostA: string, voiceHostB: string): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), "audio-overview-"));
  try {
    const turnPaths = await Promise.all(
      turns.map(async (turn, index) => {
        const buffer = await pool.run(() =>
          synthesizeTurn(turn.text, turn.speaker === "HOST_A" ? voiceHostA : voiceHostB),
        );
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
