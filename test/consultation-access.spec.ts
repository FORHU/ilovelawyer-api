/** Who may use a Consultation. A Case's Consultations are shared with everyone who can open the
 * Case; deleting someone else's needs edit rights on the Case; a standalone (case-less)
 * Consultation keeps the organization-only check it always had. ChatRepo, ParticipantRepo,
 * CaseAccess and CaseSvc are monkeypatched on their module objects, same idiom as
 * test/chat-list-messages-download-link.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ChatSvc from "../src/services/chat.service";
import CaseSvc from "../src/services/case.service";
import ChatRepo from "../src/repositories/chat.repository";
import ParticipantRepo from "../src/repositories/participant.repository";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

const CASE_CONSULTATION = { id: "c1", organizationId: "org-1", userId: "creator", caseId: "case-1" };

async function statusOf(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return err.statusCode;
    throw err;
  }
}

describe("Consultation access", () => {
  const originals = {
    findConsultationById: ChatRepo.findConsultationById,
    listMessagesByConsultation: ChatRepo.listMessagesByConsultation,
    deleteConsultation: ChatRepo.deleteConsultation,
    updateConsultation: ChatRepo.updateConsultation,
    listConsultations: ChatRepo.listConsultations,
    createConsultation: ChatRepo.createConsultation,
    participantExists: ParticipantRepo.exists,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    assertCanEdit: CaseAccess.assertCanEdit,
    getCaseById: CaseSvc.getById,
  };
  let consultation: any;
  let participants: Set<string>;
  let caseReaders: Set<string>;
  let caseEditors: Set<string>;
  let deleted: string[];

  beforeEach(() => {
    consultation = { ...CASE_CONSULTATION };
    participants = new Set();
    caseReaders = new Set(["colleague"]);
    caseEditors = new Set();
    deleted = [];
    (ChatRepo as any).findConsultationById = async () => consultation;
    (ChatRepo as any).listMessagesByConsultation = async () => [];
    (ChatRepo as any).deleteConsultation = async (id: string) => deleted.push(id);
    (ChatRepo as any).updateConsultation = async (id: string, title: string) => ({ id, title });
    (ChatRepo as any).listConsultations = async () => [];
    (ChatRepo as any).createConsultation = async (_o: string, userId: string, title?: string, caseId?: string) => ({ id: "new", userId, title, caseId });
    (ParticipantRepo as any).exists = async (_c: string, userId: string) => participants.has(userId);
    (CaseAccess as any).loadAccessibleCase = async (_caseId: string, userId: string) => {
      if (!caseReaders.has(userId) && !caseEditors.has(userId)) throw new HttpError("Case not found", 404);
      return { id: "case-1" };
    };
    (CaseAccess as any).assertCanEdit = async (_caseId: string, userId: string) => {
      if (!caseEditors.has(userId)) throw new HttpError("Case not found or not editable", 404);
      return { id: "case-1" };
    };
    (CaseSvc as any).getById = async () => ({ id: "case-1" });
  });

  afterEach(() => {
    Object.assign(ChatRepo, {
      findConsultationById: originals.findConsultationById,
      listMessagesByConsultation: originals.listMessagesByConsultation,
      deleteConsultation: originals.deleteConsultation,
      updateConsultation: originals.updateConsultation,
      listConsultations: originals.listConsultations,
      createConsultation: originals.createConsultation,
    });
    (ParticipantRepo as any).exists = originals.participantExists;
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (CaseSvc as any).getById = originals.getCaseById;
  });

  describe("reading a case-linked Consultation", () => {
    it("lets the creator, a colleague on the Case and an invited participant read it", async () => {
      participants.add("guest");
      expect(await statusOf(ChatSvc.listMessages("org-1", "creator", "c1"))).to.equal("ok");
      expect(await statusOf(ChatSvc.listMessages("org-1", "colleague", "c1"))).to.equal("ok");
      expect(await statusOf(ChatSvc.listMessages("org-1", "guest", "c1"))).to.equal("ok");
    });

    it("404s for an org member who can't open the Case", async () => {
      expect(await statusOf(ChatSvc.listMessages("org-1", "outsider", "c1"))).to.equal(404);
    });

    it("404s across organizations even for the creator", async () => {
      expect(await statusOf(ChatSvc.listMessages("org-2", "creator", "c1"))).to.equal(404);
    });

    it("keeps the organization-only check for a standalone Consultation", async () => {
      consultation = { ...CASE_CONSULTATION, caseId: null };
      expect(await statusOf(ChatSvc.listMessages("org-1", "outsider", "c1"))).to.equal("ok");
    });
  });

  it("rename follows the same rule as reading", async () => {
    expect(await statusOf(ChatSvc.renameConsultation("org-1", "colleague", "c1", "Remedies"))).to.equal("ok");
    expect(await statusOf(ChatSvc.renameConsultation("org-1", "outsider", "c1", "Remedies"))).to.equal(404);
  });

  describe("deleting", () => {
    it("lets the creator delete their own", async () => {
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "creator", "c1"))).to.equal("ok");
      expect(deleted).to.deep.equal(["c1"]);
    });

    it("lets a case editor delete a colleague's", async () => {
      caseEditors.add("editor");
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "editor", "c1"))).to.equal("ok");
    });

    it("refuses a read-only colleague (403) and an outsider (404), deleting nothing", async () => {
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "colleague", "c1"))).to.equal(403);
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "outsider", "c1"))).to.equal(404);
      expect(deleted).to.deep.equal([]);
    });
  });

  describe("listing and creating on a Case", () => {
    it("lists a Case's Consultations only for someone who can open the Case", async () => {
      expect(await statusOf(ChatSvc.listConsultations("org-1", "colleague", "case-1"))).to.equal("ok");
      expect(await statusOf(ChatSvc.listConsultations("org-1", "outsider", "case-1"))).to.equal(404);
      expect(await statusOf(ChatSvc.listConsultations("org-1", "outsider"))).to.equal("ok");
    });

    it("creates on a Case only for someone who can open it, and passes the draft's title through", async () => {
      const created: any = await ChatSvc.createConsultation("org-1", "colleague", "Remedies", "case-1");
      expect(created).to.include({ userId: "colleague", title: "Remedies", caseId: "case-1" });
      expect(await statusOf(ChatSvc.createConsultation("org-1", "outsider", undefined, "case-1"))).to.equal(404);
    });
  });
});
