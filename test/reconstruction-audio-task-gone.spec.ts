/**
 * A Polly synthesis task that no longer exists must not leave the reconstruction's audio
 * IN_PROGRESS forever — CaseReconstructionAudioQueue re-queues every IN_PROGRESS row on each
 * server start, so a dead task errored on every restart. No DB/AWS: statics are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseReconstructionRepo from "../src/repositories/case-reconstruction.repository";
import CaseReconstructionAudioSvc, { isSynthesisTaskGone } from "../src/services/case-reconstruction-audio.service";
import { PollyClient } from "@aws-sdk/client-polly";

describe("CaseReconstructionAudioSvc.pollAudioJob with a task Polly no longer has", () => {
  const saved: [any, string, any][] = [];
  const patch = (obj: any, key: string, value: any) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = value;
  };
  let updates: any[];
  let sendError: Error | null;

  beforeEach(() => {
    updates = [];
    sendError = null;
    patch(CaseReconstructionRepo, "get", async () => ({ caseId: "c", audioJobName: "gone-task" }));
    patch(CaseReconstructionRepo, "updateAudio", async (_id: string, data: any) => updates.push(data));
    // getPollyClient() builds a fresh client per call, so the stub goes on the prototype.
    patch(PollyClient.prototype, "send", async () => {
      if (sendError) throw sendError;
      return { SynthesisTask: undefined };
    });
  });
  afterEach(() => {
    while (saved.length) {
      const [obj, key, value] = saved.pop()!;
      obj[key] = value;
    }
  });

  it("recognises Polly's not-found error by name only", () => {
    const gone = Object.assign(new Error("UnknownError"), { name: "SynthesisTaskNotFoundException" });
    expect(isSynthesisTaskGone(gone)).to.equal(true);
    expect(isSynthesisTaskGone(new Error("ThrottlingException"))).to.equal(false);
  });

  it("marks the audio FAILED instead of throwing, so it is not re-queued on the next start", async () => {
    sendError = Object.assign(new Error("UnknownError"), { name: "SynthesisTaskNotFoundException" });
    const result = await CaseReconstructionAudioSvc.pollAudioJob("c");
    expect(result.status).to.equal("FAILED");
    expect(updates).to.deep.equal([{ audioStatus: "FAILED" }]);
  });

  it("still throws on a transient failure, leaving the row IN_PROGRESS to be retried", async () => {
    sendError = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    let thrown: any;
    try {
      await CaseReconstructionAudioSvc.pollAudioJob("c");
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.statusCode).to.equal(502);
    expect(updates).to.deep.equal([]);
  });
});
