import { randomUUID } from "crypto";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { deleteFromS3, uploadToS3 } from "../utils/s3";
import { deleteTranscribeJob, getTranscribeJobResult, isTranscribeJobNotFound, startTranscribeJob } from "./transcription.service";

// A UK-first app: en-GB first so British speech is spelled and modelled as such. Filipino and Korean
// stay, as in the lawyer app. One voice, so no speaker labels.
const DICTATION_TRANSCRIBE = { languageOptions: ["en-GB", "en-US", "tl-PH", "ko-KR"], speakerLabels: false };

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

export const DICTATION_KEY_PREFIX = "dictation/";
export const DICTATION_JOB_PREFIX = "dictation-";
/** Past this a clip or job is abandoned: the app records for 180s and polls for two minutes after.
 * DictationSweepQueue deletes what is older. */
export const DICTATION_MAX_AGE_MS = 60 * 60 * 1000;

export function dictationKey(userId: string, id: string, extension: string) {
  return `${DICTATION_KEY_PREFIX}${userId}/${id}.${extension}`;
}

/** The job name carries the account that started it, so one account can never read another's. */
export function dictationJobName(userId: string, id: string) {
  return `${DICTATION_JOB_PREFIX}${userId}-${id}`;
}

/** A dictation is one person talking, so it is plain text: no `[TS:12.34] [Speaker 0]:` turn
 * labels (which a transcript of several voices carries) and no paragraph breaks between them. */
export function plainDictation(transcript: string) {
  return transcript
    .replace(/\[TS:[\d.]+\]\s*/g, "")
    .replace(/\[Speaker \d+\]:\s*/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

export interface DictationResult {
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  text?: string;
}

/** Speech to text for the client app's composers (a short clip, spoken instead of typed). The clip
 * goes to S3 only for as long as the Transcribe job needs it. When the job ends, the clip and the
 * job (with the transcript AWS keeps for it) are deleted, so the text is returned once and nothing
 * is kept: not a Transcription record, not a case document. A clip whose person never came back
 * for the text is deleted by DictationSweepQueue. */
export default class ClientDictationSvc {
  static async start(userId: string, audio: Buffer, mimeType: string): Promise<{ id: string }> {
    const extension = dictationExtension(mimeType);
    if (!extension) throw new HttpError("That recording format isn't supported.", 415);
    if (audio.length === 0) throw new HttpError("The recording is empty.", 400);

    const id = randomUUID();
    const key = dictationKey(userId, id, extension);
    await uploadToS3(key, audio, mimeType.split(";")[0]!.trim());
    try {
      await startTranscribeJob(key, dictationJobName(userId, id), DICTATION_TRANSCRIBE);
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
      // An id that was never started, already collected, or someone else's (the job name carries
      // the account) is just not found, not a server fault.
      if (isTranscribeJobNotFound(err)) throw new HttpError("Recording not found.", 404);
      logger.error("Failed to poll dictation job", { err, userId, id });
      throw new HttpError("We couldn't check on your recording. Try again.", 502);
    }
    if (job.status !== "COMPLETED" && job.status !== "FAILED") return { status: "IN_PROGRESS" };

    await ClientDictationSvc.discard(userId, id, job.mediaKey);
    if (job.status === "FAILED") return { status: "FAILED" };
    return { status: "COMPLETED", text: plainDictation(job.transcript ?? "") };
  }

  /** Deletes the clip (the key Transcribe read it from) and the job with its transcript, so a
   * later poll of this id is not found. A failure is logged and left to the bucket's own expiry
   * (the clip) or AWS's (the job), not shown to the person. */
  private static async discard(userId: string, id: string, mediaKey: string | undefined) {
    if (mediaKey?.startsWith(`dictation/${userId}/`)) {
      await deleteFromS3(mediaKey).catch((err) => logger.warn("Couldn't delete a dictation clip", { err, userId, id }));
    }
    await deleteTranscribeJob(dictationJobName(userId, id)).catch((err) =>
      logger.warn("Couldn't delete a dictation job", { err, userId, id }),
    );
  }
}
