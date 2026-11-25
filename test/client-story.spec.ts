/** ClientStorySvc: the story-first way into a case (POST /api/client/cases/story and
 * POST /api/client/cases/:caseId/story). No live Postgres: repositories and services are
 * monkeypatched on their CommonJS module objects, same idiom as test/client-intake.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientStorySvc, { storyTitle } from "../src/services/client-story.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientIntakeSvc, { fingerprintOf } from "../src/services/client-intake.service";
import { buildIntakePrompt, hasStoryPlaceholderDetails, parseIntakeReply, type IntakeMessageInput } from "../src/utils/client-intake-extract";
import IntakeChatSvc, { earlierConversationBlock } from "../src/services/intake-chat.service";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseAreaSvc from "../src/services/case-area.service";
import IntakeChatRepo from "../src/repositories/intake-chat.repository";
import ClientIntakeRepo from "../src/repositories/client-intake.repository";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import ConsentRepo from "../src/repositories/consent.repository";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import * as intakeExtract from "../src/utils/client-intake-extract";
import * as chatWonder from "../src/utils/chatWonder";
import { CLIENT_STORY_MAX_LENGTH } from "../src/constants/client-case.constants";

const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const workspace: ClientWorkspace = { id: "org-1", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "case-1";
const STORY = "My manager let me go on 3 March with no written notice. They still owe me two months' pay.";
const runningIntake = { status: "RUNNING" };

let created: any[];
let removed: string[];
let messages: { caseId: string; role: string; content: string; replyStatus?: string }[];
let scheduled: { caseId: string; reason: string }[];
let forgotten: string[];
let jobStatus: any;
let pendingTurn: boolean;
let failMessage: boolean;

function stubStoryDeps() {
  stash(ClientCaseSvc, ["create", "remove", "load"]);
  stash(IntakeChatRepo, ["createMessage", "hasPendingTurn"]);
  stash(IntakeChatSvc, ["forgetSession"]);
  stash(ClientIntakeSvc, ["scheduleAuto", "get"]);
  stash(AiGenerationLockSvc, ["getStatus"]);

  created = [];
  removed = [];
  messages = [];
  scheduled = [];
  forgotten = [];
  jobStatus = null;
  pendingTurn = false;
  failMessage = false;

  (ClientCaseSvc as any).create = async (_ws: ClientWorkspace, _userId: string, input: any) => {
    created.push(input);
    return { id: CASE_ID, title: input.title };
  };
  (ClientCaseSvc as any).remove = async (_ws: ClientWorkspace, _userId: string, caseId: string) => void removed.push(caseId);
  (ClientCaseSvc as any).load = async (ws: ClientWorkspace, caseId: string) => {
    if (caseId !== CASE_ID || ws.id !== workspace.id) throw Object.assign(new Error("Case not found"), { statusCode: 404 });
    return { id: CASE_ID };
  };
  (IntakeChatRepo as any).createMessage = async (caseId: string, role: string, content: string, _userId?: string, _docs?: string[], replyStatus?: string) => {
    if (failMessage) throw new Error("database down");
    messages.push({ caseId, role, content, replyStatus });
    return { id: `msg-${messages.length}` };
  };
  (IntakeChatRepo as any).hasPendingTurn = async () => pendingTurn;
  (IntakeChatSvc as any).forgetSession = async (caseId: string) => void forgotten.push(caseId);
  (ClientIntakeSvc as any).scheduleAuto = async (caseId: string, _userId: string, reason: string) => void scheduled.push({ caseId, reason });
  (ClientIntakeSvc as any).get = async () => runningIntake;
  (AiGenerationLockSvc as any).getStatus = async () => jobStatus;
}

describe("Client story", () => {
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("storyTitle", () => {
    it("takes the first sentence, without its full stop", () => {
      expect(storyTitle(STORY)).to.equal("My manager let me go on 3 March with no written notice");
    });

    it("cuts a long first sentence at a word", () => {
      const title = storyTitle(`${"word ".repeat(40)}end.`);
      expect(title.length).to.be.at.most(80);
      expect(title.endsWith("word")).to.equal(true);
    });

    it("folds line breaks and falls back for an empty story", () => {
      expect(storyTitle("I was fired\n\nby text")).to.equal("I was fired by text");
      expect(storyTitle("   ")).to.equal("New case");
    });
  });

  describe("start()", () => {
    beforeEach(stubStoryDeps);

    it("makes a placeholder case, keeps the story with no reply asked for, and starts reading it", async () => {
      const result = await ClientStorySvc.start(workspace, "user-1", STORY);

      expect(created).to.deep.equal([
        { title: "My manager let me go on 3 March with no written notice", areas: ["OTHER"], ukJurisdiction: null, outsideUk: false },
      ]);
      expect(messages).to.deep.equal([{ caseId: CASE_ID, role: "user", content: STORY, replyStatus: undefined }]);
      expect(scheduled).to.deep.equal([{ caseId: CASE_ID, reason: "story" }]);
      expect(result).to.deep.equal({ case: { id: CASE_ID, title: created[0].title }, messageId: "msg-1", intake: runningIntake });
    });

    it("is refused on a site whose AI isn't open, before anything is made", async () => {
      const error = await errorOf(ClientStorySvc.start({ ...workspace, tenantCode: "PH" }, "user-1", STORY));
      expect(error).to.deep.equal({ status: 403, code: "CLIENT_AI_NOT_OPEN" });
      expect(created).to.deep.equal([]);
    });

    it("removes the case again when the story couldn't be saved", async () => {
      failMessage = true;
      const error = await errorOf(ClientStorySvc.start(workspace, "user-1", STORY));
      expect(error).to.not.equal(undefined);
      expect(removed).to.deep.equal([CASE_ID]);
      expect(scheduled).to.deep.equal([]);
    });
  });

  describe("correct()", () => {
    beforeEach(stubStoryDeps);

    it("adds the fix, drops the open AI session so it's replayed, and reads the case again", async () => {
      const result = await ClientStorySvc.correct(workspace, "user-1", CASE_ID, "It was 4 March, not 3 March.");
      expect(messages).to.deep.equal([{ caseId: CASE_ID, role: "user", content: "It was 4 March, not 3 March.", replyStatus: undefined }]);
      expect(forgotten).to.deep.equal([CASE_ID]);
      expect(scheduled).to.deep.equal([{ caseId: CASE_ID, reason: "story" }]);
      expect(result).to.deep.equal({ messageId: "msg-1", intake: runningIntake });
    });

    it("waits while the story is still being read (409 INTAKE_RUNNING)", async () => {
      jobStatus = { status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date() };
      expect(await errorOf(ClientStorySvc.correct(workspace, "user-1", CASE_ID, "fix"))).to.deep.equal({ status: 409, code: "INTAKE_RUNNING" });
      expect(messages).to.deep.equal([]);
    });

    it("waits while a chat answer is being written (409 TURN_IN_PROGRESS)", async () => {
      pendingTurn = true;
      expect(await errorOf(ClientStorySvc.correct(workspace, "user-1", CASE_ID, "fix"))).to.deep.equal({ status: 409, code: "TURN_IN_PROGRESS" });
      expect(messages).to.deep.equal([]);
    });

    it("404s for another client's case", async () => {
      expect((await errorOf(ClientStorySvc.correct({ ...workspace, id: "org-2" }, "user-1", CASE_ID, "fix")))?.status).to.equal(404);
    });
  });

  describe("reading a long story", () => {
    const longStory = `${"Then my manager said something else that matters. ".repeat(100)}The end.`;

    it("the intake reading gets the whole first message, and later ones cut", async () => {
      stash(ClientIntakeRepo, ["findCaseForIntake"]);
      stash(IntakeChatRepo, ["listByCase"]);
      stash(CaseAreaSvc, ["refsOf"]);
      stash(AiGenerationLockSvc, ["finishWith"]);
      stash(intakeExtract, ["buildIntakePrompt"]);
      stash(chatWonder, ["getChatWonderSessionId"]);

      const answer = "x".repeat(3000);
      (ClientIntakeRepo as any).findCaseForIntake = async () => ({
        id: CASE_ID, caseName: "t", caseAreas: ["OTHER"], ukJurisdiction: null, outsideUk: false, jurisdiction: null,
        clientSide: null, notes: null, lawyerReadiness: null, parties: [], documents: [],
      });
      (IntakeChatRepo as any).listByCase = async () => [
        { id: "m1", role: "user", content: longStory, createdAt: new Date() },
        { id: "m2", role: "user", content: answer, createdAt: new Date() },
      ];
      (CaseAreaSvc as any).refsOf = async () => [];
      (AiGenerationLockSvc as any).finishWith = async (_c: string, _k: string, fn: () => Promise<void>) => fn();
      let seen: { id: string; text: string }[] = [];
      (intakeExtract as any).buildIntakePrompt = (input: { messages: { id: string; text: string }[] }) => {
        seen = input.messages;
        throw new Error("stop here");
      };
      (chatWonder as any).getChatWonderSessionId = async () => "s1";

      await errorOf(ClientIntakeSvc.runQueued(CASE_ID, "user-1"));
      expect(longStory.length).to.be.greaterThan(1500).and.at.most(CLIENT_STORY_MAX_LENGTH);
      expect(seen.find((m) => m.id === "m1")?.text).to.equal(longStory);
      expect(seen.find((m) => m.id === "m2")?.text.length).to.equal(1500);
    });

    it("a fresh chat session replays the whole story, and later messages cut", () => {
      const block = earlierConversationBlock(
        [
          { id: "m1", role: "user", content: longStory },
          { id: "m2", role: "user", content: "y".repeat(3000) },
          { id: "m3", role: "user", content: "now" },
        ],
        "m3",
      );
      expect(block).to.include(`Client: ${longStory.trim()}`);
      expect(block).to.include(`Client: ${"y".repeat(1500)}\n`.trimEnd());
      expect(block).to.not.include("y".repeat(1501));
    });

    it("a story run starts at once and never counts against the daily Update limit", async () => {
      stash(ClientIntakeRepo, ["findCaseForIntake", "find", "claimDailyRun"]);
      stash(IntakeChatRepo, ["listByCase"]);
      stash(LlmUsageRepo, ["sumCostUsd"]);
      stash(AiGenerationLockSvc, ["begin"]);
      stash(AiGenerationQueue, ["enqueue"]);
      let claimed = false;
      const enqueued: unknown[] = [];
      (ClientIntakeRepo as any).findCaseForIntake = async () => ({
        id: CASE_ID, caseName: "t", caseAreas: ["OTHER"], ukJurisdiction: null, outsideUk: false, jurisdiction: null,
        clientSide: null, notes: null, lawyerReadiness: null, parties: [], documents: [],
      });
      (ClientIntakeRepo as any).find = async () => null;
      (ClientIntakeRepo as any).claimDailyRun = async () => {
        claimed = true;
        return null;
      };
      (IntakeChatRepo as any).listByCase = async () => [{ id: "m1", role: "user", content: STORY, createdAt: new Date() }];
      (LlmUsageRepo as any).sumCostUsd = async () => 0;
      (AiGenerationLockSvc as any).begin = async () => {};
      (AiGenerationQueue as any).enqueue = (job: unknown) => void enqueued.push(job);

      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "story");
      expect(enqueued).to.deep.equal([{ kind: "clientIntake", caseId: CASE_ID, userId: "user-1" }]);
      expect(claimed).to.equal(false);
    });
  });

  describe("what we understood (the extraction)", () => {
    const story: IntakeMessageInput[] = [{ id: "m1", role: "user", text: STORY, at: new Date("2026-03-05T09:00:00Z") }];
    const parse = (obj: unknown, areaCodes?: string[]) => parseIntakeReply(JSON.stringify(obj), [], story, areaCodes)!;

    it("keeps story lines facts first and deadlines last, at most five, each with a source", () => {
      const parsed = parse({
        storySoFar: [
          { kind: "DEADLINE", text: "HR wants you to sign a quitclaim by **31 March**.", sources: ["M1"] },
          { kind: "FACT", text: "Your manager let you go on **3 March**.", sources: ["M1"] },
          { kind: "FACT", text: "You got **no written notice**.", sources: ["M1"] },
          { kind: "FACT", text: "No source here.", sources: [] },
          { kind: "FACT", text: "A made-up source.", sources: ["M9"] },
          { kind: "FACT", text: "They owe you **2 months' pay**.", sources: ["M1"] },
          { kind: "FACT", text: "Fourth fact.", sources: ["M1"] },
          { kind: "FACT", text: "Fifth fact.", sources: ["M1"] },
        ],
      });
      expect(parsed.storySoFar.map((l) => [l.kind, l.text])).to.deep.equal([
        ["FACT", "Your manager let you go on **3 March**."],
        ["FACT", "You got **no written notice**."],
        ["FACT", "They owe you **2 months' pay**."],
        ["FACT", "Fourth fact."],
        ["FACT", "Fifth fact."],
      ]);
      expect(parsed.storySoFar[0]!.sources).to.deep.equal([{ kind: "CLIENT", messageId: "m1", documentId: null, documentName: null, page: null }]);
    });

    it("keeps the deadline when there's room, and treats an unknown kind as a fact", () => {
      const parsed = parse({
        storySoFar: [
          { kind: "DEADLINE", text: "Sign by **31 March**.", sources: ["M1"] },
          { kind: "SOMETHING", text: "You were let go.", sources: ["M1"] },
        ],
      });
      expect(parsed.storySoFar.map((l) => l.kind)).to.deep.equal(["FACT", "DEADLINE"]);
    });

    it("tidies a line: no list marker, one line, and no unpaired bold", () => {
      const parsed = parse({
        storySoFar: [
          { kind: "FACT", text: "- You were let go\n on **3 March.", sources: ["M1"] },
          { kind: "FACT", text: "**  **", sources: ["M1"] },
          { kind: "FACT", text: "x".repeat(301), sources: ["M1"] },
        ],
      });
      expect(parsed.storySoFar.map((l) => l.text)).to.deep.equal(["You were let go on 3 March."]);
    });

    it("counts story lines alone as a usable reply", () => {
      expect(parse({ storySoFar: [{ kind: "FACT", text: "You were let go.", sources: ["M1"] }] })).to.not.equal(null);
    });

    it("cleans the suggested title and keeps only the site's own area codes", () => {
      const parsed = parse(
        { summary: "s", suggestedTitle: ` "Dismissed without notice and owed ${"wages ".repeat(20)}." `, suggestedAreas: ["EMPLOYMENT", "MADE_UP", "EMPLOYMENT", "HOUSING", "DEBT"] },
        ["EMPLOYMENT", "HOUSING", "DEBT"],
      );
      expect(parsed.suggestedTitle!.startsWith("Dismissed without notice and owed wages")).to.equal(true);
      expect(parsed.suggestedTitle!.length).to.be.at.most(80);
      expect(parsed.suggestedTitle!.endsWith(" ")).to.equal(false);
      expect(parsed.suggestedAreas).to.deep.equal(["EMPLOYMENT", "HOUSING"]);
    });

    it("suggests nothing when none was asked for or given", () => {
      const parsed = parse({ summary: "s", suggestedAreas: ["EMPLOYMENT"] });
      expect(parsed.suggestedTitle).to.equal(null);
      expect(parsed.suggestedAreas).to.deep.equal([]);
    });

    it("gives the AI the whole story and asks for a title and areas only when told to", () => {
      const longStory = `${"Then my manager said something else that matters. ".repeat(100)}The end.`;
      const input = {
        caseDetails: { title: "t", caseAreas: ["Other"], ukJurisdiction: null, where: null, side: null, notes: null },
        parties: [],
        messages: [{ id: "m1", role: "user" as const, text: longStory, at: new Date() }, { id: "m2", role: "user" as const, text: "z".repeat(3000), at: new Date() }],
        documents: [],
        documentExcerpts: "",
        today: "2026-03-05",
      };
      const plain = buildIntakePrompt(input);
      expect(plain).to.include(longStory);
      expect(plain).to.include(`${"z".repeat(1500)}`);
      expect(plain).to.not.include("z".repeat(1501));
      expect(plain).to.include('"storySoFar"');
      expect(plain).to.not.include("suggestedTitle");

      const asking = buildIntakePrompt({ ...input, suggestFrom: [{ code: "EMPLOYMENT", name: "Employment" }] });
      expect(asking).to.include("EMPLOYMENT: Employment");
      expect(asking).to.include('"suggestedTitle"');
    });

    it("knows a story case by its placeholder title and Other area", () => {
      const title = storyTitle(STORY);
      expect(hasStoryPlaceholderDetails({ title, caseAreaCodes: ["OTHER"] }, STORY, "OTHER")).to.equal(true);
      expect(hasStoryPlaceholderDetails({ title: "My own title", caseAreaCodes: ["OTHER"] }, STORY, "OTHER")).to.equal(false);
      expect(hasStoryPlaceholderDetails({ title, caseAreaCodes: ["EMPLOYMENT"] }, STORY, "OTHER")).to.equal(false);
      expect(hasStoryPlaceholderDetails({ title, caseAreaCodes: ["OTHER", "EMPLOYMENT"] }, STORY, "OTHER")).to.equal(false);
      expect(hasStoryPlaceholderDetails({ title, caseAreaCodes: ["OTHER"] }, null, "OTHER")).to.equal(false);
    });
  });

  describe("a reading that suggests the case details", () => {
    let caseRow: any;
    let updates: { input: any; options: any }[];
    let prompts: string[];
    let saved: { data: any; fingerprint: string }[];
    let aiReply: object;

    beforeEach(() => {
      stash(ClientIntakeRepo, ["findCaseForIntake", "saveResult"]);
      stash(IntakeChatRepo, ["listByCase"]);
      stash(CaseAreaSvc, ["refsOf", "listActive"]);
      stash(ClientCaseSvc, ["workspaceFor", "update"]);
      stash(AiGenerationLockSvc, ["finishWith"]);
      stash(chatWonder, ["getChatWonderSessionId", "callChatWonderRest"]);

      caseRow = {
        id: CASE_ID, caseName: storyTitle(STORY), caseAreas: ["OTHER"], ukJurisdiction: null, outsideUk: false, jurisdiction: null,
        clientSide: null, notes: null, lawyerReadiness: null, parties: [], documents: [],
      };
      updates = [];
      prompts = [];
      saved = [];
      aiReply = {
        summary: "s",
        storySoFar: [{ kind: "FACT", text: "You were let go on **3 March**.", sources: ["M1"] }],
        suggestedTitle: "Dismissed without notice",
        suggestedAreas: ["EMPLOYMENT"],
      };

      (ClientIntakeRepo as any).findCaseForIntake = async () => ({ ...caseRow });
      (ClientIntakeRepo as any).saveResult = async (_id: string, result: { data: any; fingerprint: string }) => void saved.push(result);
      (IntakeChatRepo as any).listByCase = async () => [{ id: "m1", role: "user", content: STORY, createdAt: new Date() }];
      (CaseAreaSvc as any).refsOf = async (codes: string[]) => codes.map((code) => ({ code, name: code === "OTHER" ? "Other" : "Employment" }));
      (CaseAreaSvc as any).listActive = async (site: string) => {
        expect(site).to.equal("KR");
        return [{ code: "EMPLOYMENT", name: "Employment" }, { code: "OTHER", name: "Other" }];
      };
      (ClientCaseSvc as any).workspaceFor = async () => ({ ...workspace, tenantCode: "KR" });
      (ClientCaseSvc as any).update = async (_ws: ClientWorkspace, _userId: string, _caseId: string, input: any, options: any) => {
        updates.push({ input, options });
        caseRow = { ...caseRow, caseName: input.title ?? caseRow.caseName, caseAreas: input.areas ?? caseRow.caseAreas };
      };
      (AiGenerationLockSvc as any).finishWith = async (_c: string, _k: string, fn: () => Promise<void>) => fn();
      (chatWonder as any).getChatWonderSessionId = async () => "s1";
      (chatWonder as any).callChatWonderRest = async (prompt: string) => {
        prompts.push(prompt);
        return { response: JSON.stringify(aiReply) };
      };
    });

    it("puts the suggested title and areas on a story case, without another run, and saves the reading as current", async () => {
      await ClientIntakeSvc.runQueued(CASE_ID, "user-1");

      expect(prompts[0]).to.include("EMPLOYMENT: Employment");
      expect(prompts[0]).to.not.include("OTHER: Other");
      expect(updates).to.deep.equal([{ input: { title: "Dismissed without notice", areas: ["EMPLOYMENT"] }, options: { refreshIntake: false } }]);
      expect(saved).to.have.length(1);
      expect(saved[0]!.fingerprint).to.equal(await fingerprintOf(caseRow, "m1"));
      expect(saved[0]!.data.formFields.typeOfAction).to.deep.equal(["Employment"]);
      expect(saved[0]!.data.storySoFar.map((l: { text: string }) => l.text)).to.deep.equal(["You were let go on **3 March**."]);
    });

    it("never asks for or changes the details of a case the client has titled", async () => {
      caseRow.caseName = "My dismissal";
      await ClientIntakeSvc.runQueued(CASE_ID, "user-1");
      expect(prompts[0]).to.not.include("suggestedTitle");
      expect(updates).to.deep.equal([]);
      expect(saved[0]!.data.storySoFar).to.have.length(1);
    });

    it("still saves the reading when the suggestion can't be applied", async () => {
      (ClientCaseSvc as any).update = async () => {
        throw Object.assign(new Error("locked"), { statusCode: 409 });
      };
      await ClientIntakeSvc.runQueued(CASE_ID, "user-1");
      expect(saved).to.have.length(1);
      expect(saved[0]!.fingerprint).to.equal(await fingerprintOf(caseRow, "m1"));
    });
  });

  describe("the routes", () => {
    let role: string;
    let sensitiveAgreed: boolean;
    const post = (path: string, as: string, body: object) =>
      request(app).post(`/api/client${path}`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` }).send(body);

    beforeEach(() => {
      stubStoryDeps();
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      stash(ConsentRepo, ["find"]);
      role = "USER";
      sensitiveAgreed = true;
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ConsentRepo as any).find = async (_userId: string, purpose: string) => (purpose === "SENSITIVE_INFO" && sensitiveAgreed ? { withdrawnAt: null } : null);
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, tenantCode: userId === "ph-client" ? "PH" : "UK" });
    });

    it("POST /cases/story makes the case and answers 202", async () => {
      const res = await post("/cases/story", "story-client-1", { text: `  ${STORY}  ` });
      expect(res.status).to.equal(202);
      expect(res.body.case.id).to.equal(CASE_ID);
      expect(res.body.messageId).to.equal("msg-1");
      expect(res.body.intake.status).to.equal("RUNNING");
      expect(messages[0]!.content).to.equal(STORY);
    });

    it("POST /cases/story refuses a story that's too short or too long", async () => {
      const short = await post("/cases/story", "story-client-2", { text: "fired" });
      expect(short.status).to.equal(400);
      expect(short.body.message).to.equal("Tell us a little more: a sentence or two is enough.");
      expect((await post("/cases/story", "story-client-2", { text: "a".repeat(CLIENT_STORY_MAX_LENGTH + 1) })).status).to.equal(400);
      expect(created).to.deep.equal([]);
    });

    it("POST /cases/story is refused until the client agrees to sensitive information", async () => {
      sensitiveAgreed = false;
      const res = await post("/cases/story", "story-client-3", { text: STORY });
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CONSENT_REQUIRED");
      expect(created).to.deep.equal([]);
    });

    it("POST /cases/story is refused on a site whose AI isn't open", async () => {
      const res = await post("/cases/story", "ph-client", { text: STORY });
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CLIENT_AI_NOT_OPEN");
    });

    it("POST /cases/story refuses a lawyer", async () => {
      role = "LAWYER";
      const res = await post("/cases/story", "story-lawyer", { text: STORY });
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
    });

    it("POST /cases/:caseId/story adds the fix and answers 202", async () => {
      const res = await post(`/cases/${CASE_ID}/story`, "story-client-4", { text: "It was 4 March." });
      expect(res.status).to.equal(202);
      expect(res.body).to.deep.equal({ messageId: "msg-1", intake: runningIntake });
    });

    it("POST /cases/:caseId/story refuses an empty fix", async () => {
      expect((await post(`/cases/${CASE_ID}/story`, "story-client-5", { text: "   " })).status).to.equal(400);
    });
  });
});
