/** #371: an upload naming a case must name one the uploader can actually open, in their own
 * organization.
 *
 * Before this, presign/create/createMany took any caseId: the S3 key was built under
 * documents/cases/<caseId>/ and the Document row stored that caseId, with only the *document*
 * scoped to the uploader's organization. Since every reader of a case's documents looks them up by
 * caseId alone (DocumentRepo.listAllByCase, chat retrieval), a document could be planted in
 * another firm's case — or in a confidential case the uploader is walled off from (#346) — and be
 * read into its AI analysis and chat answers.
 *
 * Uploading is not editing: a plain member who can view a case may still add documents to it. What
 * they can't do is edit, archive or delete them (#345).
 *
 * No live Postgres or S3: CaseAccess, the repos, the queue and the S3 helpers are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import FilesRepo from "../src/repositories/files.repository";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import prisma from "../src/lib/prisma";
import * as s3 from "../src/utils/s3";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const UPLOADER = "member-1";

/** caseId -> what CaseAccess.loadAccessibleCase would return for UPLOADER. */
const CASES: Record<string, { id: string; organizationId: string | null; confidential?: boolean } | "walled"> = {
  "case-mine": { id: "case-mine", organizationId: ORG },
  "case-other-org": { id: "case-other-org", organizationId: OTHER_ORG },
  "case-confidential": "walled",
  "case-no-org": { id: "case-no-org", organizationId: null },
  // Confidential cases UPLOADER holds a grant on — VIEW on the first, EDIT on the second.
  "case-confidential-view": { id: "case-confidential-view", organizationId: ORG, confidential: true },
  "case-confidential-edit": { id: "case-confidential-edit", organizationId: ORG, confidential: true },
};

/** caseId -> what CaseAccess.canEdit would answer for UPLOADER. */
const EDITABLE = new Set(["case-confidential-edit"]);

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
  throw new Error("expected the upload to be refused");
}

describe("#371 — uploads only reach a case the uploader can open", () => {
  /** Every write and queue push that got through. */
  let writes: string[];
  let accessChecks: { caseId: string; userId: string }[];
  let editChecks: string[];

  beforeEach(() => {
    writes = [];
    accessChecks = [];
    editChecks = [];

    stub(CaseAccess, "canEdit", async (caseId: string) => {
      editChecks.push(caseId);
      return EDITABLE.has(caseId);
    });

    stub(CaseAccess, "loadAccessibleCase", async (caseId: string, userId: string) => {
      accessChecks.push({ caseId, userId });
      const found = CASES[caseId];
      if (!found || found === "walled") throw new HttpError("Case not found", 404);
      return found;
    });
    stub(s3, "getPresignedUploadUrl", async (key: string) => {
      writes.push(`presign:${key}`);
      return `https://s3.example/${key}`;
    });
    stub(s3, "s3UrlForKey", (key: string) => `https://s3.example/${key}`);
    stub(s3, "getObjectSize", async () => 1024);
    stub(FilesRepo, "create", async () => {
      writes.push("file:create");
      return { id: "file-1" };
    });
    stub(FilesRepo, "createFile", async () => {
      writes.push("file:createMany");
      return [{ id: "file-1", s3Key: "k", filename: "f.pdf" }];
    });
    stub(DocumentRepo, "create", async (_org: string, _user: string, data: { caseId?: string }) => {
      writes.push(`doc:create:${data.caseId ?? "none"}`);
      return { id: "doc-1", caseId: data.caseId ?? null };
    });
    stub(DocumentRepo, "createManyAndReturn", async (rows: { caseId?: string }[]) => {
      writes.push(`doc:createMany:${rows[0]?.caseId ?? "none"}`);
      return rows.map((row, i) => ({ id: `doc-${i}`, ...row }));
    });
    stub(prisma, "$transaction", async (fn: (tx: unknown) => unknown) => fn({}));
    stub(DocumentExtractionQueue, "enqueue", () => writes.push("queue:enqueue"));
    stub(DocumentExtractionQueue, "enqueueMany", () => writes.push("queue:enqueueMany"));
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  describe("presign", () => {
    it("refuses a case in another organization, issuing no upload URL", async () => {
      const err = await rejection(DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf", "case-other-org"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a confidential case the uploader is walled off from", async () => {
      const err = await rejection(DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf", "case-confidential"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a case that doesn't exist at all, with the same 404", async () => {
      const err = await rejection(DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf", "case-nonexistent"));
      expect(err.statusCode).to.equal(404);
    });

    it("lets a member upload to a case they can open, checking access as them", async () => {
      const result = await DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf", "case-mine");
      expect(accessChecks).to.deep.equal([{ caseId: "case-mine", userId: UPLOADER }]);
      expect(result.key).to.match(/^documents\/cases\/case-mine\//);
    });

    it("an upload with no case is unaffected and needs no case check", async () => {
      const result = await DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf");
      expect(accessChecks).to.deep.equal([]);
      expect(result.key).to.match(/^documents\/users\//);
    });

    it("presignMany checks the shared case once, and issues nothing when it's refused", async () => {
      const files = [
        { filename: "a.pdf", contentType: "application/pdf" },
        { filename: "b.pdf", contentType: "application/pdf" },
      ];
      await DocumentSvc.presignMany(ORG, UPLOADER, files, "case-mine");
      expect(accessChecks).to.have.length(1);

      accessChecks = [];
      writes = [];
      const err = await rejection(DocumentSvc.presignMany(ORG, UPLOADER, files, "case-other-org"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });
  });

  describe("create", () => {
    const file = { key: "documents/cases/case-other-org/1-ab.pdf", name: "brief.pdf" };

    it("refuses a case in another organization before writing anything", async () => {
      const err = await rejection(DocumentSvc.create(ORG, UPLOADER, { ...file, caseId: "case-other-org" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a confidential case the uploader is walled off from", async () => {
      const err = await rejection(DocumentSvc.create(ORG, UPLOADER, { ...file, caseId: "case-confidential" }));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("lets a member upload to a case they can open, and still queues extraction", async () => {
      await DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf", caseId: "case-mine" });
      expect(writes).to.deep.equal(["file:create", "doc:create:case-mine", "queue:enqueue"]);
    });

    it("an upload with no case is unaffected", async () => {
      await DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf" });
      expect(accessChecks).to.deep.equal([]);
      expect(writes).to.deep.equal(["file:create", "doc:create:none"]);
    });
  });

  describe("createMany", () => {
    const items = [{ key: "k1", name: "a.pdf" }, { key: "k2", name: "b.pdf" }];

    it("refuses a case in another organization before writing anything", async () => {
      const err = await rejection(DocumentSvc.createMany(ORG, UPLOADER, items, "case-other-org"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("checks the shared case once and lets the batch through", async () => {
      await DocumentSvc.createMany(ORG, UPLOADER, items, "case-mine");
      expect(accessChecks).to.have.length(1);
      expect(writes).to.include("doc:createMany:case-mine");
    });
  });

  describe("a confidential case the uploader holds a grant on", () => {
    it("refuses a view-only grant with a 403, issuing no upload URL", async () => {
      const err = await rejection(DocumentSvc.presign(ORG, UPLOADER, "brief.pdf", "application/pdf", "case-confidential-view"));
      expect(err.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a view-only grant on create and createMany before writing anything", async () => {
      const single = await rejection(DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf", caseId: "case-confidential-view" }));
      expect(single.statusCode).to.equal(403);
      const batch = await rejection(DocumentSvc.createMany(ORG, UPLOADER, [{ key: "k1", name: "a.pdf" }], "case-confidential-view"));
      expect(batch.statusCode).to.equal(403);
      expect(writes).to.deep.equal([]);
    });

    it("lets an edit grant upload, and still queues extraction", async () => {
      await DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf", caseId: "case-confidential-edit" });
      expect(writes).to.deep.equal(["file:create", "doc:create:case-confidential-edit", "queue:enqueue"]);
    });

    it("leaves an ordinary case alone: a viewer may still upload, with no edit check", async () => {
      await DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf", caseId: "case-mine" });
      expect(editChecks).to.deep.equal([]);
      expect(writes).to.include("doc:create:case-mine");
    });
  });

  describe("a case with no organization (creator-owned)", () => {
    it("is allowed for the creator, since only they can open it", async () => {
      await DocumentSvc.create(ORG, UPLOADER, { key: "k", name: "brief.pdf", caseId: "case-no-org" });
      expect(writes).to.include("doc:create:case-no-org");
    });
  });
});
