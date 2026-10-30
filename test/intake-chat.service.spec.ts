/** IntakeChatSvc's turn-lifecycle processor, focused on the mark_case_ready() -> Jev gate: intake's
 * own tool call is a self-report and only an actual trigger (IntakeMessage.markedReady,
 * intake:case-ready) once Jev's independent per-criterion check (ClientCaseSvc.lawyerReadiness,
 * already live for the lawyer-suggestion flow) agrees. No live Postgres/SQS/WS: every dependency
 * is monkeypatched on its CommonJS module object, same idiom as client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import IntakeChatSvc from "../src/services/intake-chat.service";
import IntakeChatRepo from "../src/repositories/intake-chat.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseRepo from "../src/repositories/case.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import CaseAreaSvc from "../src/services/case-area.service";
import ClientCaseSvc from "../src/services/client-case.service";
import ClientIntakeSvc from "../src/services/client-intake.service";
import ConsentSvc from "../src/services/consent.service";
import * as intakeChatWonder from "../src/utils/intakeChatWonder";
import * as transcriptionService from "../src/services/transcription.service";
import * as polly from "../src/utils/polly";
import * as s3 from "../src/utils/s3";
import * as socket from "../src/lib/socket";
import type { IntakeChatGenerationJob } from "../src/queues/intake-chat-generation.queue";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const JOB: IntakeChatGenerationJob = { jobId: "msg-1", tenantCode: "UK", userId: "u1", caseId: "case-1", sessionId: "s1", userInput: "I was dismissed" };

describe("IntakeChatSvc: the Jev gate on mark_case_ready()", () => {
  let restore: (() => void)[];
  let marked: string[];
  let emitted: [string, string, any][];
  let jevReady: boolean;
  let jevCalls: number;
  let sentDocumentContext: string | undefined;

  beforeEach(() => {
    marked = [];
    emitted = [];
    jevReady = true;
    jevCalls = 0;
    sentDocumentContext = undefined;

    restore = [
      stash(ConsentSvc, ["isAllowed"]),
      stash(DocumentRepo, ["listAllByCase"]),
      stash(CaseRepo, ["findOrganizationId"]),
      stash(ClientCaseRepo, ["findById"]),
      stash(CaseAreaSvc, ["labeller"]),
      stash(ClientCaseSvc, ["lawyerReadiness"]),
      stash(ClientIntakeSvc, ["scheduleAuto"]),
      stash(IntakeChatRepo, [
        "findReplyState",
        "setReplyStatus",
        "findAssistantReplyByParent",
        "createMessage",
        "recordFindLawyerResult",
        "markReady",
      ]),
      stash(intakeChatWonder as any, ["streamIntakeChatWonderMessage"]),
      stash(socket as any, ["emitToUser"]),
    ];

    (ConsentSvc as any).isAllowed = async () => true;
    (DocumentRepo as any).listAllByCase = async () => [];
    (CaseRepo as any).findOrganizationId = async () => "org-1";
    (ClientCaseRepo as any).findById = async () => ({
      caseName: "Dismissed after a grievance",
      caseAreas: ["EMPLOYMENT"],
      ukJurisdiction: "England and Wales",
      jurisdiction: "Manchester",
      clientSide: "CLAIMANT",
      notes: null,
      parties: [{ name: "Acme Ltd", designation: "Opposing party" }],
    });
    (CaseAreaSvc as any).labeller = async () => (codes: string[]) => codes.map((c) => ({ code: c, name: "Employment" }));
    (ClientCaseSvc as any).lawyerReadiness = async () => {
      jevCalls++;
      return { enabled: true, ready: jevReady };
    };
    (ClientIntakeSvc as any).scheduleAuto = async () => undefined;
    (IntakeChatRepo as any).findReplyState = async () => ({ id: JOB.jobId, caseId: JOB.caseId, role: "user", userId: JOB.userId, replyStatus: "PENDING", pendingReplyContent: null });
    (IntakeChatRepo as any).setReplyStatus = async () => undefined;
    (IntakeChatRepo as any).findAssistantReplyByParent = async () => null;
    (IntakeChatRepo as any).createMessage = async () => ({ id: "assistant-1" });
    (IntakeChatRepo as any).recordFindLawyerResult = async () => undefined;
    (IntakeChatRepo as any).markReady = async (messageId: string) => void marked.push(messageId);
    (intakeChatWonder as any).streamIntakeChatWonderMessage = async (
      _s: string,
      _u: string,
      _onChunk: unknown,
      documentContext: string | undefined,
      _signal: unknown,
      onAnswerComplete?: () => void,
    ) => {
      sentDocumentContext = documentContext;
      onAnswerComplete?.();
      return { content: "That may be unfair dismissal.", lawyerMatches: [], caseReady: true };
    };
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("marks the message ready and emits intake:case-ready when Jev agrees", async () => {
    jevReady = true;
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(jevCalls).to.equal(1);
    expect(marked).to.deep.equal(["assistant-1"]);
    expect(emitted.some(([, event]) => event === "intake:case-ready")).to.equal(true);
  });

  it("does nothing when intake declares readiness but Jev disagrees", async () => {
    jevReady = false;
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(jevCalls).to.equal(1);
    expect(marked).to.deep.equal([]);
    expect(emitted.some(([, event]) => event === "intake:case-ready")).to.equal(false);
    // The turn still completes normally either way.
    expect(emitted.some(([, event]) => event === "chat:done")).to.equal(true);
  });

  it("never asks Jev when intake didn't declare readiness this turn", async () => {
    (intakeChatWonder as any).streamIntakeChatWonderMessage = async () => ({ content: "Tell me more.", lawyerMatches: [], caseReady: false });
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(jevCalls).to.equal(0);
    expect(marked).to.deep.equal([]);
  });

  it("fails closed (not ready) if the gate itself can't be checked", async () => {
    (ClientCaseSvc as any).lawyerReadiness = async () => {
      throw new Error("Jev down");
    };
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(marked).to.deep.equal([]);
    expect(emitted.some(([, event]) => event === "intake:case-ready")).to.equal(false);
  });

  it("still completes the turn if case-details grounding fails, just without that context", async () => {
    (ClientCaseRepo as any).findById = async () => {
      throw new Error("DB down");
    };
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(sentDocumentContext).to.equal(undefined);
    expect(emitted.some(([, event]) => event === "chat:done")).to.equal(true);
  });

  it("tells chat-wonder what the client already answered on the case form, so intake never re-asks it", async () => {
    // Regression (2026-10-29): this grounding was missing entirely — caught live when intake kept
    // re-asking the case's jurisdiction turn after turn, despite it being set at case creation.
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(sentDocumentContext).to.include("Title: Dismissed after a grievance");
    expect(sentDocumentContext).to.include("Type of problem: Employment");
    expect(sentDocumentContext).to.include("Part of the UK: England and Wales");
    expect(sentDocumentContext).to.include("Town or city: Manchester");
    expect(sentDocumentContext).to.include("The client is: bringing the complaint");
    expect(sentDocumentContext).to.include("Acme Ltd (Opposing party)");
  });

  it("still refreshes the overview every turn, whether or not Jev confirms readiness", async () => {
    let scheduled = 0;
    (ClientIntakeSvc as any).scheduleAuto = async () => void scheduled++;
    jevReady = false;
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(scheduled).to.equal(1);
  });
});

/** A voice turn's two extra steps around the ordinary turn above: Amazon Transcribe before
 * generation, AWS Polly after it (but before chat:done) — see runIntakeGenerationJob's audioS3Key
 * branches. Same no-live-infra idiom as the suite above, just with the handful of extra
 * dependencies those two steps touch. */
describe("IntakeChatSvc: voice turns", () => {
  const VOICE_JOB: IntakeChatGenerationJob = { ...JOB, userInput: "", audioS3Key: "voice-messages/case-1/rec.webm" };

  let restore: (() => void)[];
  let emitted: [string, string, any][];
  let transcribedKey: string | undefined;
  let sentUserInput: string | undefined;
  let transcribedContent: string | undefined;
  let replyAudioKey: string | undefined;

  beforeEach(() => {
    emitted = [];
    transcribedKey = undefined;
    sentUserInput = undefined;
    transcribedContent = undefined;
    replyAudioKey = undefined;

    restore = [
      stash(ConsentSvc, ["isAllowed"]),
      stash(DocumentRepo, ["listAllByCase"]),
      stash(CaseRepo, ["findOrganizationId"]),
      stash(ClientCaseRepo, ["findById"]),
      stash(ClientIntakeSvc, ["scheduleAuto"]),
      stash(IntakeChatRepo, [
        "findReplyState",
        "setReplyStatus",
        "findAssistantReplyByParent",
        "createMessage",
        "recordFindLawyerResult",
        "setTranscribedContent",
        "setReplyAudio",
      ]),
      stash(intakeChatWonder as any, ["streamIntakeChatWonderMessage"]),
      stash(transcriptionService as any, ["transcribeS3Media"]),
      stash(polly as any, ["synthesizeSpeechWithMarks"]),
      stash(s3 as any, ["uploadToS3"]),
      stash(socket as any, ["emitToUser"]),
    ];

    (ConsentSvc as any).isAllowed = async () => true;
    (DocumentRepo as any).listAllByCase = async () => [];
    (CaseRepo as any).findOrganizationId = async () => null;
    (ClientCaseRepo as any).findById = async () => null;
    (ClientIntakeSvc as any).scheduleAuto = async () => undefined;
    (IntakeChatRepo as any).findReplyState = async () => ({ id: VOICE_JOB.jobId, caseId: VOICE_JOB.caseId, role: "user", userId: VOICE_JOB.userId, replyStatus: "PENDING", pendingReplyContent: null });
    (IntakeChatRepo as any).setReplyStatus = async () => undefined;
    (IntakeChatRepo as any).findAssistantReplyByParent = async () => null;
    (IntakeChatRepo as any).createMessage = async () => ({ id: "assistant-1" });
    (IntakeChatRepo as any).recordFindLawyerResult = async () => undefined;
    (IntakeChatRepo as any).setTranscribedContent = async (_id: string, transcript: string) => void (transcribedContent = transcript);
    (IntakeChatRepo as any).setReplyAudio = async (_id: string, key: string) => void (replyAudioKey = key);
    (transcriptionService as any).transcribeS3Media = async (key: string) => {
      transcribedKey = key;
      return "I was dismissed last week";
    };
    (intakeChatWonder as any).streamIntakeChatWonderMessage = async (_s: string, userInput: string) => {
      sentUserInput = userInput;
      return { content: "That may be unfair dismissal.", lawyerMatches: [], caseReady: false };
    };
    (polly as any).synthesizeSpeechWithMarks = async () => ({ audio: Buffer.from("mp3-bytes"), sentenceTimings: [], wordTimings: [] });
    (s3 as any).uploadToS3 = async () => undefined;
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("transcribes the recording before generating, and stamps the reply with its synthesized audio", async () => {
    await IntakeChatSvc.processIntakeGenerationJob(VOICE_JOB);
    expect(transcribedKey).to.equal("voice-messages/case-1/rec.webm");
    expect(transcribedContent).to.equal("I was dismissed last week");
    // chat-wonder is asked with the transcript, not the empty placeholder the job arrived with.
    expect(sentUserInput).to.equal("I was dismissed last week");
    expect(emitted.some(([, event]) => event === "chat:voice-transcribed")).to.equal(true);
    expect(replyAudioKey).to.equal("voice-messages/case-1/assistant-1-reply.mp3");
    expect(emitted.some(([, event]) => event === "chat:done")).to.equal(true);
  });

  it("fails the turn without ever calling chat-wonder when transcription fails", async () => {
    let chatWonderCalled = false;
    (intakeChatWonder as any).streamIntakeChatWonderMessage = async () => {
      chatWonderCalled = true;
      return { content: "", lawyerMatches: [], caseReady: false };
    };
    (transcriptionService as any).transcribeS3Media = async () => {
      throw new Error("Transcribe job failed");
    };
    let failedStatus: string | undefined;
    (IntakeChatRepo as any).setReplyStatus = async (_id: string, status: string) => void (failedStatus = status);

    await IntakeChatSvc.processIntakeGenerationJob(VOICE_JOB);

    expect(chatWonderCalled).to.equal(false);
    expect(failedStatus).to.equal("FAILED");
    expect(emitted.some(([, event]) => event === "chat:error")).to.equal(true);
    expect(emitted.some(([, event]) => event === "chat:done")).to.equal(false);
  });

  it("still answers (text-only) if Polly synthesis fails — a synthesis failure must not fail an already-good turn", async () => {
    (polly as any).synthesizeSpeechWithMarks = async () => {
      throw new Error("Polly down");
    };
    await IntakeChatSvc.processIntakeGenerationJob(VOICE_JOB);
    expect(replyAudioKey).to.equal(undefined);
    expect(emitted.some(([, event]) => event === "chat:done")).to.equal(true);
  });

  it("leaves an ordinary typed turn untouched by any of this", async () => {
    await IntakeChatSvc.processIntakeGenerationJob(JOB);
    expect(transcribedKey).to.equal(undefined);
    expect(replyAudioKey).to.equal(undefined);
    expect(emitted.some(([, event]) => event === "chat:voice-transcribed")).to.equal(false);
  });
});
