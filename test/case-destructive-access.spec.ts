/** #345: a case's own update/delete/archive/unarchive — and the same operations on a document
 * attached to a case — take the same bar as editing anything inside the case:
 * CaseAccess.assertCanEdit (org OWNER/ADMIN, or an explicit EDIT/ADMIN grant). Before this, any
 * accepted org member could delete a whole case and its documents while being unable to edit
 * one finding inside it. Documents with no case stay organization-scoped.
 *
 * No live Postgres: CaseAccess and the repos are monkeypatched on their CommonJS module objects,
 * same idiom as case-archive-delete-cascades-documents.spec.ts. The access rule itself lives in
 * CaseAccess.assertCanEdit's query; what's under test here is that every destructive path goes
 * through it, with the acting user, before anything is written.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseSvc from "../src/services/case.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import FilesRepo from "../src/repositories/files.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import * as CasePostExtraction from "../src/queues/case-post-extraction";

const EDITOR = "editor-1";
const MEMBER = "member-1";

/** caseId -> organizationId for every case the stubbed assertCanEdit knows about. */
const CASE_ORGS: Record<string, string> = { "case-1": "org-1", "case-2": "org-1", "case-other-org": "org-2" };

describe("#345 — destructive case and case-document operations require CaseAccess.assertCanEdit", () => {
  const originals = {
    assertCanEdit: CaseAccess.assertCanEdit,
    caseFindById: CaseRepo.findById,
    caseUpdate: CaseRepo.update,
    caseDelete: CaseRepo.delete,
    caseSetStatus: CaseRepo.setStatus,
    clearFindingsFormatVersion: CaseRepo.clearFindingsFormatVersion,
    docFindById: DocumentRepo.findById,
    docUpdate: DocumentRepo.update,
    docDelete: DocumentRepo.delete,
    docSetStatus: DocumentRepo.setStatus,
    listAllByCase: DocumentRepo.listAllByCase,
    invalidate: DocumentChunkSvc.invalidateCacheForDocument,
    markForDeletion: FilesRepo.markForDeletionIfOrphaned,
    detachDocument: CaseTimelineRepo.detachDocument,
    writeAudit: OrganizationRepo.writeAudit,
    schedule: CasePostExtraction.scheduleCasePostExtraction,
  };

  /** Who may edit which case — `${caseId}:${userId}`. */
  let editable: Set<string>;
  let accessChecks: { caseId: string; userId: string }[];
  /** Every write that reached a repository, in order. */
  let writes: string[];
  let documents: Record<string, { id: string; caseId: string | null; ragStatus: string; status: string; fileId: string | null }>;

  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    throw new Error("expected the call to be refused");
  }

  beforeEach(() => {
    editable = new Set(["case-1:" + EDITOR, "case-2:" + EDITOR, "case-other-org:" + EDITOR]);
    accessChecks = [];
    writes = [];
    documents = {
      "doc-case": { id: "doc-case", caseId: "case-1", ragStatus: "PENDING", status: "ACTIVE", fileId: null },
      "doc-loose": { id: "doc-loose", caseId: null, ragStatus: "PENDING", status: "ACTIVE", fileId: null },
    };

    (CaseAccess as any).assertCanEdit = async (caseId: string, userId: string) => {
      accessChecks.push({ caseId, userId });
      if (!editable.has(`${caseId}:${userId}`)) throw new HttpError("Case not found or not editable", 404);
      return { id: caseId, userId: "creator", caseName: "Case", organizationId: CASE_ORGS[caseId] ?? null };
    };

    (CaseRepo as any).findById = async (id: string, organizationId: string) =>
      CASE_ORGS[id] === organizationId ? { id, organizationId, clientSide: null } : null;
    (CaseRepo as any).update = async (id: string) => {
      writes.push(`case.update:${id}`);
      return true;
    };
    (CaseRepo as any).delete = async (id: string) => {
      writes.push(`case.delete:${id}`);
      return true;
    };
    (CaseRepo as any).setStatus = async (id: string, organizationId: string, status: string) => {
      if (CASE_ORGS[id] !== organizationId) return null;
      writes.push(`case.${status}:${id}`);
      return { id, status };
    };
    (CaseRepo as any).clearFindingsFormatVersion = async () => {};

    (DocumentRepo as any).findById = async (id: string) => documents[id] ?? null;
    (DocumentRepo as any).update = async (id: string) => {
      writes.push(`doc.update:${id}`);
      return true;
    };
    (DocumentRepo as any).delete = async (id: string) => {
      writes.push(`doc.delete:${id}`);
      return true;
    };
    (DocumentRepo as any).setStatus = async (id: string, _org: string, status: string) => {
      writes.push(`doc.${status}:${id}`);
      return documents[id] ? { ...documents[id], status, file: null } : null;
    };
    (DocumentRepo as any).listAllByCase = async (caseId: string) => Object.values(documents).filter((d) => d.caseId === caseId);
    (DocumentChunkSvc as any).invalidateCacheForDocument = async () => {};
    (FilesRepo as any).markForDeletionIfOrphaned = async () => {};
    (CaseTimelineRepo as any).detachDocument = async () => ({ count: 0 });
    (OrganizationRepo as any).writeAudit = async (entry: { action: string }) => {
      writes.push(`audit:${entry.action}`);
    };
    (CasePostExtraction as any).scheduleCasePostExtraction = () => {};
  });

  afterEach(() => {
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (CaseRepo as any).findById = originals.caseFindById;
    (CaseRepo as any).update = originals.caseUpdate;
    (CaseRepo as any).delete = originals.caseDelete;
    (CaseRepo as any).setStatus = originals.caseSetStatus;
    (CaseRepo as any).clearFindingsFormatVersion = originals.clearFindingsFormatVersion;
    (DocumentRepo as any).findById = originals.docFindById;
    (DocumentRepo as any).update = originals.docUpdate;
    (DocumentRepo as any).delete = originals.docDelete;
    (DocumentRepo as any).setStatus = originals.docSetStatus;
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (DocumentChunkSvc as any).invalidateCacheForDocument = originals.invalidate;
    (FilesRepo as any).markForDeletionIfOrphaned = originals.markForDeletion;
    (CaseTimelineRepo as any).detachDocument = originals.detachDocument;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (CasePostExtraction as any).scheduleCasePostExtraction = originals.schedule;
  });

  describe("CaseSvc", () => {
    it("update: refuses a plain member before anything is written", async () => {
      const err = await rejection(CaseSvc.update("case-1", "org-1", MEMBER, { caseName: "Renamed" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("update: lets an editor through, checking access as the acting user", async () => {
      await CaseSvc.update("case-1", "org-1", EDITOR, { caseName: "Renamed" });
      expect(accessChecks).to.deep.include({ caseId: "case-1", userId: EDITOR });
      expect(writes).to.deep.equal(["case.update:case-1"]);
    });

    it("delete: refuses a plain member without touching the case or its documents", async () => {
      const err = await rejection(CaseSvc.delete("case-1", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("delete: an editor deletes the case's documents, then the case", async () => {
      await CaseSvc.delete("case-1", "org-1", EDITOR);
      expect(writes).to.deep.equal(["doc.delete:doc-case", "audit:document.delete", "case.delete:case-1"]);
    });

    it("archive: refuses a plain member before the status flip, the audit row or the cascade", async () => {
      const err = await rejection(CaseSvc.archive("case-1", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("unarchive: refuses a plain member before the status flip, the audit row or the cascade", async () => {
      const err = await rejection(CaseSvc.unarchive("case-1", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("archive: still 404s for an editor when the case isn't in the active organization", async () => {
      const err = await rejection(CaseSvc.archive("case-other-org", "org-1", EDITOR));
      expect(err.statusCode).to.equal(404);
    });

    it("deleteMany: authorizes per id — the editable case goes, the other lands in failed", async () => {
      editable.delete("case-2:" + EDITOR);
      const result = await CaseSvc.deleteMany(["case-1", "case-2"], "org-1", EDITOR);
      expect(result.succeeded).to.deep.equal(["case-1"]);
      expect(result.failed).to.deep.equal([{ id: "case-2", error: "Case not found or not editable" }]);
      expect(writes).to.not.include("case.delete:case-2");
    });

    it("archiveMany: authorizes per id — the editable case goes, the other lands in failed", async () => {
      editable.delete("case-2:" + EDITOR);
      const result = await CaseSvc.archiveMany(["case-1", "case-2"], "org-1", EDITOR);
      expect(result.succeeded.map((c: any) => c.id)).to.deep.equal(["case-1"]);
      expect(result.failed.map((f) => f.id)).to.deep.equal(["case-2"]);
      expect(writes).to.not.include("case.ARCHIVED:case-2");
    });

    it("unarchiveMany: authorizes per id", async () => {
      editable.delete("case-2:" + EDITOR);
      const result = await CaseSvc.unarchiveMany(["case-1", "case-2"], "org-1", EDITOR);
      expect(result.succeeded.map((c: any) => c.id)).to.deep.equal(["case-1"]);
      expect(result.failed.map((f) => f.id)).to.deep.equal(["case-2"]);
    });
  });

  describe("DocumentSvc — a document attached to a case", () => {
    it("delete: refuses a plain member without deleting", async () => {
      const err = await rejection(DocumentSvc.delete("doc-case", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("delete: lets an editor of the document's case through", async () => {
      await DocumentSvc.delete("doc-case", "org-1", EDITOR);
      expect(accessChecks).to.deep.include({ caseId: "case-1", userId: EDITOR });
      expect(writes).to.deep.equal(["doc.delete:doc-case", "audit:document.delete"]);
    });

    it("archive: refuses a plain member before the status flip", async () => {
      const err = await rejection(DocumentSvc.archive("doc-case", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("unarchive: refuses a plain member before the status flip", async () => {
      const err = await rejection(DocumentSvc.unarchive("doc-case", "org-1", MEMBER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("update: refuses a plain member (e.g. Mark-as-Exhibit)", async () => {
      const err = await rejection(DocumentSvc.update("doc-case", "org-1", MEMBER, { isExhibit: true }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("update: lets an editor of the document's case through", async () => {
      await DocumentSvc.update("doc-case", "org-1", EDITOR, { isExhibit: true });
      expect(writes).to.deep.equal(["doc.update:doc-case"]);
    });

    it("deleteMany: authorizes per id", async () => {
      documents["doc-case-2"] = { id: "doc-case-2", caseId: "case-2", ragStatus: "PENDING", status: "ACTIVE", fileId: null };
      editable.delete("case-2:" + EDITOR);
      const result = await DocumentSvc.deleteMany(["doc-case", "doc-case-2"], "org-1", EDITOR);
      expect(result.succeeded).to.deep.equal(["doc-case"]);
      expect(result.failed.map((f) => f.id)).to.deep.equal(["doc-case-2"]);
      expect(writes).to.not.include("doc.delete:doc-case-2");
    });
  });

  describe("DocumentSvc — moving a document into a case", () => {
    it("refuses when the actor can't edit the target case", async () => {
      const err = await rejection(DocumentSvc.update("doc-loose", "org-1", MEMBER, { caseId: "case-1" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a target case from another organization, even for someone who can edit it", async () => {
      const err = await rejection(DocumentSvc.update("doc-loose", "org-1", EDITOR, { caseId: "case-other-org" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("checks both the case it leaves and the case it joins", async () => {
      await DocumentSvc.update("doc-case", "org-1", EDITOR, { caseId: "case-2" });
      expect(accessChecks).to.deep.equal([
        { caseId: "case-1", userId: EDITOR },
        { caseId: "case-2", userId: EDITOR },
      ]);
      expect(writes).to.deep.equal(["doc.update:doc-case"]);
    });
  });

  describe("DocumentSvc — a document with no case stays organization-scoped", () => {
    it("delete, archive and update go through without a case access check", async () => {
      await DocumentSvc.archive("doc-loose", "org-1", MEMBER);
      await DocumentSvc.update("doc-loose", "org-1", MEMBER, { name: "Renamed.pdf" });
      await DocumentSvc.delete("doc-loose", "org-1", MEMBER);
      expect(accessChecks).to.deep.equal([]);
      expect(writes).to.deep.equal(["doc.ARCHIVED:doc-loose", "audit:document.archive", "doc.update:doc-loose", "doc.delete:doc-loose", "audit:document.delete"]);
    });
  });
});
