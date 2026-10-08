/** Who may use a Consultation. A Case's Consultations are shared with everyone who can open the
 * Case; archiving, restoring or deleting someone else's needs edit rights on the Case, and a
 * permanent delete only works on an archived one; a standalone (case-less) Consultation is
 * private to its creator — no one else in the organization, whatever their role, can reach it,
 * and it can't be shared by invite. ChatRepo, ParticipantRepo,
 * CaseAccess and CaseSvc are monkeypatched on their module objects, same idiom as
 * test/chat-list-messages-download-link.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ChatSvc from "../src/services/chat.service";
import CaseSvc from "../src/services/case.service";
import ChatRepo from "../src/repositories/chat.repository";
import ParticipantRepo from "../src/repositories/participant.repository";
import InviteRepo from "../src/repositories/invite.repository";
import InviteSvc from "../src/services/invite.service";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

const CASE_CONSULTATION = { id: "c1", organizationId: "org-1", userId: "creator", caseId: "case-1", status: "ACTIVE" };
const STANDALONE_CONSULTATION = { ...CASE_CONSULTATION, caseId: null };

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
    requestConsultationDeletion: ChatRepo.requestConsultationDeletion,
    setConsultationStatus: ChatRepo.setConsultationStatus,
    findConsultationWithCase: ChatRepo.findConsultationWithCase,
    hasPendingTurn: ChatRepo.hasPendingTurn,
    updateConsultation: ChatRepo.updateConsultation,
    listConsultations: ChatRepo.listConsultations,
    createConsultation: ChatRepo.createConsultation,
    participantExists: ParticipantRepo.exists,
    participantAdd: ParticipantRepo.add,
    inviteCreate: InviteRepo.create,
    inviteFindById: InviteRepo.findById,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    assertCanEdit: CaseAccess.assertCanEdit,
    getCaseById: CaseSvc.getById,
  };
  let consultation: any;
  let participants: Set<string>;
  let caseReaders: Set<string>;
  let caseEditors: Set<string>;
  let deleted: string[];
  let statusChanges: [string, string][];
  let generating: boolean;
  let listedWith: unknown[];
  let invites: Map<string, { id: string; consultationId: string; createdBy: string; expiresAt: Date }>;

  beforeEach(() => {
    consultation = { ...CASE_CONSULTATION };
    participants = new Set();
    caseReaders = new Set(["colleague"]);
    caseEditors = new Set();
    deleted = [];
    statusChanges = [];
    generating = false;
    listedWith = [];
    invites = new Map();
    (ChatRepo as any).hasPendingTurn = async () => generating;
    (ChatRepo as any).findConsultationById = async () => consultation;
    (ChatRepo as any).findConsultationWithCase = async () => consultation;
    (ChatRepo as any).listMessagesByConsultation = async () => [];
    (ChatRepo as any).requestConsultationDeletion = async (id: string, requestedAt: Date) => {
      deleted.push(id);
      consultation = { ...consultation, status: "FOR_DELETION", deletionRequestedAt: requestedAt };
      return consultation;
    };
    (ChatRepo as any).setConsultationStatus = async (id: string, status: string) => {
      statusChanges.push([id, status]);
      consultation = { ...consultation, status };
      return consultation;
    };
    (ChatRepo as any).updateConsultation = async (id: string, title: string) => ({ id, title });
    (ChatRepo as any).listConsultations = async (...args: unknown[]) => {
      listedWith = args;
      return [];
    };
    (ChatRepo as any).createConsultation = async (_o: string, userId: string, title?: string, caseId?: string) => ({ id: "new", userId, title, caseId });
    (ParticipantRepo as any).exists = async (_c: string, userId: string) => participants.has(userId);
    (ParticipantRepo as any).add = async (_c: string, userId: string) => participants.add(userId);
    (InviteRepo as any).create = async (consultationId: string, createdBy: string, expiresAt: Date) => {
      const invite = { id: `inv-${invites.size + 1}`, consultationId, createdBy, expiresAt };
      invites.set(invite.id, invite);
      return invite;
    };
    (InviteRepo as any).findById = async (id: string) => invites.get(id) ?? null;
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
      requestConsultationDeletion: originals.requestConsultationDeletion,
      setConsultationStatus: originals.setConsultationStatus,
      findConsultationWithCase: originals.findConsultationWithCase,
      hasPendingTurn: originals.hasPendingTurn,
      updateConsultation: originals.updateConsultation,
      listConsultations: originals.listConsultations,
      createConsultation: originals.createConsultation,
    });
    (ParticipantRepo as any).exists = originals.participantExists;
    (ParticipantRepo as any).add = originals.participantAdd;
    (InviteRepo as any).create = originals.inviteCreate;
    (InviteRepo as any).findById = originals.inviteFindById;
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
  });

  describe("a standalone Consultation is private to its creator", () => {
    beforeEach(() => {
      consultation = { ...STANDALONE_CONSULTATION };
    });

    it("lets the creator read and rename it", async () => {
      expect(await statusOf(ChatSvc.listMessages("org-1", "creator", "c1"))).to.equal("ok");
      expect(await statusOf(ChatSvc.renameConsultation("org-1", "creator", "c1", "Remedies"))).to.equal("ok");
    });

    it("404s for every other org member — whatever their role — on every action", async () => {
      // Roles don't enter into it: an Owner or Admin is just another user here.
      for (const other of ["colleague", "org-admin", "org-owner"]) {
        const attempts: Promise<unknown>[] = [
          ChatSvc.listMessages("org-1", other, "c1"),
          ChatSvc.renameConsultation("org-1", other, "c1", "Remedies"),
          ChatSvc.archiveConsultation("org-1", other, "c1"),
          ChatSvc.unarchiveConsultation("org-1", other, "c1"),
          ChatSvc.deleteConsultation("org-1", other, "c1"),
          ChatSvc.deleteMessage("org-1", other, "c1", "m1"),
          ChatSvc.enqueueChatGeneration("org-1", "PH" as any, other, "c1", "session", "hello"),
          ChatSvc.cancelChatGeneration("org-1", other, "c1", "m1"),
          ChatSvc.getRelatedCases("org-1", other, "PH" as any, "c1"),
          ChatSvc.startAudioOverviewAudio("org-1", other, "c1", "m1"),
          ChatSvc.pollAudioOverviewAudio("org-1", other, "c1", "m1"),
          ChatSvc.assertConsultationAccess("org-1", other, "c1"),
        ];
        for (const attempt of attempts) expect(await statusOf(attempt)).to.equal(404);
      }
      expect(statusChanges).to.deep.equal([]);
      expect(deleted).to.deep.equal([]);
    });

    it("gives a leftover participant (from before sharing was Case-only) no access", async () => {
      participants.add("guest");
      expect(await statusOf(ChatSvc.listMessages("org-1", "guest", "c1"))).to.equal(404);
    });

    it("lists only the caller's own standalone Consultations", async () => {
      await ChatSvc.listConsultations("org-1", "colleague");
      expect(listedWith).to.deep.equal(["org-1", undefined, "ACTIVE", "colleague"]);
      await ChatSvc.listConsultations("org-1", "colleague", undefined, "ARCHIVED");
      expect(listedWith).to.deep.equal(["org-1", undefined, "ARCHIVED", "colleague"]);
    });

    it("can't be shared: creating an invite is refused (400)", async () => {
      expect(await statusOf(InviteSvc.create("creator", "c1"))).to.equal(400);
      expect(invites.size).to.equal(0);
    });

    it("refuses an invite created before sharing was Case-only (400), adding no participant", async () => {
      invites.set("old", { id: "old", consultationId: "c1", createdBy: "creator", expiresAt: new Date(Date.now() + 60_000) });
      expect(await statusOf(InviteSvc.accept("guest", "old"))).to.equal(400);
      expect(participants.has("guest")).to.equal(false);
    });
  });

  describe("sharing a case-linked Consultation by invite", () => {
    it("lets the creator invite, and the invitee accept", async () => {
      const invite: any = await InviteSvc.create("creator", "c1");
      expect(await statusOf(InviteSvc.accept("guest", invite.id))).to.equal("ok");
      expect(participants.has("guest")).to.equal(true);
    });
  });

  it("rename follows the same rule as reading", async () => {
    expect(await statusOf(ChatSvc.renameConsultation("org-1", "colleague", "c1", "Remedies"))).to.equal("ok");
    expect(await statusOf(ChatSvc.renameConsultation("org-1", "outsider", "c1", "Remedies"))).to.equal(404);
  });

  describe("archiving and restoring", () => {
    it("lets the creator archive their own and restore it", async () => {
      expect(await statusOf(ChatSvc.archiveConsultation("org-1", "creator", "c1"))).to.equal("ok");
      expect(await statusOf(ChatSvc.unarchiveConsultation("org-1", "creator", "c1"))).to.equal("ok");
      expect(statusChanges).to.deep.equal([["c1", "ARCHIVED"], ["c1", "ACTIVE"]]);
    });

    it("lets a case editor archive a colleague's", async () => {
      caseEditors.add("editor");
      expect(await statusOf(ChatSvc.archiveConsultation("org-1", "editor", "c1"))).to.equal("ok");
    });

    it("refuses a read-only colleague (403) and an outsider (404), changing nothing", async () => {
      expect(await statusOf(ChatSvc.archiveConsultation("org-1", "colleague", "c1"))).to.equal(403);
      expect(await statusOf(ChatSvc.archiveConsultation("org-1", "outsider", "c1"))).to.equal(404);
      expect(await statusOf(ChatSvc.unarchiveConsultation("org-1", "colleague", "c1"))).to.equal(403);
      expect(statusChanges).to.deep.equal([]);
    });

    it("refuses to archive while a reply is still generating (409 REPLY_GENERATING)", async () => {
      generating = true;
      const err = await ChatSvc.archiveConsultation("org-1", "creator", "c1").catch((e) => e);
      expect(err).to.be.instanceOf(HttpError);
      expect(err.statusCode).to.equal(409);
      expect(err.code).to.equal("REPLY_GENERATING");
      expect(statusChanges).to.deep.equal([]);
    });

    it("takes no new messages while archived", async () => {
      consultation = { ...CASE_CONSULTATION, status: "ARCHIVED" };
      const send = ChatSvc.enqueueChatGeneration("org-1", "PH" as any, "creator", "c1", "session", "hello");
      expect(await statusOf(send)).to.equal(409);
    });
  });

  describe("deleting permanently (scheduled after the grace period)", () => {
    it("refuses a consultation that isn't archived yet (409), deleting nothing", async () => {
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "creator", "c1"))).to.equal(409);
      expect(deleted).to.deep.equal([]);
    });

    it("lets the creator schedule their own once archived, 30 days out", async () => {
      consultation = { ...CASE_CONSULTATION, status: "ARCHIVED" };
      const before = Date.now();
      const { deletionScheduledFor } = await ChatSvc.deleteConsultation("org-1", "creator", "c1");
      expect(deleted).to.deep.equal(["c1"]);
      const days = (deletionScheduledFor.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(days).to.be.closeTo(30, 0.01);
      expect(consultation.status).to.equal("FOR_DELETION");
    });

    it("refuses scheduling it twice (409)", async () => {
      consultation = { ...CASE_CONSULTATION, status: "FOR_DELETION", deletionRequestedAt: new Date() };
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "creator", "c1"))).to.equal(409);
      expect(deleted).to.deep.equal([]);
    });

    it("won't re-archive one scheduled for deletion (that would cancel it), but restores it", async () => {
      consultation = { ...CASE_CONSULTATION, status: "FOR_DELETION", deletionRequestedAt: new Date() };
      expect(await statusOf(ChatSvc.archiveConsultation("org-1", "creator", "c1"))).to.equal(409);
      expect(await statusOf(ChatSvc.unarchiveConsultation("org-1", "creator", "c1"))).to.equal("ok");
      expect(statusChanges).to.deep.equal([["c1", "ACTIVE"]]);
    });

    it("takes no new messages while scheduled for deletion", async () => {
      consultation = { ...CASE_CONSULTATION, status: "FOR_DELETION", deletionRequestedAt: new Date() };
      const send = ChatSvc.enqueueChatGeneration("org-1", "PH" as any, "creator", "c1", "session", "hello");
      expect(await statusOf(send)).to.equal(409);
    });

    it("lets a case editor delete a colleague's archived one", async () => {
      consultation = { ...CASE_CONSULTATION, status: "ARCHIVED" };
      caseEditors.add("editor");
      expect(await statusOf(ChatSvc.deleteConsultation("org-1", "editor", "c1"))).to.equal("ok");
    });

    it("refuses a read-only colleague (403) and an outsider (404), deleting nothing", async () => {
      consultation = { ...CASE_CONSULTATION, status: "ARCHIVED" };
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

    it("lists every Consultation on the Case, not just the caller's own", async () => {
      await ChatSvc.listConsultations("org-1", "colleague", "case-1");
      expect(listedWith).to.deep.equal(["org-1", "case-1", "ACTIVE", undefined]);
    });

    it("creates on a Case only for someone who can open it, and passes the draft's title through", async () => {
      const created: any = await ChatSvc.createConsultation("org-1", "colleague", "Remedies", "case-1");
      expect(created).to.include({ userId: "colleague", title: "Remedies", caseId: "case-1" });
      expect(await statusOf(ChatSvc.createConsultation("org-1", "outsider", undefined, "case-1"))).to.equal(404);
    });
  });
});
