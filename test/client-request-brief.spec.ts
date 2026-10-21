/** The anonymised brief lawyers see (#508): redactBrief takes out every party name, the client's
 * name and document names whatever the AI wrote, plus emails, phones and postcodes; the brief is
 * stored with a fingerprint and rewritten only when the case changes before a lawyer claims it.
 * Chat Wonder and the repositories are monkeypatched on their CommonJS module objects. No DB. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { redactBrief, labelForDesignation, type RedactionContext } from "../src/utils/brief-redaction";
import ClientRequestBriefSvc, { parseBriefReply } from "../src/services/client-request-brief.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ChatRepo from "../src/repositories/chat.repository";
import * as chatWonder from "../src/utils/chatWonder";
import ClientRequestNotifySvc from "../src/services/client-request-notify.service";

const ctx: RedactionContext = {
  people: [
    { name: "Acme Logistics Ltd", label: labelForDesignation("Opposing party") },
    { name: "Sarah O'Neill", label: labelForDesignation("Witness") },
    { name: "John Smith", label: "the client" },
  ],
  documentNames: ["Employment contract 2023.pdf", "Payslips Jan-Aug.pdf"],
};

describe("Anonymised case brief", () => {
  describe("redactBrief", () => {
    it("takes out every party's full name and the words that identify them", () => {
      const out = redactBrief("John Smith worked for Acme Logistics Ltd for 3 years. Acme dismissed Smith by text; Sarah O'Neill saw it.", ctx);
      for (const leak of ["John", "Smith", "Acme", "Logistics", "Sarah", "O'Neill"]) expect(out, leak).to.not.include(leak);
      expect(out).to.equal("the client worked for the other side for 3 years. the other side dismissed the client by text; a witness saw it.");
    });

    it("matches names whatever their case, but a lone word only when capitalised like a name", () => {
      expect(redactBrief("ACME LOGISTICS LTD refused.", ctx)).to.equal("the other side refused.");
      expect(redactBrief("The smith repaired the gate.", ctx)).to.equal("The smith repaired the gate.");
    });

    it("never takes out the generic parts of a company name on their own", () => {
      expect(redactBrief("The Ltd company accounts are late.", ctx)).to.equal("The Ltd company accounts are late.");
    });

    it("takes out document names, with or without the extension", () => {
      const out = redactBrief("See Employment contract 2023.pdf and the Payslips Jan-Aug.", ctx);
      expect(out).to.equal("See a document and the a document.");
    });

    it("takes out emails, UK phone numbers and postcodes, but keeps dates and money", () => {
      const out = redactBrief("Email j.smith@example.co.uk or call 07700 900123 / +44 20 7946 0958. Lives at LS1 4AP. Dismissed 2026-10-14, owed £12,500.", ctx);
      expect(out).to.equal("Email [email removed] or call [phone removed] / [phone removed]. Lives at [postcode removed]. Dismissed 2026-10-14, owed £12,500.");
    });
  });

  describe("parseBriefReply", () => {
    it("reads the JSON even with text around it, and checks each field", () => {
      expect(parseBriefReply('Here you go: {"summary": " A summary. ", "urgency": "SOON", "knownDeadline": "2026-12-01"} Thanks')).to.deep.equal({
        summary: "A summary.",
        urgency: "SOON",
        knownDeadline: "2026-12-01",
      });
      expect(parseBriefReply('{"summary": "x", "urgency": "ASAP", "knownDeadline": "next week"}')).to.deep.equal({ summary: "x", urgency: "ROUTINE", knownDeadline: null });
      expect(parseBriefReply('{"summary": ""}')).to.equal(null);
      expect(parseBriefReply("not json")).to.equal(null);
    });
  });

  describe("ClientRequestBriefSvc", () => {
    const originals = {
      findForBrief: ClientRequestRepo.findForBrief,
      saveBrief: ClientRequestRepo.saveBrief,
      listMessages: ChatRepo.listMessagesByConsultation,
      rest: chatWonder.callChatWonderRest,
      session: chatWonder.getChatWonderSessionId,
      announce: ClientRequestNotifySvc.announceInBackground,
    };
    let announced: string[];
    let source: any;
    let messages: any[];
    let saved: any[];
    let aiReply: string | Error;
    let aiCalls: number;

    beforeEach(() => {
      messages = [
        { id: "m1", role: "user", content: "Acme Logistics Ltd fired me by text. My manager John Smith signed it." },
        { id: "m2", role: "assistant", content: "That may be unfair dismissal." },
      ];
      source = {
        id: "req-1",
        status: "REQUESTED",
        caseId: "case-1",
        clientId: "client-1",
        note: "Please call me on 07700 900123, ask for John Smith.",
        brief: null,
        briefFingerprint: null,
        client: { name: "John Smith", username: "john.smith.1234" },
        case: {
          caseName: "Smith v Acme",
          practiceArea: "EMPLOYMENT",
          ukJurisdiction: "England and Wales",
          jurisdiction: "Leeds",
          clientSide: "CLAIMANT",
          parties: [{ name: "Acme Logistics Ltd", designation: "Opposing party" }],
          documents: [{ id: "d1", name: "Dismissal letter.pdf" }],
          consultations: [{ id: "cons-1" }],
        },
      };
      saved = [];
      aiCalls = 0;
      announced = [];
      (ClientRequestNotifySvc as any).announceInBackground = (id: string) => announced.push(id);
      // The AI "slips" and names everyone: the stored brief must not.
      aiReply = '{"summary": "John Smith was dismissed by Acme Logistics Ltd by text after 3 years; see Dismissal letter.pdf. He wants compensation.", "urgency": "SOON", "knownDeadline": null}';
      (ClientRequestRepo as any).findForBrief = async () => source;
      (ClientRequestRepo as any).saveBrief = async (_id: string, data: any) => {
        saved.push(data);
        if (data.brief) Object.assign(source, { brief: data.brief, briefFingerprint: data.briefFingerprint });
      };
      (ChatRepo as any).listMessagesByConsultation = async () => messages;
      (chatWonder as any).getChatWonderSessionId = async () => "session-1";
      (chatWonder as any).callChatWonderRest = async () => {
        aiCalls++;
        if (aiReply instanceof Error) throw aiReply;
        return { response: aiReply };
      };
    });
    afterEach(() => {
      (ClientRequestRepo as any).findForBrief = originals.findForBrief;
      (ClientRequestRepo as any).saveBrief = originals.saveBrief;
      (ChatRepo as any).listMessagesByConsultation = originals.listMessages;
      (chatWonder as any).callChatWonderRest = originals.rest;
      (chatWonder as any).getChatWonderSessionId = originals.session;
      (ClientRequestNotifySvc as any).announceInBackground = originals.announce;
    });

    it("announces the request to its lawyers once there's a brief for them to read (#510)", async () => {
      await ClientRequestBriefSvc.generate("req-1");
      expect(announced).to.deep.equal(["req-1"]);
    });

    it("announces nothing when the brief couldn't be written", async () => {
      aiReply = new Error("AI down");
      await ClientRequestBriefSvc.generate("req-1");
      expect(announced).to.deep.equal([]);
    });

    it("stores a brief with no party name, client name, document name or phone number, even when the AI wrote them", async () => {
      const brief = await ClientRequestBriefSvc.generate("req-1");
      const stored = JSON.stringify(saved[0].brief);
      for (const leak of ["John", "Smith", "Acme", "Logistics", "Dismissal letter", "07700"]) expect(stored, leak).to.not.include(leak);
      expect(brief).to.include({ practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales", urgency: "SOON", knownDeadline: null });
      expect(brief!.summary).to.equal("the client was dismissed by the other side by text after 3 years; see a document. He wants compensation.");
      expect(brief!.clientNote).to.equal("Please call me on [phone removed], ask for the client.");
      expect(saved[0].briefFingerprint).to.match(/^[0-9a-f]{64}$/);
    });

    it("stores the failure and keeps going when the AI's reply is unusable", async () => {
      aiReply = "Sorry, I can't help with that.";
      expect(await ClientRequestBriefSvc.generate("req-1")).to.equal(null);
      expect(saved[0]).to.have.property("briefError");
    });

    it("reuses the brief while the case is unchanged", async () => {
      await ClientRequestBriefSvc.generate("req-1");
      await ClientRequestBriefSvc.current("req-1");
      expect(aiCalls).to.equal(1);
    });

    it("writes it again when the case changes before a lawyer claims it", async () => {
      await ClientRequestBriefSvc.generate("req-1");
      messages.push({ id: "m3", role: "user", content: "I want my job back." });
      await ClientRequestBriefSvc.current("req-1");
      expect(aiCalls).to.equal(2);
    });

    it("leaves it alone once a lawyer has claimed the request", async () => {
      await ClientRequestBriefSvc.generate("req-1");
      source.status = "CLAIMED";
      messages.push({ id: "m3", role: "user", content: "Another detail." });
      await ClientRequestBriefSvc.current("req-1");
      expect(aiCalls).to.equal(1);
    });
  });
});
