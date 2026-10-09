/** On a confidential case (#346) "Can view" is read-only: a level someone chose for this person,
 * so they can't add to or change the case's material — nor its consultations, which they can read
 * but not ask in (their own included). On an ordinary case it's the default every member has, and
 * changes anyone who can open the case may make — adding a transcription, regenerating or editing
 * the case mind map, chatting — stay open to them. Document uploads to the case are covered in
 * document-upload-case-access.spec.ts.
 *
 * No live Postgres: CaseAccess's lookups, the repos and the generation lock are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import TranscriptionSvc from "../src/services/transcription.service";
import TranscriptionRepo from "../src/repositories/transcription.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import MindMapSvc from "../src/services/mind-map.service";
import MindMapRepo from "../src/repositories/mind-map.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import CaseSvc from "../src/services/case.service";
import ParticipantRepo from "../src/repositories/participant.repository";
import InviteSvc from "../src/services/invite.service";
import InviteRepo from "../src/repositories/invite.repository";
import DocumentSvc from "../src/services/document.service";

const ORG = "org-1";
const USER = "member-1";

/** caseId -> what CaseAccess.loadAccessibleCase would return for USER. */
const CASES: Record<string, { id: string; organizationId: string; confidential: boolean }> = {
  ordinary: { id: "ordinary", organizationId: ORG, confidential: false },
  "confidential-view": { id: "confidential-view", organizationId: ORG, confidential: true },
  "confidential-edit": { id: "confidential-edit", organizationId: ORG, confidential: true },
};
/** caseId -> what CaseAccess.canEdit would answer for USER. */
const EDITABLE = new Set(["confidential-edit"]);

const restore: (() => void)[] = [];
function stub(target: any, key: string, value: unknown) {
  const original = target[key];
  restore.push(() => {
    target[key] = original;
  });
  target[key] = value;
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the change to be refused");
}

describe("#346 — Can view on a confidential case is read-only", () => {
  let writes: string[];

  beforeEach(() => {
    writes = [];
    stub(CaseAccess, "loadAccessibleCase", async (caseId: string) => {
      const found = CASES[caseId];
      if (!found) throw new HttpError("Case not found", 404);
      return found;
    });
    stub(CaseAccess, "canEdit", async (caseId: string) => EDITABLE.has(caseId));
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  describe("CaseAccess.assertCanContribute", () => {
    it("lets anyone who can open an ordinary case through", async () => {
      const record = await CaseAccess.assertCanContribute("ordinary", USER);
      expect(record.id).to.equal("ordinary");
    });

    it("refuses a view-only person on a confidential case with a 403", async () => {
      const err = await rejection(CaseAccess.assertCanContribute("confidential-view", USER));
      expect(err.statusCode).to.equal(403);
    });

    it("lets an edit grant on a confidential case through", async () => {
      const record = await CaseAccess.assertCanContribute("confidential-edit", USER);
      expect(record.id).to.equal("confidential-edit");
    });

    it("still 404s a case the person can't open at all", async () => {
      const err = await rejection(CaseAccess.assertCanContribute("walled", USER));
      expect(err.statusCode).to.equal(404);
    });
  });

  describe("transcriptions", () => {
    /** id -> the transcription's caseId. */
    const ITEMS: Record<string, string | null> = {
      "t-ordinary": "ordinary",
      "t-view": "confidential-view",
      "t-edit": "confidential-edit",
      "t-none": null,
    };

    beforeEach(() => {
      stub(TranscriptionRepo, "findById", async (id: string) =>
        id in ITEMS ? { id, caseId: ITEMS[id], title: "Interview", audioFile: null } : null,
      );
      stub(TranscriptionRepo, "create", async (_org: string, _user: string, data: { caseId?: string | null }) => {
        writes.push(`create:${data.caseId ?? "none"}`);
        return { id: "t-new", ...data };
      });
      stub(TranscriptionRepo, "update", async (id: string) => {
        writes.push(`update:${id}`);
      });
      stub(TranscriptionRepo, "delete", async (id: string) => {
        writes.push(`delete:${id}`);
      });
      stub(SecurityAuditSvc, "record", async () => undefined);
    });

    it("refuses adding one to a confidential case the person can only view", async () => {
      const err = await rejection(TranscriptionSvc.create(ORG, USER, { caseId: "confidential-view" }));
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("still lets anyone who can open an ordinary case add one", async () => {
      await TranscriptionSvc.create(ORG, USER, { caseId: "ordinary" });
      expect(writes).to.deep.equal(["create:ordinary"]);
    });

    it("refuses adding one to a case the person can't open — create never checked before", async () => {
      const err = await rejection(TranscriptionSvc.create(ORG, USER, { caseId: "walled" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses deleting or editing one on a confidential case the person can only view", async () => {
      const del = await rejection(TranscriptionSvc.delete("t-view", ORG, USER));
      expect(del.statusCode).to.equal(403);
      const upd = await rejection(TranscriptionSvc.update("t-view", ORG, USER, { title: "Renamed" }));
      expect(upd.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("refuses moving one onto a confidential case the person can only view", async () => {
      const err = await rejection(TranscriptionSvc.update("t-none", ORG, USER, { caseId: "confidential-view" }));
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("lets an edit grant on a confidential case delete one", async () => {
      await TranscriptionSvc.delete("t-edit", ORG, USER);
      expect(writes).to.deep.equal(["delete:t-edit"]);
    });

    it("still lets a view-only person read one", async () => {
      const item = await TranscriptionSvc.getById("t-view", ORG, USER);
      expect(item.id).to.equal("t-view");
    });
  });

  describe("consultations on the case", () => {
    /** consultationId -> its caseId; USER started all of them. */
    const CONSULTATIONS: Record<string, string> = {
      "c-ordinary": "ordinary",
      "c-view": "confidential-view",
      "c-edit": "confidential-edit",
    };
    const consultation = (id: string) =>
      id in CONSULTATIONS
        ? { id, organizationId: ORG, userId: USER, caseId: CONSULTATIONS[id], status: "ACTIVE", title: "Chat" }
        : null;

    beforeEach(() => {
      stub(ChatRepo, "findConsultationById", async (id: string) => consultation(id));
      stub(ChatRepo, "findConsultationWithCase", async (id: string) => consultation(id));
      stub(ChatRepo, "createConsultation", async (_org: string, _user: string, _title?: string, caseId?: string) => {
        writes.push(`consultation:create:${caseId}`);
        return { id: "c-new", caseId };
      });
      stub(ChatRepo, "updateConsultation", async (id: string) => {
        writes.push(`consultation:rename:${id}`);
        return consultation(id);
      });
      stub(CaseSvc, "getById", async (id: string) => CaseAccess.loadAccessibleCase(id, USER));
      stub(CaseAccess, "isConfidential", async (caseId: string) => !!CASES[caseId]?.confidential);
      stub(ParticipantRepo, "exists", async () => false);
      stub(InviteRepo, "create", async () => {
        writes.push("invite:create");
        return { id: "invite-1" };
      });
    });

    it("still lets a view-only person open one on a confidential case — reading stays", async () => {
      const found = await ChatSvc.assertConsultationAccess(ORG, USER, "c-view");
      expect(found.id).to.equal("c-view");
    });

    it("refuses asking in one, their own included, with a 403", async () => {
      const err = await rejection(
        ChatSvc.enqueueChatGeneration(ORG, "UK" as never, USER, "c-view", "session-1", "What are the risks?"),
      );
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("refuses starting one on the case", async () => {
      const err = await rejection(ChatSvc.createConsultation(ORG, USER, "New chat", "confidential-view"));
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("refuses renaming one, or sharing it", async () => {
      const rename = await rejection(ChatSvc.renameConsultation(ORG, USER, "c-view", "Renamed"));
      expect(rename.statusCode).to.equal(403);
      const invite = await rejection(InviteSvc.create(USER, "c-view"));
      expect(invite.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("refuses changing its mind map", async () => {
      const err = await rejection(
        MindMapSvc.expandNode({ organizationId: ORG, userId: USER, consultationId: "c-view", nodeId: "n1" }),
      );
      expect(err.statusCode).to.equal(403);
    });

    it("refuses attaching a document to it, though no case is named", async () => {
      const err = await rejection(DocumentSvc.presign(ORG, USER, "brief.pdf", "application/pdf", undefined, "c-view"));
      expect(err.statusCode).to.equal(403);
    });

    it("lets an edit grant on a confidential case start and rename one", async () => {
      await ChatSvc.createConsultation(ORG, USER, "New chat", "confidential-edit");
      await ChatSvc.renameConsultation(ORG, USER, "c-edit", "Renamed");
      expect(writes).to.deep.equal(["consultation:create:confidential-edit", "consultation:rename:c-edit"]);
    });

    it("leaves an ordinary case alone: anyone who can open it may start and rename one", async () => {
      await ChatSvc.createConsultation(ORG, USER, "New chat", "ordinary");
      await ChatSvc.renameConsultation(ORG, USER, "c-ordinary", "Renamed");
      expect(writes).to.deep.equal(["consultation:create:ordinary", "consultation:rename:c-ordinary"]);
    });
  });

  describe("the case mind map", () => {
    beforeEach(() => {
      stub(AiGenerationLockSvc, "assertAnalysisIdle", async () => undefined);
      stub(AiGenerationLockSvc, "begin", async (caseId: string) => {
        writes.push(`begin:${caseId}`);
      });
      stub(MindMapRepo, "findCaseMap", async (caseId: string) => ({ id: `map-${caseId}`, data: {}, version: 1, retiredAt: null }));
      stub(MindMapRepo, "caseMapHasUserChanges", async () => false);
    });

    it("refuses Regenerate for a view-only person on a confidential case, claiming no job", async () => {
      const err = await rejection(CaseMindMapSvc.beginQueuedGenerate("confidential-view", USER));
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("still lets anyone who can open an ordinary case regenerate it", async () => {
      await CaseMindMapSvc.beginQueuedGenerate("ordinary", USER);
      expect(writes).to.deep.equal(["begin:ordinary"]);
    });

    it("refuses expanding, editing or undoing on it for a view-only person on a confidential case", async () => {
      const t = { organizationId: ORG, userId: USER, caseId: "confidential-view" };
      const expand = await rejection(MindMapSvc.expandCaseNode({ ...t, nodeId: "n1" }));
      expect(expand.statusCode).to.equal(403);
      const edit = await rejection(MindMapSvc.editCaseNode({ ...t, edit: { op: "delete", nodeId: "n1" } }));
      expect(edit.statusCode).to.equal(403);
      const undo = await rejection(MindMapSvc.revertCaseMap(t));
      expect(undo.statusCode).to.equal(403);
    });

    it("gets past the access check on an ordinary case (undo then finds nothing to undo)", async () => {
      const err = await rejection(MindMapSvc.revertCaseMap({ organizationId: ORG, userId: USER, caseId: "ordinary" }));
      expect(err.statusCode).to.equal(409);
    });
  });
});
