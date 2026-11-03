import { randomUUID } from "crypto";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { deleteFromS3, uploadToS3 } from "../utils/s3";
import { getTranscribeJobResult, startTranscribeJob } from "./transcription.service";

// What a browser's MediaRecorder produces, and the extension AWS Transcribe reads the format from.
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "audio/webm;codecs=opus" -> "webm"; null for anything Transcribe can't read. */
export function dictationExtension(mimeType: string): string | null {
  return EXTENSION_BY_MIME[mimeType.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function dictationKey(userId: string, id: string, extension: string) {
  return `dictation/${userId}/${id}.${extension}`;
}

/** The job name carries the account that started it, so one account can never read another's. */
export function dictationJobName(userId: string, id: string) {
  return `dictation-${userId}-${id}`;
}

/** Speaker labels are for recordings of several people; a dictation is one person talking. */
export function plainDictation(transcript: string) {
  return transcript.replace(/\[Speaker \d+\]:\s*/g, "").trim();
}

export interface DictationResult {
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  text?: string;
}

/** Speech to text for the client app's composers (a short clip, spoken instead of typed). The clip
 * goes to S3 only for as long as the Transcribe job needs it; it is deleted as soon as the job
 * ends, and nothing about it is kept: not a Transcription record, not a case document. */
export default class ClientDictationSvc {
  static async start(userId: string, audio: Buffer, mimeType: string): Promise<{ id: string }> {
    const extension = dictationExtension(mimeType);
    if (!extension) throw new HttpError("That recording format isn't supported.", 415);
    if (audio.length === 0) throw new HttpError("The recording is empty.", 400);

    const id = randomUUID();
    const key = dictationKey(userId, id, extension);
    await uploadToS3(key, audio, mimeType.split(";")[0]!.trim());
    try {
      await startTranscribeJob(key, dictationJobName(userId, id));
    } catch (err) {
      logger.error("Failed to start dictation job", { err, userId, id });
      await deleteFromS3(key).catch(() => {});
      throw new HttpError("We couldn't start transcribing. Try again.", 502);
    }
    return { id };
  }

  static async result(userId: string, id: string): Promise<DictationResult> {
    if (!ID.test(id)) throw new HttpError("Recording not found.", 404);
    let job;
    try {
      job = await getTranscribeJobResult(dictationJobName(userId, id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.error("Failed to poll dictation job", { err, userId, id });
      throw new HttpError("We couldn't check on your recording. Try again.", 502);
    }
    if (job.status !== "COMPLETED" && job.status !== "FAILED") return { status: "IN_PROGRESS" };

    await ClientDictationSvc.discard(userId, id);
    if (job.status === "FAILED") return { status: "FAILED" };
    return { status: "COMPLETED", text: plainDictation(job.transcript ?? "") };
  }

  /** Deletes the clip, whatever extension it was stored with. A failure is logged and left to the
   * bucket's own expiry, not shown to the person. */
  private static async discard(userId: string, id: string) {
    for (const extension of new Set(Object.values(EXTENSION_BY_MIME))) {
      await deleteFromS3(dictationKey(userId, id, extension)).catch((err) =>
        logger.warn("Couldn't delete a dictation clip", { err, userId, id, extension }),
      );
    }
  }
}
