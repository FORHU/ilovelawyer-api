/** The Questions step's list (ClientQuestionsSvc.start, POST /api/client/cases/:caseId/questions)
 * and its pure half (utils/client-questions-plan.ts). No live Postgres: repositories and services are
 * monkeypatched on their CommonJS module objects, same idiom as test/client-story.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientQuestionsSvc, { stateOf } from "../src/services/client-questions.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientIntakeSvc from "../src/services/client-intake.service";
import CaseQuestionsRepo, { CASE_QUESTIONS_PLAN } from "../src/repositories/case-questions.repository";
import IntakeChatRepo from "../src/repositories/intake-chat.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import IntakeChatSvc from "../src/services/intake-chat.service";
import ConsentRepo from "../src/repositories/consent.repository";
import * as chatWonder from "../src/utils/chatWonder";
import { decryptIntakeField, encryptIntakeField } from "../src/utils/intake-field-crypto";
import {
  MAX_QUESTIONS,
  UK_PLACE_CHIPS,
  buildAnswerCheckPrompt,
  buildQuestionsPrompt,
  capQuestions,
  conversationLines,
  openDetails,
  parseAnswerCheck,
  parseQuestionsReply,
  plannedFollowUp,
  fitsLanguage,
  languageOf,
  ukPlaceChipOf,
  ukPlaceQuestion,
  type PlanLanguage,
  type QuestionDetail,
  type QuestionPlan,
} from "../src/utils/client-questions-plan";

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

const UK: ClientWorkspace = { id: "org-1", role: "OWNER", tenantCode: "UK" };
const KR: ClientWorkspace = { ...UK, tenantCode: "KR" };
const CASE_ID = "case-1";
const STORY = "My manager let me go on 3 March with no written notice. They still owe me two months' pay.";

const noPlace = { ukJurisdiction: "England and Wales", outsideUk: false, where: "Leeds" };
const allMissing = ["parties", "witnesses", "typeOfAction", "venue", "timeline", "clientGoals", "relationship", "roleAndTerms", "reasonGiven"];

describe("Client questions", () => {
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("openDetails", () => {
    it("asks place first on a UK case with no part of the UK, and what the client wants last", () => {
      const details = openDetails({ tenantCode: "UK", place: { ukJurisdiction: null, outsideUk: false, where: null }, missing: allMissing, unmetReadiness: [] });
      expect(details[0]).to.equal("place");
      expect(details.at(-1)).to.equal("goal");
    });

    it("doesn't ask place once the UK case has its part of the UK, or says it's outside the UK", () => {
      expect(openDetails({ tenantCode: "UK", place: noPlace, missing: [], unmetReadiness: [] })).to.not.include("place");
      expect(openDetails({ tenantCode: "UK", place: { ukJurisdiction: null, outsideUk: true, where: null }, missing: [], unmetReadiness: [] })).to.not.include("place");
    });

    it("asks a KR case only for its town", () => {
      expect(openDetails({ tenantCode: "KR", place: { ukJurisdiction: null, outsideUk: false, where: null }, missing: [], unmetReadiness: [] })).to.deep.equal(["place"]);
      expect(openDetails({ tenantCode: "KR", place: { ukJurisdiction: null, outsideUk: false, where: "Seoul" }, missing: [], unmetReadiness: [] })).to.deep.equal([]);
    });

    it("maps the intake's missing fields and the unmet readiness points onto the details", () => {
      const details = openDetails({ tenantCode: "UK", place: noPlace, missing: ["roleAndTerms", "witnesses"], unmetReadiness: ["otherSide", "goal"] });
      expect(details).to.deep.equal(["otherSide", "terms", "witnesses", "goal"]);
    });

    it("asks where things stand until the readiness check has said otherwise", () => {
      expect(openDetails({ tenantCode: "UK", place: noPlace, missing: [], unmetReadiness: null })).to.deep.equal(["status"]);
      expect(openDetails({ tenantCode: "UK", place: noPlace, missing: [], unmetReadiness: [] })).to.deep.equal([]);
    });
  });

  describe("capQuestions", () => {
    it("keeps at most six, place first and the goal last", () => {
      const all: QuestionDetail[] = ["place", "otherSide", "relationship", "terms", "reasonGiven", "status", "witnesses", "goal"];
      const kept = capQuestions(all.map((detail) => ({ detail }))).map((q) => q.detail);
      expect(kept).to.have.length(MAX_QUESTIONS);
      expect(kept[0]).to.equal("place");
      expect(kept.at(-1)).to.equal("goal");
      expect(kept).to.deep.equal(["place", "otherSide", "relationship", "terms", "reasonGiven", "goal"]);
    });
  });

  describe("parseQuestionsReply", () => {
    const parse = (obj: unknown, details: QuestionDetail[], tenantCode: "UK" | "KR" = "UK", language: PlanLanguage = "en") =>
      parseQuestionsReply(JSON.stringify(obj), { details, tenantCode, language });

    it("keeps the asked-for details in the fixed order, whatever order they came in", () => {
      const parsed = parse(
        {
          questions: [
            { detail: "goal", question: "What would you like to happen?", why: "It tells your lawyer what to ask for.", chips: ["Get paid", "My job back"] },
            { detail: "terms", question: "What was your job, and your pay?", why: "It sets what you're owed.", chips: ["Under £20,000"] },
            { detail: "made-up", question: "Anything else?", why: "", chips: [] },
            { detail: "terms", question: "A second terms question", why: "", chips: [] },
          ],
        },
        ["terms", "goal"],
      )!;
      expect(parsed.questions.map((q) => q.detail)).to.deep.equal(["terms", "goal"]);
      expect(parsed.questions[0]).to.include({ id: "terms", question: "What was your job, and your pay?", status: "OPEN", answer: null });
    });

    it("gives a question with no usable chips the app's own, so every question has some", () => {
      const parsed = parse({ questions: [{ detail: "status", question: "Have you heard from them since?", why: "", chips: "not a list" }] }, ["status"])!;
      expect(parsed.questions[0]!.question).to.equal("Have you heard from them since?");
      expect(parsed.questions[0]!.chips).to.deep.equal(["No contact since", "They replied", "I complained in writing", "I've started a claim"]);
    });

    it("replaces a question written in the wrong language with the app's own, chips and all", () => {
      // What Chat Wonder wrote for an English story on the KR site.
      const parsed = parse(
        {
          questions: [
            { detail: "otherSide", question: "對方是誰?", why: "律師需要確定問題的對象。", chips: ["公司", "房東"], followUps: { 公司: { question: "q", why: "", chips: [] } } },
            { detail: "terms", question: "What was your job, and your pay?", why: "It sets what you're owed.", chips: ["仁川", "Under ₩2M a month"] },
          ],
        },
        ["otherSide", "terms"],
        "KR",
      )!;
      expect(parsed.questions[0]).to.deep.include({ question: "Who is the problem with?", why: "Your lawyer needs to know who the other side is.", followUps: {} });
      expect(parsed.questions[0]!.chips).to.deep.equal(["My employer", "My landlord", "A business or shop", "A person"]);
      // Its English wording stays; fewer than two chips left in English means the app's won amounts.
      expect(parsed.questions[1]).to.deep.include({ question: "What was your job, and your pay?" });
      expect(parsed.questions[1]!.chips).to.deep.equal(["Under ₩2M a month", "₩2M – ₩3.5M a month", "₩3.5M – ₩5M a month", "Over ₩5M a month"]);
    });

    it("keeps a Korean story's questions in Korean", () => {
      const parsed = parse(
        { questions: [{ detail: "goal", question: "What would you like to happen?", why: "", chips: ["Get paid"] }, { detail: "witnesses", question: "본 사람이 있나요?", why: "증언해 줄 수 있어요.", chips: ["네", "아니요", "Maybe"] }] },
        ["witnesses", "goal"],
        "KR",
        "ko",
      )!;
      expect(parsed.questions.map((q) => q.question)).to.deep.equal(["본 사람이 있나요?", "어떻게 되기를 원하세요?"]);
      expect(parsed.questions[0]!.chips).to.deep.equal(["네", "아니요"]);
      expect(parsed.questions[1]!.chips).to.deep.equal(["받을 돈을 받고 싶어요", "일자리나 집을 되찾고 싶어요", "사과나 시정을 원해요", "선택지를 알고 싶어요"]);
    });

    it("drops a follow-up written in the wrong language", () => {
      const parsed = parse(
        {
          questions: [
            {
              detail: "witnesses", question: "Did anyone see it?", why: "", chips: ["Yes, co-workers", "No, just us"],
              followUps: { "Yes, co-workers": { question: "他們叫什麼名字?", why: "", chips: [] }, "*": { question: "When was that?", why: "", chips: ["Last week", "Last month"] } },
            },
          ],
        },
        ["witnesses"],
      )!;
      expect(Object.keys(parsed.questions[0]!.followUps)).to.deep.equal(["*"]);
    });

    it("keeps at most four short, different chips", () => {
      const parsed = parse(
        { questions: [{ detail: "goal", question: "What would you like?", why: "", chips: ["Get paid", "get paid", "x".repeat(41), "My job back", "Both", "Not sure yet", "Something else"] }] },
        ["goal"],
      )!;
      expect(parsed.questions[0]!.chips).to.deep.equal(["Get paid", "My job back", "Both", "Not sure yet"]);
    });

    it("keeps a follow-up only when it hangs off one of the question's chips, or any answer", () => {
      const parsed = parse(
        {
          questions: [
            {
              detail: "witnesses",
              question: "Did anyone see it happen?",
              why: "",
              chips: ["Yes, co-workers", "No, just us"],
              followUps: {
                "Yes, co-workers": { question: "What are their names?", why: "Your lawyer may ask them.", chips: ["I'll add names later"] },
                "Not a chip": { question: "Dropped?", why: "", chips: [] },
                "*": { question: "Anything else about it?", why: "", chips: [] },
              },
            },
          ],
        },
        ["witnesses"],
      )!;
      expect(Object.keys(parsed.questions[0]!.followUps)).to.deep.equal(["Yes, co-workers", "*"]);
    });

    it("keeps the AI's place chips on KR's place question, in the story's language, but never a follow-up", () => {
      const parsed = parse(
        { questions: [{ detail: "place", question: "어느 지역에서 있었던 일인가요?", why: "가까운 변호사를 찾는 데 도움이 됩니다.", chips: ["인천", "서울", "仁川"], followUps: { 인천: { question: "q", why: "", chips: [] } } }] },
        ["place"],
        "KR",
        "ko",
      )!;
      expect(parsed.questions[0]!.chips).to.deep.equal(["인천", "서울"]);
      expect(parsed.questions[0]!.followUps).to.deep.equal({});
    });

    it("keeps the AI's reasons for dropping a detail, only for details it was asked about", () => {
      const parsed = parse({ questions: [], dropped: [{ detail: "reasonGiven", because: "The story says no reason was given." }, { detail: "goal", because: "x" }] }, ["reasonGiven"])!;
      expect(parsed.questions).to.deep.equal([]);
      expect(parsed.dropped).to.deep.equal([{ detail: "reasonGiven", because: "The story says no reason was given." }]);
    });

    it("is null when nothing came of it", () => {
      expect(parseQuestionsReply("not json", { details: ["goal"], tenantCode: "UK" })).to.equal(null);
      expect(parse({ questions: [{ detail: "goal", question: "" }] }, ["goal"])).to.equal(null);
    });
  });

  describe("buildQuestionsPrompt", () => {
    it("lists only the details asked for, with the site's currency, and the whole story", () => {
      const longStory = `${"Something that matters happened. ".repeat(80)}The end.`;
      const prompt = buildQuestionsPrompt({
        tenantCode: "KR",
        details: ["terms", "goal"],
        caseDetails: "Known case details: …",
        conversation: conversationLines([
          { role: "user", content: longStory },
          { role: "assistant", content: "Thanks." },
          { role: "user", content: "y".repeat(3000) },
        ]),
        today: "2026-03-05",
        language: "ko",
      });
      expect(prompt).to.include("- terms:");
      expect(prompt).to.include("won (₩)");
      expect(prompt).to.include("- goal:");
      expect(prompt).to.not.include("- witnesses:");
      expect(prompt).to.include(longStory.trim());
      expect(prompt).to.not.include("y".repeat(1501));
      expect(prompt).to.include("in Korean only");
      expect(prompt).to.include("must not predict an outcome");
    });
  });

  describe("start()", () => {
    let caseRow: any;
    let intake: any;
    let stored: any;
    let claims: number;
    let released: number;
    let saved: any[];
    let prompts: string[];
    let aiReply: unknown;
    let aiFails: boolean;

    beforeEach(() => {
      stash(ClientCaseSvc, ["load"]);
      stash(ClientIntakeSvc, ["get"]);
      stash(CaseQuestionsRepo, ["find", "claim", "save", "release"]);
      stash(IntakeChatRepo, ["listByCase"]);
      stash(chatWonder, ["callChatWonderRest", "getChatWonderSessionId"]);

      caseRow = { id: CASE_ID, caseName: "My manager let me go", ukJurisdiction: null, outsideUk: false, jurisdiction: null, clientSide: null, notes: null, parties: [] };
      intake = {
        status: "READY",
        formFields: { missing: ["roleAndTerms", "witnesses", "clientGoals"], typeOfAction: ["Employment"] },
        completeness: { ready: false, criteria: [{ key: "status", label: "", met: true }] },
      };
      stored = null;
      claims = 0;
      released = 0;
      saved = [];
      prompts = [];
      aiFails = false;
      aiReply = {
        questions: [
          { detail: "terms", question: "What was your job, and your pay?", why: "It sets what you're owed.", chips: ["Under £20,000", "£20,000 – 30,000"] },
          { detail: "witnesses", question: "Did anyone see it happen?", why: "They can back you up.", chips: ["Yes", "No"] },
          { detail: "goal", question: "What would you like to happen?", why: "It tells your lawyer what to ask for.", chips: ["Get paid"] },
        ],
      };

      (ClientCaseSvc as any).load = async (ws: ClientWorkspace, caseId: string) => {
        if (caseId !== CASE_ID || ws.id !== UK.id) throw Object.assign(new Error("Case not found"), { statusCode: 404 });
        return caseRow;
      };
      (ClientIntakeSvc as any).get = async () => intake;
      (CaseQuestionsRepo as any).find = async () => stored;
      (CaseQuestionsRepo as any).claim = async () => {
        claims += 1;
        if (stored) return false;
        stored = { caseId: CASE_ID, status: "PLANNING", total: 0, plan: null, updatedAt: new Date() };
        return true;
      };
      (CaseQuestionsRepo as any).save = async (_id: string, data: any) => {
        saved.push(data);
        stored = { caseId: CASE_ID, ...data, updatedAt: new Date() };
      };
      (CaseQuestionsRepo as any).release = async () => {
        released += 1;
        if (stored?.status === "PLANNING") stored = null;
      };
      (IntakeChatRepo as any).listByCase = async () => [{ id: "m1", role: "user", content: STORY }];
      (chatWonder as any).getChatWonderSessionId = async () => "s1";
      (chatWonder as any).callChatWonderRest = async (prompt: string) => {
        prompts.push(prompt);
        if (aiFails) throw new Error("Chat Wonder down");
        return { response: JSON.stringify(aiReply) };
      };
    });

    it("writes the list once: the UK place question first (the app's own), then the AI's, and shows the first", async () => {
      const state = await ClientQuestionsSvc.start(UK, "user-1", CASE_ID);

      expect(prompts).to.have.length(1);
      // The AI is asked for the open details except the UK's place, which the app writes.
      expect(prompts[0]).to.include("- terms:");
      expect(prompts[0]).to.not.include("- place:");
      expect(saved[0].status).to.equal("OPEN");
      expect(saved[0].total).to.equal(4);
      expect(saved[0].plan.questions.map((q: any) => q.detail)).to.deep.equal(["place", "terms", "witnesses", "goal"]);
      expect(state).to.deep.include({ status: "OPEN", total: 4, answered: 0, skipped: 0, history: [] });
      expect(state.current).to.deep.include({ id: "place", detail: "place", question: "Which part of the UK did this happen in?" });
      expect(state.current!.chips).to.deep.equal([...UK_PLACE_CHIPS]);
    });

    it("comes back to the same list without writing it again", async () => {
      await ClientQuestionsSvc.start(UK, "user-1", CASE_ID);
      const again = await ClientQuestionsSvc.start(UK, "user-1", CASE_ID);
      expect(prompts).to.have.length(1);
      expect(again.total).to.equal(4);
      expect(again.current!.id).to.equal("place");
    });

    it("has nothing to ask when the story covered it all, without calling the AI", async () => {
      caseRow.ukJurisdiction = "England and Wales";
      intake.formFields.missing = [];
      const state = await ClientQuestionsSvc.start(UK, "user-1", CASE_ID);
      expect(prompts).to.have.length(0);
      expect(state).to.deep.equal({ status: "DONE", total: 0, answered: 0, skipped: 0, current: null, history: [] });
    });

    it("drops what the AI found answered, and asks a KR case for its town in the app's own words, in the story's language", async () => {
      intake.formFields.missing = ["reasonGiven"];
      aiReply = {
        questions: [{ detail: "place", question: "Where did this happen in Incheon?", why: "The lawyer needs to know the specific location to understand jurisdiction.", chips: ["Incheon"] }],
        dropped: [{ detail: "reasonGiven", because: "The story says no reason was given." }],
      };
      const state = await ClientQuestionsSvc.start(KR, "user-1", CASE_ID);
      expect(prompts[0]).to.include("- place:");
      expect(state.total).to.equal(1);
      // The app's wording, the AI's places to tap.
      expect(state.current).to.deep.include({ detail: "place", question: "Which city or area did this happen in?", why: "It helps find a lawyer near you.", chips: ["Incheon"] });
      expect(saved[0].plan.dropped).to.deep.equal([{ detail: "reasonGiven", because: "The story says no reason was given." }]);

      // A story told in Korean gets the question in Korean; with no places from the AI, the largest areas.
      stored = null;
      aiReply = { questions: [{ detail: "place", question: "어디였나요?", why: "", chips: [] }] };
      (IntakeChatRepo as any).listByCase = async () => [{ id: "m1", role: "user", content: "3월 3일에 팀장님이 그만 나오라고 했습니다." }];
      const korean = await ClientQuestionsSvc.start(KR, "user-1", CASE_ID);
      expect(korean.current).to.deep.include({ question: "어느 도시나 지역에서 있었던 일인가요?", why: "가까운 변호사를 찾는 데 도움이 됩니다.", chips: ["서울", "경기도", "부산", "인천"] });
    });

    it("gives an English KR story's town question the largest areas when the AI suggests no places", async () => {
      intake.formFields.missing = [];
      intake.completeness = { ready: false, criteria: [] };
      aiReply = { questions: [{ detail: "place", question: "Where?", why: "", chips: [] }] };
      const state = await ClientQuestionsSvc.start(KR, "user-1", CASE_ID);
      expect(state.current!.chips).to.deep.equal(["Seoul", "Gyeonggi-do", "Busan", "Incheon"]);
    });

    it("tells the AI to drop the town when the story names it, and never to use legal terms", async () => {
      await ClientQuestionsSvc.start(KR, "user-1", CASE_ID);
      expect(prompts[0]).to.include("if it does, drop this detail");
      expect(prompts[0]).to.include("never use legal terms (such as jurisdiction");
    });

    it("waits while the story is still being read (409 INTAKE_RUNNING), writing nothing", async () => {
      intake.status = "RUNNING";
      expect(await errorOf(ClientQuestionsSvc.start(UK, "user-1", CASE_ID))).to.deep.equal({ status: 409, code: "INTAKE_RUNNING" });
      expect(claims).to.equal(0);
    });

    it("asks a second start to wait while the list is being written (409 QUESTIONS_PREPARING)", async () => {
      stored = { caseId: CASE_ID, status: "PLANNING", total: 0, plan: null, updatedAt: new Date() };
      expect(await errorOf(ClientQuestionsSvc.start(UK, "user-1", CASE_ID))).to.deep.equal({ status: 409, code: "QUESTIONS_PREPARING" });
      expect(prompts).to.have.length(0);
    });

    it("writes the list again when an earlier attempt was abandoned", async () => {
      stored = { caseId: CASE_ID, status: "PLANNING", total: 0, plan: null, updatedAt: new Date(Date.now() - 10 * 60 * 1000) };
      const state = await ClientQuestionsSvc.start(UK, "user-1", CASE_ID);
      expect(released).to.equal(1);
      expect(state.total).to.equal(4);
    });

    it("saves nothing when the list can't be written (502), so the next start tries again", async () => {
      aiFails = true;
      expect(await errorOf(ClientQuestionsSvc.start(UK, "user-1", CASE_ID))).to.deep.equal({ status: 502, code: "QUESTIONS_FAILED" });
      expect(stored).to.equal(null);
      expect(saved).to.deep.equal([]);

      aiFails = false;
      aiReply = "not json";
      expect(await errorOf(ClientQuestionsSvc.start(UK, "user-1", CASE_ID))).to.deep.equal({ status: 502, code: "QUESTIONS_FAILED" });
      expect(stored).to.equal(null);
    });

    it("is refused on a site whose AI isn't open, and 404s for another client's case", async () => {
      expect(await errorOf(ClientQuestionsSvc.start({ ...UK, tenantCode: "PH" }, "user-1", CASE_ID))).to.deep.equal({ status: 403, code: "CLIENT_AI_NOT_OPEN" });
      expect((await errorOf(ClientQuestionsSvc.start({ ...UK, id: "org-2" }, "user-1", CASE_ID)))?.status).to.equal(404);
    });
  });

  describe("read()", () => {
    beforeEach(() => {
      stash(ClientCaseSvc, ["load"]);
      stash(CaseQuestionsRepo, ["find"]);
      (ClientCaseSvc as any).load = async (ws: ClientWorkspace) => {
        if (ws.id !== UK.id) throw Object.assign(new Error("Case not found"), { statusCode: 404 });
        return { id: CASE_ID };
      };
    });

    it("shows where the questions are, without writing a list", async () => {
      (CaseQuestionsRepo as any).find = async () => ({
        caseId: CASE_ID, status: "OPEN", total: 1, updatedAt: new Date(),
        plan: { version: 1, dropped: [], questions: [{ id: "goal", detail: "goal", question: "What would you like?", why: "", chips: [], followUps: {}, status: "OPEN", answer: null }] },
      });
      const state = await ClientQuestionsSvc.read(UK, CASE_ID);
      expect(state).to.deep.include({ status: "OPEN", total: 1, answered: 0 });
    });

    it("is null with no list, or one still being written, and 404s for another client's case", async () => {
      (CaseQuestionsRepo as any).find = async () => null;
      expect(await ClientQuestionsSvc.read(UK, CASE_ID)).to.equal(null);
      (CaseQuestionsRepo as any).find = async () => ({ caseId: CASE_ID, status: "PLANNING", total: 0, plan: null, updatedAt: new Date() });
      expect(await ClientQuestionsSvc.read(UK, CASE_ID)).to.equal(null);
      expect((await errorOf(ClientQuestionsSvc.read({ ...UK, id: "org-2" }, CASE_ID)))?.status).to.equal(404);
    });
  });

  describe("stateOf", () => {
    it("counts answered and skipped questions, shows the next open one, and redraws the thread", () => {
      const q = (detail: QuestionDetail, status: "OPEN" | "ANSWERED" | "SKIPPED", answer: string | null = null) => ({
        id: detail, detail, question: `${detail}?`, why: "", chips: [], followUps: {}, status, answer,
      });
      const state = stateOf({
        status: "OPEN",
        total: 3,
        plan: { version: 1, dropped: [], questions: [q("place", "ANSWERED", "Scotland"), q("terms", "SKIPPED"), q("goal", "OPEN")] },
      });
      expect(state).to.deep.include({ status: "OPEN", total: 3, answered: 1, skipped: 1 });
      expect(state.current!.id).to.equal("goal");
      expect(state.history).to.deep.equal([
        { id: "place", question: "place?", why: "", answer: "Scotland", skipped: false },
        { id: "terms", question: "terms?", why: "", answer: null, skipped: true },
      ]);
    });
  });

  describe("storage", () => {
    it("seals the list under its own label when encryption is on", () => {
      const cfg = { enabled: true, key: "07".repeat(32) };
      const sealed = encryptIntakeField(JSON.stringify({ questions: ["What was your pay?"] }), CASE_QUESTIONS_PLAN, cfg);
      expect(sealed).to.not.include("What was your pay?");
      expect(decryptIntakeField(sealed, CASE_QUESTIONS_PLAN, cfg)).to.include("What was your pay?");
      // A value sealed for another column never opens here.
      expect(decryptIntakeField(sealed, "IntakeMessage.content", cfg)).to.equal(null);
    });
  });

  describe("matching answers", () => {
    it("reads a typed UK place as its part of the UK, only when it names one", () => {
      expect(ukPlaceChipOf("scotland")).to.equal("Scotland");
      expect(ukPlaceChipOf("I live in Glasgow")).to.equal("Scotland");
      expect(ukPlaceChipOf("It was in London")).to.equal("England and Wales");
      expect(ukPlaceChipOf("Belfast")).to.equal("Northern Ireland");
      expect(ukPlaceChipOf("I was working abroad")).to.equal("Outside the UK");
      expect(ukPlaceChipOf("New South Wales")).to.equal(null);
      expect(ukPlaceChipOf("I moved from Glasgow to London")).to.equal(null);
      expect(ukPlaceChipOf("Not sure")).to.equal(null);
    });

    it("finds the chip an answer is, and the follow-up the list gave it", () => {
      const witnesses = {
        id: "witnesses" as const, detail: "witnesses" as const, question: "Did anyone see it?", why: "", status: "OPEN" as const, answer: null,
        chips: ["Yes, co-workers", "No, just us"],
        followUps: { "Yes, co-workers": { question: "What are their names?", why: "", chips: [] } },
      };
      expect(plannedFollowUp(witnesses, "yes, CO-WORKERS", "UK")).to.deep.equal({ chip: "Yes, co-workers", followUp: witnesses.followUps["Yes, co-workers"] });
      expect(plannedFollowUp(witnesses, "No, just us", "UK")).to.deep.equal({ chip: "No, just us", followUp: null });
      expect(plannedFollowUp(witnesses, "my friend Sam", "UK")).to.deep.equal({ chip: null, followUp: null });
      expect(plannedFollowUp(ukPlaceQuestion(), "in Edinburgh", "UK").chip).to.equal("Scotland");
    });

    it("tells which language text is in, and never lets Chinese or Japanese through", () => {
      expect(fitsLanguage("Who is the problem with?", "en")).to.equal(true);
      expect(fitsLanguage("누구와의 문제인가요?", "en")).to.equal(false);
      expect(fitsLanguage("對方是誰?", "en")).to.equal(false);
      expect(fitsLanguage("누구와의 문제인가요?", "ko")).to.equal(true);
      expect(fitsLanguage("Who is it?", "ko")).to.equal(false);
      expect(fitsLanguage("仁川", "ko", "chip")).to.equal(false);
      expect(fitsLanguage("2023", "ko", "chip")).to.equal(true);
      expect(languageOf("My manager let me go")).to.equal("en");
      expect(languageOf("팀장님이 그만 나오라고 했어요")).to.equal("ko");
    });

    it("gives each UK part its own largest towns to tap, after the part is chosen", () => {
      const place = ukPlaceQuestion();
      expect(place.followUps["Scotland"]!.chips).to.deep.equal(["Glasgow", "Edinburgh", "Aberdeen", "Dundee"]);
      expect(place.followUps["England and Wales"]!.chips[0]).to.equal("London");
      expect(place.followUps["Outside the UK"]).to.equal(undefined);
    });

    it("drops a check's follow-up written in another language than the case's", () => {
      const reply = '{"complete": false, "followUp": {"question": "你的工資是多少?", "why": "", "chips": []}}';
      expect(parseAnswerCheck(reply, "en")).to.equal(null);
      expect(parseAnswerCheck('{"complete": false, "followUp": {"question": "월급은 얼마였나요?", "why": "", "chips": ["월 200만 원"]}}', "ko")).to.deep.equal({
        question: "월급은 얼마였나요?",
        why: "",
        chips: ["월 200만 원"],
      });
    });

    it("takes a follow-up from the check only when it says the answer is incomplete", () => {
      expect(parseAnswerCheck('{"complete": true, "followUp": null}')).to.equal(null);
      expect(parseAnswerCheck('{"complete": false, "followUp": {"question": "And your pay?", "why": "It sets what you are owed.", "chips": ["Under £20,000"]}}')).to.deep.equal({
        question: "And your pay?",
        why: "It sets what you are owed.",
        chips: ["Under £20,000"],
      });
      expect(parseAnswerCheck('{"complete": false, "followUp": {"question": ""}}')).to.equal(null);
      expect(parseAnswerCheck("no json")).to.equal(null);
      expect(buildAnswerCheckPrompt({ detail: "terms", question: "What was your job, and pay?", answer: "Supervisor", tenantCode: "UK", language: "en" })).to.include("The client's answer: Supervisor");
    });
  });

  describe("answering", () => {
    let stored: any;
    let caseUpdates: any[];
    let messages: { role: string; content: string }[];
    let checks: string[];
    let checkReply: unknown;
    let checkFails: boolean;
    let pendingTurn: boolean;
    let finished: { cleared: number; scheduled: string[] };
    let saveConflict: boolean;

    const plan = (): QuestionPlan => ({
      version: 1,
      dropped: [],
      questions: [
        ukPlaceQuestion(),
        { id: "terms", detail: "terms", question: "What was your job, and your pay?", why: "It sets what you're owed.", chips: ["Under £20,000", "£20,000 – 30,000"], followUps: {}, status: "OPEN", answer: null },
        {
          id: "witnesses", detail: "witnesses", question: "Did anyone see it happen?", why: "They can back you up.", chips: ["Yes, co-workers", "No, just us"],
          followUps: { "Yes, co-workers": { question: "What are their names?", why: "Your lawyer may ask them.", chips: ["I'll add names later"] } },
          status: "OPEN", answer: null,
        },
      ],
    });

    beforeEach(() => {
      stash(ClientCaseSvc, ["load", "update"]);
      stash(CaseQuestionsRepo, ["find", "saveIfUnchanged"]);
      stash(IntakeChatRepo, ["createExchange", "hasPendingTurn"]);
      stash(IntakeChatSvc, ["forgetSession"]);
      stash(ClientCaseRepo, ["clearReadiness"]);
      stash(ClientIntakeSvc, ["scheduleAuto"]);
      stash(chatWonder, ["callChatWonderRest", "getChatWonderSessionId"]);

      stored = { caseId: CASE_ID, status: "OPEN", total: 3, plan: plan(), updatedAt: new Date(1) };
      caseUpdates = [];
      messages = [];
      checks = [];
      checkReply = { complete: true, followUp: null };
      checkFails = false;
      pendingTurn = false;
      finished = { cleared: 0, scheduled: [] };
      saveConflict = false;

      (ClientCaseSvc as any).load = async () => ({ id: CASE_ID });
      (ClientCaseSvc as any).update = async (_ws: ClientWorkspace, _u: string, _c: string, input: any, options: any) => void caseUpdates.push({ input, options });
      (CaseQuestionsRepo as any).find = async () => (stored ? JSON.parse(JSON.stringify({ ...stored, updatedAt: stored.updatedAt.toISOString() }), (k, v) => (k === "updatedAt" ? new Date(v) : v)) : null);
      (CaseQuestionsRepo as any).saveIfUnchanged = async (_id: string, seen: Date, data: any) => {
        if (saveConflict || seen.getTime() !== stored.updatedAt.getTime()) return false;
        stored = { ...stored, ...data, updatedAt: new Date(stored.updatedAt.getTime() + 1) };
        return true;
      };
      (IntakeChatRepo as any).createExchange = async (_caseId: string, _userId: string, asked: string, said: string) => {
        messages.push({ role: "assistant", content: asked }, { role: "user", content: said });
      };
      (IntakeChatRepo as any).hasPendingTurn = async () => pendingTurn;
      (IntakeChatSvc as any).forgetSession = async () => {};
      (ClientCaseRepo as any).clearReadiness = async () => void (finished.cleared += 1);
      (ClientIntakeSvc as any).scheduleAuto = async (_c: string, _u: string, reason: string) => void finished.scheduled.push(reason);
      (chatWonder as any).getChatWonderSessionId = async () => "s1";
      (chatWonder as any).callChatWonderRest = async (prompt: string) => {
        checks.push(prompt);
        if (checkFails) throw new Error("Chat Wonder down");
        return { response: JSON.stringify(checkReply) };
      };
    });

    const answer = (questionId: string, text: string, via: "tap" | "typed" | "voice" = "tap", ws = UK) => ClientQuestionsSvc.answer(ws, "user-1", CASE_ID, { questionId, text, via });

    it("puts a tapped UK place on the case, keeps both in the chat, and asks for the town without moving the bar", async () => {
      const state = await answer("place", "Scotland");
      expect(caseUpdates).to.deep.equal([{ input: { ukJurisdiction: "Scotland" }, options: { refreshIntake: false } }]);
      expect(messages).to.deep.equal([
        { role: "assistant", content: "Which part of the UK did this happen in?" },
        { role: "user", content: "Scotland" },
      ]);
      expect(state.current).to.deep.include({ id: "place.followUp", detail: "place", question: "Which town or city?", followUp: true });
      expect(state).to.deep.include({ answered: 0, skipped: 0 });
      expect(state.history).to.deep.equal([{ id: "place", question: "Which part of the UK did this happen in?", why: ukPlaceQuestion().why, answer: "Scotland", skipped: false }]);

      const next = await answer("place.followUp", "Glasgow", "typed");
      expect(caseUpdates[1].input).to.deep.equal({ where: "Glasgow" });
      expect(next.current).to.deep.include({ id: "terms", followUp: false });
      expect(next.answered).to.equal(1);
      expect(checks).to.deep.equal([]);
    });

    it("reads a typed UK place as its region, and outside the UK asks no town", async () => {
      await answer("place", "I was in Glasgow", "typed");
      expect(caseUpdates[0].input).to.deep.equal({ ukJurisdiction: "Scotland" });

      stored = { caseId: CASE_ID, status: "OPEN", total: 3, plan: plan(), updatedAt: new Date(1) };
      const state = await answer("place", "Outside the UK");
      expect(caseUpdates[1].input).to.deep.equal({ ukJurisdiction: null, outsideUk: true });
      expect(state.current!.id).to.equal("terms");
    });

    it("puts a KR town straight on the case, with no check", async () => {
      stored.plan.questions = [{ id: "place", detail: "place", question: "어느 지역인가요?", why: "", chips: [], followUps: {}, status: "OPEN", answer: null }];
      stored.total = 1;
      const state = await answer("place", "서울", "voice", KR);
      expect(caseUpdates[0].input).to.deep.equal({ where: "서울" });
      expect(checks).to.deep.equal([]);
      expect(state.status).to.equal("DONE");
    });

    it("follows a tapped chip's own follow-up without asking the AI", async () => {
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail === "witnesses");
      const state = await answer("witnesses", "Yes, co-workers");
      expect(checks).to.deep.equal([]);
      expect(state.current).to.deep.include({ id: "witnesses.followUp", question: "What are their names?", chips: ["I'll add names later"] });
    });

    it("asks the AI about a typed answer that isn't a chip, and follows up when it's incomplete", async () => {
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail === "terms");
      checkReply = { complete: false, followUp: { question: "And what was your pay?", why: "It sets what you're owed.", chips: ["Under £20,000"] } };
      const state = await answer("terms", "I was a supervisor", "typed");
      expect(checks).to.have.length(1);
      expect(checks[0]).to.include("The client's answer: I was a supervisor");
      expect(state.current).to.deep.include({ id: "terms.followUp", question: "And what was your pay?", followUp: true });
    });

    it("moves on when the typed answer is complete, when it's a chip typed out, or when the check fails", async () => {
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail !== "place");
      let state = await answer("terms", "Supervisor on £24,000", "voice");
      expect(state.current!.id).to.equal("witnesses");

      state = await answer("witnesses", "no, just us", "typed");
      expect(checks).to.have.length(1);
      expect(state.status).to.equal("DONE");

      stored = { caseId: CASE_ID, status: "OPEN", total: 3, plan: plan(), updatedAt: new Date(1) };
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail === "terms");
      checkFails = true;
      state = await answer("terms", "Supervisor", "typed");
      expect(state.status).to.equal("DONE");
    });

    it("skips a question for the lawyer to ask, in the client's own words", async () => {
      const state = await ClientQuestionsSvc.skip(UK, "user-1", CASE_ID, { questionId: "place", text: "잘 모르겠어요." });
      expect(messages.at(-1)).to.deep.equal({ role: "user", content: "잘 모르겠어요." });
      expect(state).to.deep.include({ skipped: 1, answered: 0 });
      expect(state.history[0]).to.deep.include({ id: "place", answer: null, skipped: true });
      expect(caseUpdates).to.deep.equal([]);

      await ClientQuestionsSvc.skip(UK, "user-1", CASE_ID, { questionId: "terms" });
      expect(messages.at(-1)).to.deep.equal({ role: "user", content: "I'm not sure." });
    });

    it("leaves a detail answered when only its follow-up is skipped", async () => {
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail === "witnesses");
      await answer("witnesses", "Yes, co-workers");
      const state = await ClientQuestionsSvc.skip(UK, "user-1", CASE_ID, { questionId: "witnesses.followUp" });
      expect(state).to.deep.include({ status: "DONE", answered: 1, skipped: 0 });
      expect(state.history.map((h) => [h.id, h.skipped])).to.deep.equal([["witnesses", false], ["witnesses.followUp", true]]);
    });

    it("after the last question, reads the case once and asks the readiness check again", async () => {
      stored.plan.questions = stored.plan.questions.filter((q: any) => q.detail === "terms");
      await answer("terms", "Under £20,000");
      expect(stored.status).to.equal("DONE");
      expect(finished).to.deep.equal({ cleared: 1, scheduled: ["questions"] });
    });

    it("refuses an answer to a question the screen isn't on any more", async () => {
      expect(await errorOf(answer("terms", "Under £20,000"))).to.deep.equal({ status: 409, code: "QUESTION_NOT_CURRENT" });
      saveConflict = true;
      expect(await errorOf(answer("place", "Scotland"))).to.deep.equal({ status: 409, code: "QUESTION_NOT_CURRENT" });
      expect(messages).to.deep.equal([]);
      expect(caseUpdates).to.deep.equal([]);
    });

    it("refuses before the list exists, after it's done, and while a chat answer is being written", async () => {
      stored = null;
      expect(await errorOf(answer("place", "Scotland"))).to.deep.equal({ status: 409, code: "QUESTIONS_NOT_STARTED" });
      stored = { caseId: CASE_ID, status: "DONE", total: 0, plan: { version: 1, dropped: [], questions: [] }, updatedAt: new Date(1) };
      expect(await errorOf(answer("place", "Scotland"))).to.deep.equal({ status: 409, code: "QUESTIONS_DONE" });
      stored = { caseId: CASE_ID, status: "OPEN", total: 3, plan: plan(), updatedAt: new Date(1) };
      pendingTurn = true;
      expect(await errorOf(answer("place", "Scotland"))).to.deep.equal({ status: 409, code: "TURN_IN_PROGRESS" });
    });
  });

  describe("the route", () => {
    let role: string;
    let sensitiveAgreed: boolean;
    const post = (as: string) => request(app).post(`/api/client/cases/${CASE_ID}/questions`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` });

    beforeEach(() => {
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      stash(ConsentRepo, ["find"]);
      stash(ClientQuestionsSvc, ["start"]);
      role = "USER";
      sensitiveAgreed = true;
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ConsentRepo as any).find = async (_userId: string, purpose: string) => (purpose === "SENSITIVE_INFO" && sensitiveAgreed ? { withdrawnAt: null } : null);
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...UK, tenantCode: userId === "ph-client" ? "PH" : "UK" });
      (ClientQuestionsSvc as any).start = async () => ({ status: "OPEN", total: 1, answered: 0, skipped: 0, current: { id: "goal" }, history: [] });
    });

    it("answers with where the questions are", async () => {
      const res = await post("q-client-1");
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.include({ status: "OPEN", total: 1 });
    });

    it("is refused until the client agrees to sensitive information", async () => {
      sensitiveAgreed = false;
      const res = await post("q-client-2");
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CONSENT_REQUIRED");
    });

    it("is refused on a site whose AI isn't open, and to a lawyer", async () => {
      expect((await post("ph-client")).body.code).to.equal("CLIENT_AI_NOT_OPEN");
      role = "LAWYER";
      expect((await post("q-lawyer")).body.code).to.equal("CLIENT_ACCOUNT_ONLY");
    });

    it("answers and skips, refusing an answer with no text or an unknown way of giving it", async () => {
      stash(ClientQuestionsSvc, ["answer", "skip"]);
      const seen: unknown[] = [];
      (ClientQuestionsSvc as any).answer = async (_ws: unknown, _u: string, _c: string, input: unknown) => {
        seen.push(input);
        return { status: "OPEN" };
      };
      (ClientQuestionsSvc as any).skip = async (_ws: unknown, _u: string, _c: string, input: unknown) => {
        seen.push(input);
        return { status: "OPEN" };
      };
      const auth = { Authorization: `Bearer ${loginToken("q-client-3").accessToken}` };
      const answer = (body: object) => request(app).post(`/api/client/cases/${CASE_ID}/questions/answer`).set(auth).send(body);

      expect((await answer({ questionId: "terms", text: "  Supervisor  ", via: "typed" })).status).to.equal(200);
      expect((await answer({ questionId: "terms", text: "   ", via: "typed" })).status).to.equal(400);
      expect((await answer({ questionId: "terms", text: "Supervisor", via: "telepathy" })).status).to.equal(400);
      expect((await request(app).post(`/api/client/cases/${CASE_ID}/questions/skip`).set(auth).send({ questionId: "terms" })).status).to.equal(200);
      expect(seen).to.deep.equal([{ questionId: "terms", text: "Supervisor", via: "typed" }, { questionId: "terms" }]);
    });
  });
});
