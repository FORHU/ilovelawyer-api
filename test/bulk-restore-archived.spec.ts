/** "Select All" + Mass Restore for Archived Files and Cases:
 *  - CaseSvc.unarchive now cascades into the case's documents (symmetric with archive() —
 *    see case-archive-delete-cascades-documents.spec.ts for the archive-side cascade).
 *  - DocumentSvc.unarchiveMany / CaseSvc.unarchiveMany fan a bulk restore out over the existing
 *    single-item unarchive() with allSettled, so one bad id in a "Select All" batch doesn't sink
 *    the rest.
 *
 * No live Postgres: repos/services are monkeypatched on their CommonJS module objects, same idiom
 * as case-archive-delete-cascades-documents.spec.ts / document-delete-triggers-refresh.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseSvc from "../src/services/case.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentSvc from "../src/services/document.service";
import OrganizationRepo from "../src/repositories/organization.repository";

describe("CaseSvc.unarchive — cascades into the case's documents", () => {
  const originals = {
    setStatus: CaseRepo.setStatus,
    writeAudit: OrganizationRepo.writeAudit,
    unarchiveByCase: DocumentSvc.unarchiveByCase,
  };
  let restoredFor: { caseId: string; organizationId: string; actorId: string }[];

  beforeEach(() => {
    restoredFor = [];
    (CaseRepo as any).setStatus = async () => ({ id: "case-1", status: "ACTIVE" });
    (OrganizationRepo as any).writeAudit = async () => {};
    (DocumentSvc as any).unarchiveByCase = async (caseId: string, organizationId: string, actorId: string) => {
      restoredFor.push({ caseId, organizationId, actorId });
    };
  });

  afterEach(() => {
    (CaseRepo as any).setStatus = originals.setStatus;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (DocumentSvc as any).unarchiveByCase = originals.unarchiveByCase;
  });

  it("restores the case's documents after flipping the case's own status", async () => {
    await CaseSvc.unarchive("case-1", "org-1", "user-1");

    expect(restoredFor).to.deep.equal([{ caseId: "case-1", organizationId: "org-1", actorId: "user-1" }]);
  });

  it("404s without cascading when the case doesn't exist", async () => {
    (CaseRepo as any).setStatus = async () => null;

    let threw: any;
    try {
      await CaseSvc.unarchive("case-1", "org-1", "user-1");
    } catch (e) {
      threw = e;
    }

    expect(threw?.statusCode).to.equal(404);
    expect(restoredFor).to.have.length(0);
  });
});

describe("DocumentSvc.unarchiveByCase — loops the single-document unarchive() over the case", () => {
  const originals = {
    listAllByCase: DocumentRepo.listAllByCase,
    unarchive: DocumentSvc.unarchive,
  };
  let restoredIds: string[];

  beforeEach(() => {
    restoredIds = [];
    (DocumentSvc as any).unarchive = async (id: string) => {
      restoredIds.push(id);
    };
  });

  afterEach(() => {
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (DocumentSvc as any).unarchive = originals.unarchive;
  });

  it("restores every still-ARCHIVED document, skipping ones already ACTIVE", async () => {
    (DocumentRepo as any).listAllByCase = async () => [
      { id: "doc-1", status: "ARCHIVED" },
      { id: "doc-2", status: "ACTIVE" },
      { id: "doc-3", status: "ARCHIVED" },
    ];

    await DocumentSvc.unarchiveByCase("case-1", "org-1", "user-1");

    expect(restoredIds).to.deep.equal(["doc-1", "doc-3"]);
  });

  it("does nothing when the case has no documents", async () => {
    (DocumentRepo as any).listAllByCase = async () => [];

    await DocumentSvc.unarchiveByCase("case-1", "org-1", "user-1");

    expect(restoredIds).to.have.length(0);
  });
});

describe("DocumentSvc.unarchiveMany — bulk restore for Select All in the Archived documents view", () => {
  const originals = { unarchive: DocumentSvc.unarchive };

  afterEach(() => {
    (DocumentSvc as any).unarchive = originals.unarchive;
  });

  it("restores every id and reports nothing failed", async () => {
    (DocumentSvc as any).unarchive = async (id: string) => ({ id, status: "ACTIVE" });

    const result = await DocumentSvc.unarchiveMany(["doc-1", "doc-2"], "org-1", "user-1");

    expect(result.succeeded).to.deep.equal([
      { id: "doc-1", status: "ACTIVE" },
      { id: "doc-2", status: "ACTIVE" },
    ]);
    expect(result.failed).to.have.length(0);
  });

  it("keeps the rest of the batch when one id fails", async () => {
    (DocumentSvc as any).unarchive = async (id: string) => {
      if (id === "doc-2") throw new Error("Document not found");
      return { id, status: "ACTIVE" };
    };

    const result = await DocumentSvc.unarchiveMany(["doc-1", "doc-2", "doc-3"], "org-1", "user-1");

    expect(result.succeeded.map((d: any) => d.id)).to.deep.equal(["doc-1", "doc-3"]);
    expect(result.failed).to.deep.equal([{ id: "doc-2", error: "Document not found" }]);
  });
});

describe("CaseSvc.unarchiveMany — bulk restore for Select All in the Archived cases tab", () => {
  const originals = { unarchive: CaseSvc.unarchive };

  afterEach(() => {
    (CaseSvc as any).unarchive = originals.unarchive;
  });

  it("restores every id and reports nothing failed", async () => {
    (CaseSvc as any).unarchive = async (id: string) => ({ id, status: "ACTIVE" });

    const result = await CaseSvc.unarchiveMany(["case-1", "case-2"], "org-1", "user-1");

    expect(result.succeeded).to.deep.equal([
      { id: "case-1", status: "ACTIVE" },
      { id: "case-2", status: "ACTIVE" },
    ]);
    expect(result.failed).to.have.length(0);
  });

  it("keeps the rest of the batch when one id fails", async () => {
    (CaseSvc as any).unarchive = async (id: string) => {
      if (id === "case-2") throw new Error("Case not found");
      return { id, status: "ACTIVE" };
    };

    const result = await CaseSvc.unarchiveMany(["case-1", "case-2", "case-3"], "org-1", "user-1");

    expect(result.succeeded.map((c: any) => c.id)).to.deep.equal(["case-1", "case-3"]);
    expect(result.failed).to.deep.equal([{ id: "case-2", error: "Case not found" }]);
  });
});

describe("CaseSvc.archiveMany — bulk archive for Select All in the Active cases tab", () => {
  const originals = { archive: CaseSvc.archive };

  afterEach(() => {
    (CaseSvc as any).archive = originals.archive;
  });

  it("archives every id and reports nothing failed", async () => {
    (CaseSvc as any).archive = async (id: string) => ({ id, status: "ARCHIVED" });

    const result = await CaseSvc.archiveMany(["case-1", "case-2"], "org-1", "user-1");

    expect(result.succeeded).to.deep.equal([
      { id: "case-1", status: "ARCHIVED" },
      { id: "case-2", status: "ARCHIVED" },
    ]);
    expect(result.failed).to.have.length(0);
  });

  it("keeps the rest of the batch when one id fails", async () => {
    (CaseSvc as any).archive = async (id: string) => {
      if (id === "case-2") throw new Error("Case not found");
      return { id, status: "ARCHIVED" };
    };

    const result = await CaseSvc.archiveMany(["case-1", "case-2", "case-3"], "org-1", "user-1");

    expect(result.succeeded.map((c: any) => c.id)).to.deep.equal(["case-1", "case-3"]);
    expect(result.failed).to.deep.equal([{ id: "case-2", error: "Case not found" }]);
  });
});
