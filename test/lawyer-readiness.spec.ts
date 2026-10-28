/** When the client app suggests a lawyer (lawyer-readiness-jev.ts, ClientCaseSvc.lawyerReadiness):
 * Jev answers one yes/no per point a solicitor needs and per case area, a weak yes doesn't count,
 * and the result is stored per AI answer. Jev is stubbed at TypeSafeClient.prototype.systemOne, as
 * in audio-overview-jev.spec.ts; repositories are monkeypatched. No DB. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { assessLawyerReadiness, READINESS_MIN_CONFIDENCE } from "../src/utils/lawyer-readiness-jev";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import CaseAreaRepo from "../src/repositories/case-area.repository";
import ChatSvc from "../src/services/chat.service";

const KEYS = ["problem", "place", "otherSide", "events", "goal"] as const;

const AREAS = [
  { code: "EMPLOYMENT", name: "Employment", description: "Work, dismissal, pay." },
  { code: "CONSUMER", name: "Consumer", description: "Goods, services, refunds." },
  { code: "OTHER", name: "Other", description: "Anything else." },
];

const input = {
  caseDetails: { title: "Dismissed", areas: ["Employment"], ukJurisdiction: "England and Wales", where: "Leeds", side: "CLAIMANT", otherParties: ["Acme Ltd (Opposing party)"] },
  conversation: [{ from: "client" as const, text: "I was dismissed by text on 14 October after three years." }],
  caseAreas: AREAS,
};

describe("Lawyer readiness", () => {
  const originalSystemOne = TypeSafeClient.prototype.systemOne;
  let answers: Record<string, { choice: string; confidence: number }>;
  let jevCalls: any[];

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    jevCalls = [];
    answers = {
      ...Object.fromEntries(KEYS.map((k) => [k, { choice: "YES", confidence: 0.9 }])),
      area_EMPLOYMENT: { choice: "YES", confidence: 0.92 },
      area_CONSUMER: { choice: "NO", confidence: 0.8 },
      area_OTHER: { choice: "NO", confidence: 0.8 },
      personalInjury: { choice: "NO", confidence: 0.95 },
    };
    (TypeSafeClient.prototype as any).systemOne = async (req: any) => {
      jevCalls.push(req);
      return { answers };
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originalSystemOne;
  });

  describe("assessLawyerReadiness", () => {
    it("asks one question per point, per case area and for personal injury, in a single call", async () => {
      const result = await assessLawyerReadiness(input);
      expect(jevCalls).to.have.length(1);
      expect(Object.keys(jevCalls[0].questions)).to.deep.equal([...KEYS, "area_EMPLOYMENT", "area_CONSUMER", "area_OTHER", "personalInjury"]);
      expect(result.criteria.every((c) => c.met)).to.equal(true);
      expect(result.caseAreas).to.deep.equal([{ code: "EMPLOYMENT", confidence: 0.92 }]);
      expect(result.personalInjury.met).to.equal(false);
    });

    it("tells Jev what each area covers", async () => {
      await assessLawyerReadiness(input);
      expect(JSON.stringify(jevCalls[0].questions.area_CONSUMER)).to.include("Goods, services, refunds.");
    });

    it("gives every area Jev is sure of, so a problem can have several", async () => {
      answers.area_CONSUMER = { choice: "YES", confidence: 0.75 };
      expect((await assessLawyerReadiness(input)).caseAreas.map((a) => a.code)).to.deep.equal(["EMPLOYMENT", "CONSUMER"]);
    });

    it("doesn't count a yes Jev isn't sure of", async () => {
      answers.goal = { choice: "YES", confidence: READINESS_MIN_CONFIDENCE - 0.01 };
      answers.area_EMPLOYMENT = { choice: "YES", confidence: READINESS_MIN_CONFIDENCE - 0.01 };
      const result = await assessLawyerReadiness(input);
      expect(result.criteria.find((c) => c.key === "goal")).to.include({ met: false });
      expect(result.caseAreas).to.deep.equal([]);
    });

    it("reads an answer it doesn't recognise as no", async () => {
      answers.events = { choice: "MAYBE", confidence: 0.99 };
      expect((await assessLawyerReadiness(input)).criteria.find((c) => c.key === "events")?.met).to.equal(false);
    });

    it("offers NO before YES, so Jev's lean toward the first option errs on not suggesting yet", async () => {
      await assessLawyerReadiness(input);
      expect(Object.keys(jevCalls[0].questions.problem.criteria)).to.deep.equal(["NO", "YES"]);
      expect(Object.keys(jevCalls[0].questions.area_EMPLOYMENT.criteria)).to.deep.equal(["NO", "YES"]);
    });
  });

  describe("ClientCaseSvc.lawyerReadiness", () => {
    const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };
    let restore: () => void;
    let row: any;
    let messages: any[];
    let saved: any[];
    const savedFlag = process.env.USE_JEV_LAWYER_READINESS;

    beforeEach(() => {
      process.env.USE_JEV_LAWYER_READINESS = "true";
      const orig = { findById: ClientCaseRepo.findById, saveReadiness: ClientCaseRepo.saveReadiness, listMessages: ChatSvc.listMessages, list: CaseAreaRepo.list };
      restore = () => {
        (ClientCaseRepo as any).findById = orig.findById;
        (ClientCaseRepo as any).saveReadiness = orig.saveReadiness;
        (ChatSvc as any).listMessages = orig.listMessages;
        (CaseAreaRepo as any).list = orig.list;
        process.env.USE_JEV_LAWYER_READINESS = savedFlag;
      };
      row = {
        id: "case-1",
        caseName: "Dismissed",
        caseAreas: ["OTHER"],
        ukJurisdiction: "England and Wales",
        jurisdiction: "Leeds",
        clientSide: "CLAIMANT",
        parties: [{ name: "Acme Ltd", designation: "Opposing party" }],
        consultations: [{ id: "cons-1" }],
        lawyerReadiness: null,
      };
      messages = [
        { id: "m1", role: "user", content: "I was dismissed by text.", replyStatus: "DONE", createdAt: "t1", documents: [] },
        { id: "m2", role: "assistant", content: "That may be unfair dismissal.", replyStatus: null, createdAt: "t2", documents: [] },
      ];
      saved = [];
      (ClientCaseRepo as any).findById = async () => row;
      (ClientCaseRepo as any).saveReadiness = async (...args: any[]) => {
        saved.push(args);
      };
      (ChatSvc as any).listMessages = async () => messages;
      // RETIRED is switched off, so Jev isn't asked about it.
      (CaseAreaRepo as any).list = async () =>
        [...AREAS, { code: "RETIRED", name: "Retired", description: "Old." }].map((a, sortOrder) => ({ ...a, id: a.code, country: "UK", isActive: a.code !== "RETIRED", sortOrder }));
    });
    afterEach(() => restore());

    it("is switched off without the flag, so the app keeps its old offer", async () => {
      process.env.USE_JEV_LAWYER_READINESS = "";
      expect(await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1")).to.include({ enabled: false, ready: false });
      expect(jevCalls).to.have.length(0);
    });

    it("doesn't ask Jev before the AI has answered anything", async () => {
      messages = [messages[0]];
      const result = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(result).to.include({ enabled: true, ready: false, checkedAt: null });
      expect(jevCalls).to.have.length(0);
    });

    it("asks only about switched-on areas, and tells Jev the client's picks by name", async () => {
      await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(Object.keys(jevCalls[0].questions)).to.not.include("area_RETIRED");
      expect(jevCalls[0].state.caseDetails.areas).to.deep.equal(["Other"]);
    });

    it("is ready when every point is covered, and replaces the client's areas with Jev's", async () => {
      answers.area_CONSUMER = { choice: "YES", confidence: 0.8 };
      const result = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(result).to.include({ ready: true, blockedBy: null, basedOnMessageId: "m2" });
      expect(result.caseAreas).to.deep.equal([
        { code: "EMPLOYMENT", name: "Employment", confidence: 0.92 },
        { code: "CONSUMER", name: "Consumer", confidence: 0.8 },
      ]);
      expect(saved[0][0]).to.equal("case-1");
      expect(saved[0][2]).to.deep.equal(["EMPLOYMENT", "CONSUMER"]);
    });

    it("keeps the client's areas when Jev is sure of none", async () => {
      answers.area_EMPLOYMENT = { choice: "NO", confidence: 0.9 };
      const result = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(result).to.include({ ready: true });
      expect(result.caseAreas).to.deep.equal([]);
      expect(saved[0][2]).to.equal(undefined);
    });

    it("lists what's missing and changes nothing on the case while not ready", async () => {
      answers.goal = { choice: "NO", confidence: 0.9 };
      const result = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(result.ready).to.equal(false);
      expect(result.criteria.filter((c) => !c.met).map((c) => c.key)).to.deep.equal(["goal"]);
      expect(saved[0][2]).to.equal(undefined);
    });

    it("checks once per AI answer and reuses it until there's a new one", async () => {
      row.lawyerReadiness = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(jevCalls).to.have.length(1);
      messages.push({ id: "m3", role: "user", content: "I want compensation.", replyStatus: "DONE", documents: [] }, { id: "m4", role: "assistant", content: "OK.", documents: [] });
      await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(jevCalls).to.have.length(2);
    });

    it("asks again over a check from before a case could have several areas", async () => {
      row.lawyerReadiness = { enabled: true, ready: true, basedOnMessageId: "m2", practiceArea: { value: "EMPLOYMENT", confidence: 0.9 } };
      await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(jevCalls).to.have.length(1);
    });

    it("never suggests a lawyer outside the UK", async () => {
      row.ukJurisdiction = null;
      expect(await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1")).to.include({ ready: false, blockedBy: "OUTSIDE_UK" });
    });

    it("never suggests a lawyer for personal injury, and leaves the case's areas alone", async () => {
      answers.personalInjury = { choice: "YES", confidence: 0.9 };
      expect(await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1")).to.include({ ready: false, blockedBy: "PERSONAL_INJURY" });
      expect(saved[0][2]).to.equal(undefined);
    });

    it("says it couldn't check when Jev fails, and stores nothing", async () => {
      (TypeSafeClient.prototype as any).systemOne = async () => {
        throw new Error("Jev down");
      };
      expect(await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1")).to.include({ ready: false, unavailable: true });
      expect(saved).to.have.length(0);
    });
  });
});
