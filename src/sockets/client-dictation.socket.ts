import type { LanguageCode } from "@aws-sdk/client-transcribe-streaming";
import LiveDictationSvc, {
  LiveDictationLimiter,
  LiveDictationSession,
  MAX_LIVE_DICTATION_SECONDS,
  awsStreamTranscriber,
  liveSampleRate,
  type StreamTranscriber,
} from "../services/live-dictation.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/**
 * Live voice input over the app's one socket.io connection (lib/socket.ts), for the client app's
 * composers. The client:
 *
 *   emit("dictation:start", { sampleRate?: number }, ack)
 *     ack({ ok: true, languageCode, sampleRate, maxSeconds }) once the stream is opened (audio sent
 *     straight after is queued until AWS takes it), or
 *     ack({ ok: false, message, code }) — not a client account, AI closed on the site, consent off,
 *     already streaming, or too many starts.
 *   emit("dictation:audio", chunk)      16-bit little-endian mono PCM at that sampleRate (binary)
 *   emit("dictation:stop")              no more audio; the last words still come back
 *   emit("dictation:cancel")            drop it; nothing more is sent
 *
 * and receives, on the same socket only:
 *
 *   "dictation:partial" { text }        the stretch being spoken now, revised as it goes
 *   "dictation:final"   { text }        a finished stretch, replacing the partial
 *   "dictation:end"     { text }        the stream is closed: every final stretch, joined
 *   "dictation:error"   { message, code } it failed; finals already sent still stand
 *
 * After 180 seconds of audio the stream stops by itself and ends as if stopped. A disconnect cancels.
 */

/** The parts of a socket.io socket this needs, so a test can pass a plain emitter. */
export interface DictationSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
}

type StartAck = (
  result: { ok: true; languageCode: LanguageCode; sampleRate: number; maxSeconds: number } | { ok: false; message: string; code: string },
) => void;

export interface DictationSocketDeps {
  authorize: (userId: string) => Promise<LanguageCode>;
  transcribe: StreamTranscriber;
  limiter: LiveDictationLimiter;
  /** The stream each person has open, across all their sockets in this process: one at a time. */
  active: Map<string, LiveDictationSession>;
}

// Built on first use, not at import: lib/socket.ts imports this module, and the services behind
// LiveDictationSvc import lib/socket.ts back, so at import time they may not be loaded yet.
let defaults: DictationSocketDeps | null = null;
function defaultDeps(): DictationSocketDeps {
  defaults ??= {
    authorize: (userId) => LiveDictationSvc.authorize(userId),
    transcribe: awsStreamTranscriber,
    limiter: new LiveDictationLimiter(),
    active: new Map(),
  };
  return defaults;
}

/** What socket.io hands over for a binary emit from a browser: a Buffer in Node. */
function audioOf(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return null;
}

export function registerDictationHandlers(socket: DictationSocket, userId: string, deps: DictationSocketDeps = defaultDeps()) {
  let session: LiveDictationSession | null = null;
  let starting = false;

  const close = (which: LiveDictationSession) => {
    if (session === which) session = null;
    if (deps.active.get(userId) === which) deps.active.delete(userId);
  };

  socket.on("dictation:start", async (payload: unknown, ack?: StartAck) => {
    const reply: StartAck = typeof ack === "function" ? ack : () => {};
    if (starting || session?.open || deps.active.get(userId)?.open) {
      return reply({ ok: false, message: "Voice input is already on. Stop it first.", code: "DICTATION_ALREADY_ON" });
    }
    starting = true;
    try {
      const sampleRate = liveSampleRate((payload as { sampleRate?: unknown } | null)?.sampleRate);
      const languageCode = await deps.authorize(userId);
      // Another socket of the same person may have started while this one was being checked.
      if (deps.active.get(userId)?.open) {
        return reply({ ok: false, message: "Voice input is already on. Stop it first.", code: "DICTATION_ALREADY_ON" });
      }
      deps.limiter.take(userId);

      const started = new LiveDictationSession({
        languageCode,
        sampleRate,
        transcribe: deps.transcribe,
        events: {
          partial: (text) => socket.emit("dictation:partial", { text }),
          final: (text) => socket.emit("dictation:final", { text }),
          end: (text) => socket.emit("dictation:end", { text }),
          error: (message, code) => socket.emit("dictation:error", { message, code }),
        },
      });
      session = started;
      deps.active.set(userId, started);
      void started.done.then(() => close(started));
      reply({ ok: true, languageCode, sampleRate, maxSeconds: MAX_LIVE_DICTATION_SECONDS });
    } catch (err) {
      if (err instanceof HttpError) {
        reply({ ok: false, message: err.message, code: err.code ?? "DICTATION_REFUSED" });
      } else {
        logger.error("Live dictation couldn't start", { err, userId });
        reply({ ok: false, message: "We couldn't start voice input. Try again, or type instead.", code: "DICTATION_FAILED" });
      }
    } finally {
      starting = false;
    }
  });

  socket.on("dictation:audio", (chunk: unknown) => {
    const audio = audioOf(chunk);
    if (audio && session) session.push(audio);
  });

  socket.on("dictation:stop", () => {
    session?.stop();
  });

  const cancel = () => {
    if (!session) return;
    const dropped = session;
    dropped.cancel();
    close(dropped);
  };
  socket.on("dictation:cancel", cancel);
  socket.on("disconnect", cancel);
}
