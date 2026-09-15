/** Deleting a READY, case-scoped document is one of the three corpus-change triggers for the
 * automatic caseRefresh pipeline (#75) — it must schedule a refresh attributed to the real
 * deleting user (req.user.userId), never a synthetic/system actor, since CaseRefreshSvc's
 * downstream calls and audit rows all expect one.
 *
 * No live Postgres: DocumentRepo and the dynamically-imported case-post-extraction module are
 * monkeypatched on their CommonJS module objects, same idiom as the rest of this suite.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import * as CasePostExtraction from "../src/queues/case-post-extraction";

describe("DocumentSvc.delete — schedules the automatic refresh trigger", () => {
  const originals = {
    findById: DocumentRepo.findById,
    delete: DocumentRepo.delete,
    schedule: CasePostExtraction.scheduleCasePostExtraction,
  };
  let scheduled: { caseId: string; userId: string }[];

  beforeEach(() => {
    scheduled = [];
    (CasePostExtraction as any).scheduleCasePostExtraction = (caseId: string, userId: string) => {
      scheduled.push({ caseId, userId });
    };
    (DocumentRepo as any).delete = async () => true;
  });

  afterEach(() => {
    (DocumentRepo as any).findById = originals.findById;
    (DocumentRepo as any).delete = originals.delete;
    (CasePostExtraction as any).scheduleCasePostExtraction = originals.schedule;
  });

  it("schedules a refresh, attributed to the deleting user, when a READY case document is removed", async () => {
    (DocumentRepo as any).findById = async () => ({ id: "doc-1", caseId: "case-1", ragStatus: "READY" });

    await DocumentSvc.delete("doc-1", "org-1", "user-1");

    expect(scheduled).to.deep.equal([{ caseId: "case-1", userId: "user-1" }]);
  });

  it("does not schedule a refresh for a document that was never READY (nothing in the corpus changed)", async () => {
    (DocumentRepo as any).findById = async () => ({ id: "doc-1", caseId: "case-1", ragStatus: "PENDING" });

    await DocumentSvc.delete("doc-1", "org-1", "user-1");

    expect(scheduled).to.have.length(0);
  });

  it("does not schedule a refresh for a document with no case (nothing case-level to refresh)", async () => {
    (DocumentRepo as any).findById = async () => ({ id: "doc-1", caseId: null, ragStatus: "READY" });

    await DocumentSvc.delete("doc-1", "org-1", "user-1");

    expect(scheduled).to.have.length(0);
  });

  it("404s without deleting or scheduling anything when the document doesn't exist", async () => {
    (DocumentRepo as any).findById = async () => null;
    let deleteCalled = false;
    (DocumentRepo as any).delete = async () => {
      deleteCalled = true;
      return false;
    };

    let threw: any;
    try {
      await DocumentSvc.delete("doc-1", "org-1", "user-1");
    } catch (e) {
      threw = e;
    }

    expect(threw?.statusCode).to.equal(404);
    expect(deleteCalled).to.equal(false);
    expect(scheduled).to.have.length(0);
  });
});
