/** When the client app suggests a lawyer (lawyer-readiness-jev.ts, ClientCaseSvc.lawyerReadiness):
 * Jev answers one yes/no per point a solicitor needs, a weak yes doesn't count, and the result is
 * stored per AI answer. Jev is stubbed at TypeSafeClient.prototype.systemOne, as in
 * audio-overview-jev.spec.ts; repositories are monkeypatched. No DB. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { assessLawyerReadiness, READINESS_MIN_CONFIDENCE } from "../src/utils/lawyer-readiness-jev";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ChatSvc from "../src/services/chat.service";

const KEYS = ["problem", "place", "otherSide", "events", "goal"] as const;

const input = {
  caseDetails: { title: "Dismissed", area: "EMPLOYMENT", ukJurisdiction: "England and Wales", where: "Leeds", side: "CLAIMANT", otherParties: ["Acme Ltd (Opposing party)"] },
  conversation: [{ from: "client" as const, text: "I was dismissed by text on 14 October after three years." }],
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
      practiceArea: { choice: "EMPLOYMENT", confidence: 0.92 },
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
    it("asks one question per point, plus the kind of lawyer, in a single call", async () => {
      const result = await assessLawyerReadiness(input);
      expect(jevCalls).to.have.length(1);
      expect(Object.keys(jevCalls[0].questions)).to.deep.equal([...KEYS, "practiceArea"]);
      expect(result.criteria.every((c) => c.met)).to.equal(true);
      expect(result.practiceArea).to.deep.equal({ value: "EMPLOYMENT", confidence: 0.92 });
    });

    it("doesn't count a yes Jev isn't sure of", async () => {
      answers.goal = { choice: "YES", confidence: READINESS_MIN_CONFIDENCE - 0.01 };
      const result = await assessLawyerReadiness(input);
      expect(result.criteria.find((c) => c.key === "goal")).to.include({ met: false });
    });

    it("reads an answer it doesn't recognise as no", async () => {
      answers.events = { choice: "MAYBE", confidence: 0.99 };
      expect((await assessLawyerReadiness(input)).criteria.find((c) => c.key === "events")?.met).to.equal(false);
    });

    it("offers NO before YES, so Jev's lean toward the first option errs on not suggesting yet", async () => {
      await assessLawyerReadiness(input);
      expect(Object.keys(jevCalls[0].questions.problem.criteria)).to.deep.equal(["NO", "YES"]);
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
      const orig = { findById: ClientCaseRepo.findById, saveReadiness: ClientCaseRepo.saveReadiness, listMessages: ChatSvc.listMessages };
      restore = () => {
        (ClientCaseRepo as any).findById = orig.findById;
        (ClientCaseRepo as any).saveReadiness = orig.saveReadiness;
        (ChatSvc as any).listMessages = orig.listMessages;
        process.env.USE_JEV_LAWYER_READINESS = savedFlag;
      };
      row = {
        id: "case-1",
        caseName: "Dismissed",
        practiceArea: "OTHER",
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

    it("is ready when every point is covered, and settles the case's practice area", async () => {
      const result = await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1");
      expect(result).to.include({ ready: true, blockedBy: null, basedOnMessageId: "m2" });
      expect(saved[0][0]).to.equal("case-1");
      expect(saved[0][2]).to.equal("EMPLOYMENT");
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

    it("never suggests a lawyer outside the UK", async () => {
      row.ukJurisdiction = null;
      expect(await ClientCaseSvc.lawyerReadiness(workspace, "u1", "case-1")).to.include({ ready: false, blockedBy: "OUTSIDE_UK" });
    });

    it("never suggests a lawyer for personal injury, and doesn't store it as the case's area", async () => {
      answers.practiceArea = { choice: "PERSONAL_INJURY", confidence: 0.9 };
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
