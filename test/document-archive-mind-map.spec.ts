/**
 * Stage 7: archiving/unarchiving an indexed case document schedules the post-upload job, which
 * brings the case mind map back in step (archived documents are left out of the map — see
 * mindMapDocumentIds). No DB: repository statics are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import * as postExtraction from "../src/queues/case-post-extraction";

describe("Document archive → case mind map resync", () => {
  const originals = {
    setStatus: DocumentRepo.setStatus,
    writeAudit: OrganizationRepo.writeAudit,
    invalidate: DocumentChunkSvc.invalidateCacheForDocument,
    schedule: postExtraction.scheduleCasePostExtraction,
  };
  let scheduled: { caseId: string; userId: string }[];
  let doc: Record<string, unknown>;

  beforeEach(() => {
    scheduled = [];
    doc = { id: "doc-1", caseId: "case-1", ragStatus: "READY", status: "ARCHIVED", name: "Note.pdf", file: null };
    (DocumentRepo as any).setStatus = async (_id: string, _org: string, status: string) => ({ ...doc, status });
    (OrganizationRepo as any).writeAudit = async () => ({});
    (DocumentChunkSvc as any).invalidateCacheForDocument = async () => {};
    (postExtraction as any).scheduleCasePostExtraction = (caseId: string, userId: string) => scheduled.push({ caseId, userId });
  });

  afterEach(() => {
    (DocumentRepo as any).setStatus = originals.setStatus;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (DocumentChunkSvc as any).invalidateCacheForDocument = originals.invalidate;
    (postExtraction as any).scheduleCasePostExtraction = originals.schedule;
  });

  it("archive and unarchive of an indexed case document both schedule the resync", async () => {
    await DocumentSvc.archive("doc-1", "org-1", "user-1").catch(() => {});
    await DocumentSvc.unarchive("doc-1", "org-1", "user-1").catch(() => {});
    expect(scheduled).to.deep.equal([
      { caseId: "case-1", userId: "user-1" },
      { caseId: "case-1", userId: "user-1" },
    ]);
  });

  it("doesn't for a document that isn't indexed yet, or isn't on a case", async () => {
    doc = { ...doc, ragStatus: "PENDING" };
    await DocumentSvc.archive("doc-1", "org-1", "user-1").catch(() => {});
    doc = { ...doc, ragStatus: "READY", caseId: null };
    await DocumentSvc.archive("doc-1", "org-1", "user-1").catch(() => {});
    expect(scheduled).to.deep.equal([]);
  });
});
