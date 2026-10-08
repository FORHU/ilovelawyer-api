/** ChatSvc.deleteMessage writes a security audit event that names the Case the message belonged
 * to. That line referenced a `consultation` variable that was never loaded, so it failed the
 * TypeScript build (and with it every deploy) and would have thrown on every message delete.
 * Repos and the audit service are monkeypatched on their module objects, same idiom as
 * test/consultation-access.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import ParticipantRepo from "../src/repositories/participant.repository";
import CaseAccess from "../src/utils/case-access";
import SecurityAuditSvc from "../src/services/security-audit.service";

describe("ChatSvc.deleteMessage audit event", () => {
  const originals = {
    findConsultationById: ChatRepo.findConsultationById,
    findMessageById: ChatRepo.findMessageById,
    deleteMessage: ChatRepo.deleteMessage,
    exists: ParticipantRepo.exists,
    isConfidential: CaseAccess.isConfidential,
    record: SecurityAuditSvc.record,
  };
  let consultation: Record<string, unknown>;
  let recorded: Array<Record<string, unknown>>;
  let deletedIds: string[];

  beforeEach(() => {
    consultation = { id: "c1", organizationId: "org-1", userId: "creator", caseId: "case-1", status: "ACTIVE" };
    recorded = [];
    deletedIds = [];
    (ChatRepo as any).findConsultationById = async () => consultation;
    (ChatRepo as any).findMessageById = async (id: string) => ({ id, consultationId: "c1", role: "USER" });
    (ChatRepo as any).deleteMessage = async (id: string) => {
      deletedIds.push(id);
      return { id };
    };
    (ParticipantRepo as any).exists = async () => false;
    (CaseAccess as any).isConfidential = async () => false;
    (SecurityAuditSvc as any).record = async (input: Record<string, unknown>) => {
      recorded.push(input);
    };
  });

  afterEach(() => {
    (ChatRepo as any).findConsultationById = originals.findConsultationById;
    (ChatRepo as any).findMessageById = originals.findMessageById;
    (ChatRepo as any).deleteMessage = originals.deleteMessage;
    (ParticipantRepo as any).exists = originals.exists;
    (CaseAccess as any).isConfidential = originals.isConfidential;
    (SecurityAuditSvc as any).record = originals.record;
  });

  it("deletes the message and records which Case it was on", async () => {
    await ChatSvc.deleteMessage("org-1", "creator", "c1", "m1");

    expect(deletedIds).to.deep.equal(["m1"]);
    expect(recorded).to.have.length(1);
    expect(recorded[0]).to.deep.include({
      action: "consultation.message_deleted",
      organizationId: "org-1",
      targetType: "message",
      targetId: "m1",
      caseId: "case-1",
    });
    expect(recorded[0]!.payload).to.deep.equal({ consultationId: "c1", role: "USER" });
  });

  it("records no Case for a standalone consultation", async () => {
    consultation = { ...consultation, caseId: null };
    await ChatSvc.deleteMessage("org-1", "creator", "c1", "m1");

    expect(recorded[0]!.caseId).to.equal(null);
  });
});
