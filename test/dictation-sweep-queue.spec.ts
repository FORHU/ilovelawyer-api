/** DictationSweepQueue deletes the dictation clips and finished Transcribe jobs nobody collected,
 * once they're older than DICTATION_MAX_AGE_MS, and leaves a recent or still-running one alone.
 * The S3 and Transcribe helpers are monkeypatched on their module objects, same idiom as
 * account-deletion-queue.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DictationSweepQueue from "../src/queues/dictation-sweep.queue";
import * as s3 from "../src/utils/s3";
import * as transcription from "../src/services/transcription.service";
import { DICTATION_MAX_AGE_MS } from "../src/services/client-dictation.service";

const NOW = new Date("2026-11-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe("DictationSweepQueue", () => {
  const originals = {
    listS3Objects: s3.listS3Objects,
    deleteFromS3: s3.deleteFromS3,
    listTranscribeJobs: transcription.listTranscribeJobs,
    deleteTranscribeJob: transcription.deleteTranscribeJob,
  };
  let clips: { key: string; lastModified: Date }[];
  let jobs: { name: string; status: string; createdAt: Date }[];
  let deletedClips: string[];
  let deletedJobs: string[];
  let failingClip: string | null;

  beforeEach(() => {
    clips = [];
    jobs = [];
    deletedClips = [];
    deletedJobs = [];
    failingClip = null;
    (s3 as any).listS3Objects = async () => clips;
    (s3 as any).deleteFromS3 = async (key: string) => {
      if (key === failingClip) throw new Error("denied");
      deletedClips.push(key);
    };
    (transcription as any).listTranscribeJobs = async () => jobs;
    (transcription as any).deleteTranscribeJob = async (name: string) => void deletedJobs.push(name);
  });

  afterEach(() => Object.assign(s3, { listS3Objects: originals.listS3Objects, deleteFromS3: originals.deleteFromS3 }) && Object.assign(transcription, { listTranscribeJobs: originals.listTranscribeJobs, deleteTranscribeJob: originals.deleteTranscribeJob }));

  it("deletes clips older than the limit and keeps a recent one", async () => {
    clips = [
      { key: "dictation/u1/old.webm", lastModified: ago(DICTATION_MAX_AGE_MS + 1000) },
      { key: "dictation/u1/new.webm", lastModified: ago(60_000) },
    ];
    const result = await DictationSweepQueue.tick(NOW);
    expect(deletedClips).to.deep.equal(["dictation/u1/old.webm"]);
    expect(result.clips).to.equal(1);
  });

  it("deletes old finished jobs, and leaves a running one and a recent one", async () => {
    jobs = [
      { name: "dictation-u1-a", status: "COMPLETED", createdAt: ago(3 * HOUR) },
      { name: "dictation-u1-b", status: "FAILED", createdAt: ago(3 * HOUR) },
      { name: "dictation-u1-c", status: "IN_PROGRESS", createdAt: ago(3 * HOUR) },
      { name: "dictation-u1-d", status: "COMPLETED", createdAt: ago(60_000) },
    ];
    const result = await DictationSweepQueue.tick(NOW);
    expect(deletedJobs).to.deep.equal(["dictation-u1-a", "dictation-u1-b"]);
    expect(result.jobs).to.equal(2);
  });

  it("carries on past a failed delete and counts it", async () => {
    clips = [
      { key: "dictation/u1/a.webm", lastModified: ago(3 * HOUR) },
      { key: "dictation/u1/b.webm", lastModified: ago(3 * HOUR) },
    ];
    failingClip = "dictation/u1/a.webm";
    const result = await DictationSweepQueue.tick(NOW);
    expect(deletedClips).to.deep.equal(["dictation/u1/b.webm"]);
    expect(result).to.deep.equal({ clips: 1, jobs: 0, failed: 1 });
  });
});
