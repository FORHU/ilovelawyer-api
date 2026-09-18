/** A Case's own archive/delete must cascade into its documents (ticket: "Archive Documents When
 * a Case Is Archived; Delete document when a case is deleted") — Document.caseId's FK is
 * ON DELETE SET NULL, not CASCADE (see schema), so nothing does this automatically.
 *
 * No live Postgres: CaseRepo/DocumentRepo/DocumentSvc/OrganizationRepo are monkeypatched on
 * their CommonJS module objects, same idiom as document-delete-triggers-refresh.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseSvc from "../src/services/case.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentSvc from "../src/services/document.service";
import OrganizationRepo from "../src/repositories/organization.repository";

describe("CaseSvc.archive — cascades into the case's documents", () => {
  const originals = {
    setStatus: CaseRepo.setStatus,
    writeAudit: OrganizationRepo.writeAudit,
    archiveByCase: DocumentSvc.archiveByCase,
  };
  let archivedFor: { caseId: string; organizationId: string; actorId: string }[];

  beforeEach(() => {
    archivedFor = [];
    (CaseRepo as any).setStatus = async () => ({ id: "case-1", status: "ARCHIVED" });
    (OrganizationRepo as any).writeAudit = async () => {};
    (DocumentSvc as any).archiveByCase = async (caseId: string, organizationId: string, actorId: string) => {
      archivedFor.push({ caseId, organizationId, actorId });
    };
  });

  afterEach(() => {
    (CaseRepo as any).setStatus = originals.setStatus;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (DocumentSvc as any).archiveByCase = originals.archiveByCase;
  });

  it("archives the case's documents after flipping the case's own status", async () => {
    await CaseSvc.archive("case-1", "org-1", "user-1");

    expect(archivedFor).to.deep.equal([{ caseId: "case-1", organizationId: "org-1", actorId: "user-1" }]);
  });

  it("404s without cascading when the case doesn't exist", async () => {
    (CaseRepo as any).setStatus = async () => null;

    let threw: any;
    try {
      await CaseSvc.archive("case-1", "org-1", "user-1");
    } catch (e) {
      threw = e;
    }

    expect(threw?.statusCode).to.equal(404);
    expect(archivedFor).to.have.length(0);
  });
});

describe("DocumentSvc.archiveByCase — loops the single-document archive() over the case", () => {
  const originals = {
    listAllByCase: DocumentRepo.listAllByCase,
    archive: DocumentSvc.archive,
  };
  let archivedIds: string[];

  beforeEach(() => {
    archivedIds = [];
    (DocumentSvc as any).archive = async (id: string) => {
      archivedIds.push(id);
    };
  });

  afterEach(() => {
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (DocumentSvc as any).archive = originals.archive;
  });

  it("archives every still-ACTIVE document, skipping ones already ARCHIVED", async () => {
    (DocumentRepo as any).listAllByCase = async () => [
      { id: "doc-1", status: "ACTIVE" },
      { id: "doc-2", status: "ARCHIVED" },
      { id: "doc-3", status: "ACTIVE" },
    ];

    await DocumentSvc.archiveByCase("case-1", "org-1", "user-1");

    expect(archivedIds).to.deep.equal(["doc-1", "doc-3"]);
  });

  it("does nothing when the case has no documents", async () => {
    (DocumentRepo as any).listAllByCase = async () => [];

    await DocumentSvc.archiveByCase("case-1", "org-1", "user-1");

    expect(archivedIds).to.have.length(0);
  });
});

describe("CaseSvc.delete — cascades into the case's documents", () => {
  const originals = {
    findById: CaseRepo.findById,
    delete: CaseRepo.delete,
    listAllByCase: DocumentRepo.listAllByCase,
    documentDelete: DocumentSvc.delete,
  };
  let deletedDocIds: string[];
  let caseDeleted: boolean;

  beforeEach(() => {
    deletedDocIds = [];
    caseDeleted = false;
    (DocumentRepo as any).listAllByCase = async () => [{ id: "doc-1" }, { id: "doc-2" }];
    (DocumentSvc as any).delete = async (id: string) => {
      deletedDocIds.push(id);
    };
    (CaseRepo as any).delete = async () => {
      caseDeleted = true;
      return true;
    };
  });

  afterEach(() => {
    (CaseRepo as any).findById = originals.findById;
    (CaseRepo as any).delete = originals.delete;
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (DocumentSvc as any).delete = originals.documentDelete;
  });

  it("deletes every document under the case before deleting the case itself", async () => {
    (CaseRepo as any).findById = async () => ({ id: "case-1" });

    await CaseSvc.delete("case-1", "org-1", "user-1");

    expect(deletedDocIds).to.deep.equal(["doc-1", "doc-2"]);
    expect(caseDeleted).to.equal(true);
  });

  it("404s without deleting any document when the case isn't found in this organization", async () => {
    (CaseRepo as any).findById = async () => null;

    let threw: any;
    try {
      await CaseSvc.delete("case-1", "org-1", "user-1");
    } catch (e) {
      threw = e;
    }

    expect(threw?.statusCode).to.equal(404);
    expect(deletedDocIds).to.have.length(0);
    expect(caseDeleted).to.equal(false);
  });
});
