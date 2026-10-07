/** AudioOverviewSvc — the case analysis's Audio Overview step (a case-owned overview, written in
 * wave 3 and then recorded), the Terminal pane's "latest" read and its "Retry recording", plus the
 * render path that now takes the overview's row id. No live Postgres/Chat Wonder/Polly: every
 * repository, service and util is monkeypatched on its CommonJS module object. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AudioOverviewSvc, { AUDIO_OVERVIEW_PROMPT } from "../src/services/audio-overview.service";
import AudioOverviewAudioSvc from "../src/services/audio-overview-audio.service";
import AudioOverviewQueue from "../src/queues/audio-overview.queue";
import ChatRepo from "../src/repositories/chat.repository";
import CaseRepo from "../src/repositories/case.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseAccess from "../src/utils/case-access";
import * as chatWonder from "../src/utils/chatWonder";
import * as render from "../src/utils/audio-overview-render";
import * as s3 from "../src/utils/s3";
import FilesRepo from "../src/repositories/files.repository";
import HttpError from "../src/utils/http-error";

type Patch = [object, string, unknown];
const restores: Patch[] = [];
function patch(patches: Patch[]) {
  for (const [target, key, value] of patches) {
    restores.push([target, key, (target as any)[key]]);
    (target as any)[key] = value;
  }
}
function restoreAll() {
  while (restores.length) {
    const [target, key, value] = restores.pop()!;
    (target as any)[key] = value;
  }
}

const TURNS = [
  { speaker: "A", text: "The tribunal will want to know who received the notice." },
  { speaker: "B", text: "And whether email counted under clause 1.7." },
];

describe("AudioOverviewSvc.generateForCase (the analysis's wave 3 step)", () => {
  let saved: any[];
  let statuses: any[];
  let queued: string[];
  let prompts: { input: string; context: string | undefined; language: string | undefined }[];
  let lockKinds: string[];

  beforeEach(() => {
    saved = [];
    statuses = [];
    queued = [];
    prompts = [];
    lockKinds = [];
    patch([
      [CaseFindingRepo, "list", async () => [{ category: "WEAKNESS", label: "No signed contract" }]],
      [CaseAccess, "resolveTenantCode", async () => "UK"],
      [CaseRepo, "findLanguage", async () => ({ language: "en" })],
      [DocumentChunkSvc, "relevantChunksForCase", async () => ({ caseDocumentIds: ["d1"], caseDocumentChunkIds: ["c1"] })],
      [DocumentChunkSvc, "formatGroundingContext", async () => "## EXCERPTS\nNotice served by email."],
      [CaseMindMapSvc, "buildChatContext", async () => "Findings: no signed contract."],
      [AiGenerationLockSvc, "run", async (_c: string, kind: string, fn: () => Promise<unknown>) => (lockKinds.push(kind), fn())],
      [chatWonder, "getChatWonderSessionId", async () => "sess-1"],
      [
        chatWonder,
        "streamChatWonderMessage",
        async (_s: string, input: string, _c: unknown, context: string, _g: unknown, _id: string, _t: string, _sig: unknown, _a: unknown, language: string) => {
          prompts.push({ input, context, language });
          return { content: "Here is the overview.", audioOverview: TURNS };
        },
      ],
      [ChatRepo, "saveCaseAudioOverview", async (caseId: string, turns: unknown, hostA: string, hostB: string) => (saved.push({ caseId, turns, hostA, hostB }), { id: "ao-1" })],
      [ChatRepo, "updateAudioOverviewAudio", async (id: string, data: unknown) => void statuses.push({ id, data })],
      [AudioOverviewQueue, "enqueue", (id: string) => void queued.push(id)],
    ]);
  });

  afterEach(restoreAll);

  it("writes a case-owned script under the audioOverviewScript lock, then queues its recording", async () => {
    expect(await AudioOverviewSvc.generateForCase("case-1", "user-1")).to.deep.equal({ skipped: false, id: "ao-1" });
    expect(lockKinds).to.deep.equal(["audioOverviewScript"]);
    expect(saved).to.have.length(1);
    expect(saved[0]).to.include({ caseId: "case-1" });
    expect(saved[0].turns).to.deep.equal(TURNS);
    expect(saved[0].hostA).to.not.equal(saved[0].hostB);
    expect(statuses).to.deep.equal([{ id: "ao-1", data: { audioStatus: "IN_PROGRESS" } }]);
    expect(queued).to.deep.equal(["ao-1"]);
  });

  it("asks with the audio-overview prompt, the document excerpts and the case's current analysis, in the case's language", async () => {
    await AudioOverviewSvc.generateForCase("case-1", "user-1");
    expect(prompts).to.have.length(1);
    expect(prompts[0]!.input).to.equal(AUDIO_OVERVIEW_PROMPT);
    expect(prompts[0]!.context).to.include("Notice served by email.").and.include("Findings: no signed contract.");
    expect(prompts[0]!.language).to.equal("en");
  });

  it("skips a case with no findings yet, without taking the lock", async () => {
    patch([[CaseFindingRepo, "list", async () => []]]);
    expect(await AudioOverviewSvc.generateForCase("case-1", "user-1")).to.deep.equal({ skipped: true });
    expect(lockKinds).to.deep.equal([]);
    expect(queued).to.deep.equal([]);
  });

  it("skips quietly when the case has no indexed text to ground the script on", async () => {
    patch([[DocumentChunkSvc, "relevantChunksForCase", async () => ({ caseDocumentIds: [] })]]);
    expect(await AudioOverviewSvc.generateForCase("case-1", "user-1")).to.deep.equal({ skipped: true });
    expect(saved).to.deep.equal([]);
  });

  it("still writes the script when the analysis context can't be built", async () => {
    patch([[CaseMindMapSvc, "buildChatContext", async () => Promise.reject(new Error("db down"))]]);
    await AudioOverviewSvc.generateForCase("case-1", "user-1");
    expect(prompts[0]!.context).to.include("Notice served by email.");
    expect(saved).to.have.length(1);
  });

  it("fails (and saves nothing) when Chat Wonder returns no script", async () => {
    patch([[chatWonder, "streamChatWonderMessage", async () => ({ content: "Sorry." })]]);
    let error: any;
    await AudioOverviewSvc.generateForCase("case-1", "user-1").catch((err) => (error = err));
    expect(error?.statusCode).to.equal(502);
    expect(saved).to.deep.equal([]);
    expect(queued).to.deep.equal([]);
  });
});

describe("AudioOverviewSvc.latest and retryRecording", () => {
  let queued: string[];

  beforeEach(() => {
    queued = [];
    patch([
      [CaseAccess, "loadAccessibleCase", async () => ({ id: "case-1" })],
      [CaseAccess, "assertCanEdit", async () => ({ id: "case-1" })],
      [ChatRepo, "updateAudioOverviewAudio", async () => ({})],
      [AudioOverviewQueue, "enqueue", (id: string) => void queued.push(id)],
    ]);
  });

  afterEach(restoreAll);

  it("returns the newest overview as the pane reads it, marked by who made it", async () => {
    patch([
      [
        ChatRepo,
        "findLatestAudioOverviewForCase",
        async () => ({ id: "ao-1", messageId: null, caseId: "case-1", message: null, createdAt: new Date(), audioStatus: "COMPLETED", turns: TURNS, checks: null, audioFile: null }),
      ],
    ]);
    const view = await AudioOverviewSvc.latest("case-1", "user-1");
    expect(view).to.include({ id: "ao-1", source: "analysis", consultationId: null, status: "COMPLETED" });
  });

  it("returns null for a case with no overview", async () => {
    patch([[ChatRepo, "findLatestAudioOverviewForCase", async () => null]]);
    expect(await AudioOverviewSvc.latest("case-1", "user-1")).to.equal(null);
  });

  it("re-records an overview whose recording failed", async () => {
    patch([[ChatRepo, "findCaseAudioOverview", async () => ({ id: "ao-1", audioStatus: "FAILED" })]]);
    expect(await AudioOverviewSvc.retryRecording("case-1", "ao-1", "user-1")).to.deep.equal({ status: "IN_PROGRESS" });
    expect(queued).to.deep.equal(["ao-1"]);
  });

  it("refuses while it is being recorded, once it is recorded, and for another case's overview", async () => {
    for (const [row, code] of [
      [{ id: "ao-1", audioStatus: "IN_PROGRESS" }, 409],
      [{ id: "ao-1", audioStatus: "COMPLETED" }, 409],
      [null, 404],
    ] as const) {
      patch([[ChatRepo, "findCaseAudioOverview", async () => row]]);
      let error: any;
      await AudioOverviewSvc.retryRecording("case-1", "ao-1", "user-1").catch((err) => (error = err));
      expect(error).to.be.instanceOf(HttpError);
      expect(error.statusCode).to.equal(code);
    }
    expect(queued).to.deep.equal([]);
  });
});

describe("AudioOverviewAudioSvc.process (keyed by the overview row)", () => {
  let updates: { id: string; data: any }[];

  beforeEach(() => {
    updates = [];
    patch([
      [ChatRepo, "updateAudioOverviewAudio", async (id: string, data: unknown) => void updates.push({ id, data })],
      [render, "mergeTurnsToMp3", async () => ({ buffer: Buffer.from("mp3"), turnTimings: [0, 3], sentenceTimings: [[], []], wordTimings: [[], []] })],
      [s3, "uploadToS3", async () => "https://s3/audio.mp3"],
      [FilesRepo, "create", async () => ({ id: "file-1" })],
    ]);
  });

  afterEach(restoreAll);

  it("records a case-owned overview by its row id", async () => {
    patch([[ChatRepo, "findAudioOverviewByKey", async () => ({ id: "ao-1", turns: TURNS, voiceHostA: "Brian", voiceHostB: "Amy" })]]);
    await AudioOverviewAudioSvc.process("ao-1");
    expect(updates.at(-1)).to.deep.include({ id: "ao-1" });
    expect(updates.at(-1)!.data).to.include({ audioFileId: "file-1", audioStatus: "COMPLETED" });
  });

  it("still records from an older queue message that carried the chat message id", async () => {
    let lookedUp = "";
    patch([[ChatRepo, "findAudioOverviewByKey", async (key: string) => ((lookedUp = key), { id: "ao-9", turns: TURNS, voiceHostA: "Brian", voiceHostB: "Amy" })]]);
    await AudioOverviewAudioSvc.process("msg-9");
    expect(lookedUp).to.equal("msg-9");
    expect(updates.at(-1)!.id).to.equal("ao-9");
  });

  it("marks the row FAILED when rendering throws", async () => {
    patch([
      [ChatRepo, "findAudioOverviewByKey", async () => ({ id: "ao-1", turns: TURNS, voiceHostA: "Brian", voiceHostB: "Amy" })],
      [render, "mergeTurnsToMp3", async () => Promise.reject(new Error("polly down"))],
    ]);
    await AudioOverviewAudioSvc.process("ao-1");
    expect(updates.at(-1)).to.deep.equal({ id: "ao-1", data: { audioStatus: "FAILED" } });
  });
});
