/** One upload request may total at most 1 GB (DOCUMENT_UPLOAD_BATCH_MAX_BYTES), with no separate
 * per-file cap. Checked at presign (before any URL is minted), at confirm (before any row is
 * written) and on the create-case-with-documents path; when presign is told a file's size, that
 * size is signed into the URL.
 *
 * No live Postgres or S3: CaseAccess, the repos, the queue and the S3 helpers are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DocumentSvc from "../src/services/document.service";
import CaseSvc from "../src/services/case.service";
import DocumentRepo from "../src/repositories/document.repository";
import FilesRepo from "../src/repositories/files.repository";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";
import CaseAccess from "../src/utils/case-access";
import prisma from "../src/lib/prisma";
import * as s3 from "../src/utils/s3";
import { DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../src/constants";
import { assertBatchWithinLimit, formatBytes } from "../src/utils/upload-batch-limit";
import { presignDocumentSchema, createDocumentSchema } from "../src/validation/document.validation";
import { createCaseWithDocumentSchema } from "../src/validation/case.validation";

const GB = DOCUMENT_UPLOAD_BATCH_MAX_BYTES;
const MB = 1024 * 1024;

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

describe("upload batch limit (1 GB per request)", () => {
  describe("assertBatchWithinLimit", () => {
    it("accepts a batch of exactly 1 GB", () => {
      expect(() => assertBatchWithinLimit([GB / 2, GB / 2])).not.to.throw();
    });

    it("refuses 1 byte over with a 413 naming the total", () => {
      const err = (() => {
        try {
          assertBatchWithinLimit([GB / 2, GB / 2 + 1]);
        } catch (e) {
          return e as any;
        }
      })();
      expect(err.statusCode).to.equal(413);
      expect(err.code).to.equal("UPLOAD_BATCH_TOO_LARGE");
      expect(err.message).to.equal("Upload is 1 GB — the limit is 1 GB per upload.");
      expect(err.details).to.deep.equal({ totalBytes: GB + 1, maxBytes: GB });
    });

    it("has no per-file cap: one 1 GB file is fine", () => {
      expect(() => assertBatchWithinLimit([GB])).not.to.throw();
    });

    it("counts sizes an older client didn't send as 0", () => {
      expect(() => assertBatchWithinLimit([undefined, undefined])).not.to.throw();
    });
  });

  it("formatBytes uses binary units", () => {
    expect(formatBytes(0)).to.equal("0 B");
    expect(formatBytes(1536)).to.equal("1.5 KB");
    expect(formatBytes(350 * MB)).to.equal("350 MB");
    expect(formatBytes(1.4 * GB)).to.equal("1.4 GB");
  });

  describe("schemas", () => {
    it("presign accepts fileSize from 0 up to 1 GB, and still accepts it missing", () => {
      expect(presignDocumentSchema.validate({ filename: "a.txt", contentType: "text/plain", fileSize: 0 }).error).to.equal(undefined);
      expect(presignDocumentSchema.validate({ filename: "a.pdf", contentType: "application/pdf", fileSize: GB }).error).to.equal(undefined);
      expect(presignDocumentSchema.validate({ filename: "a.pdf", contentType: "application/pdf" }).error).to.equal(undefined);
      expect(
        presignDocumentSchema.validate({ files: [{ filename: "a.pdf", contentType: "application/pdf", fileSize: 900 * MB }] }).error,
      ).to.equal(undefined);
    });

    it("presign refuses a single file over 1 GB", () => {
      expect(presignDocumentSchema.validate({ filename: "a.pdf", contentType: "application/pdf", fileSize: GB + 1 }).error).not.to.equal(undefined);
      expect(
        presignDocumentSchema.validate({ files: [{ filename: "a.pdf", contentType: "application/pdf", fileSize: GB + 1 }] }).error,
      ).not.to.equal(undefined);
    });

    it("confirm schemas refuse a file over 1 GB", () => {
      expect(createDocumentSchema.validate({ key: "k", name: "a.pdf", fileSize: GB + 1 }).error).not.to.equal(undefined);
      expect(createDocumentSchema.validate({ key: "k", name: "a.pdf", fileSize: 300 * MB }).error).to.equal(undefined);
      const caseDoc = (fileSize: number) => ({
        caseId: "c1",
        documentData: [{ filename: "a.pdf", s3Key: "k", metaData: { fileSize, mimeType: "application/pdf" } }],
      });
      expect(createCaseWithDocumentSchema.validate(caseDoc(GB + 1)).error).not.to.equal(undefined);
      expect(createCaseWithDocumentSchema.validate(caseDoc(0)).error).to.equal(undefined);
    });
  });

  describe("services", () => {
    let presigned: { key: string; contentType: string; contentLength?: number }[];
    let writes: string[];

    beforeEach(() => {
      presigned = [];
      writes = [];
      stub(CaseAccess, "loadAccessibleCase", async (caseId: string) => ({ id: caseId, organizationId: "org-1" }));
      stub(s3, "getPresignedUploadUrl", async (key: string, contentType: string, contentLength?: number) => {
        presigned.push({ key, contentType, contentLength });
        return `https://s3.example/${key}`;
      });
      stub(s3, "s3UrlForKey", (key: string) => `https://s3.example/${key}`);
      stub(FilesRepo, "createFile", async (files: unknown[]) => {
        writes.push("file:createMany");
        return files.map((_, i) => ({ id: `file-${i}`, s3Key: "k", filename: "f.pdf" }));
      });
      stub(DocumentRepo, "createManyAndReturn", async (rows: unknown[]) => {
        writes.push("doc:createMany");
        return rows.map((row: any, i) => ({ id: `doc-${i}`, ...row }));
      });
      stub(prisma, "$transaction", async (fn: (tx: unknown) => unknown) => fn({}));
      stub(DocumentExtractionQueue, "enqueueMany", () => writes.push("queue:enqueueMany"));
    });

    afterEach(() => {
      while (restore.length) restore.pop()!();
    });

    it("presignMany signs each file's size into its URL", async () => {
      const files = [
        { filename: "a.pdf", contentType: "application/pdf", fileSize: 100 * MB },
        { filename: "b.txt", contentType: "text/plain", fileSize: 0 },
      ];
      const items = await DocumentSvc.presignMany("org-1", "user-1", files, "case-1");
      expect(items).to.have.length(2);
      expect(presigned.map((p) => p.contentLength)).to.deep.equal([100 * MB, 0]);
    });

    it("presignMany mints no URL for a batch over 1 GB", async () => {
      const files = Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.pdf`, contentType: "application/pdf", fileSize: 100 * MB }));
      const err = await rejection(DocumentSvc.presignMany("org-1", "user-1", files, "case-1"));
      expect(err.statusCode).to.equal(413);
      expect(presigned).to.have.length(0);
    });

    it("single presign passes the size through, and leaves it unsigned when missing", async () => {
      await DocumentSvc.presign("org-1", "user-1", "a.pdf", "application/pdf", "case-1", undefined, 42);
      await DocumentSvc.presign("org-1", "user-1", "b.pdf", "application/pdf", "case-1");
      expect(presigned.map((p) => p.contentLength)).to.deep.equal([42, undefined]);
    });

    it("createMany writes no rows for a batch over 1 GB", async () => {
      const items = [
        { key: "k1", name: "a.pdf", fileSize: 600 * MB },
        { key: "k2", name: "b.pdf", fileSize: 600 * MB },
      ];
      const err = await rejection(DocumentSvc.createMany("org-1", "user-1", items, "case-1"));
      expect(err.statusCode).to.equal(413);
      expect(writes).to.deep.equal([]);
    });

    it("createMany still records a batch of exactly 1 GB", async () => {
      const items = [
        { key: "k1", name: "a.pdf", fileSize: GB / 2 },
        { key: "k2", name: "b.pdf", fileSize: GB / 2 },
      ];
      await DocumentSvc.createMany("org-1", "user-1", items, "case-1");
      expect(writes).to.include("doc:createMany");
    });

    it("create-case-with-documents writes no rows for a batch over 1 GB", async () => {
      stub(CaseSvc, "getById", async () => ({ id: "case-1" }));
      const documentData = [
        { filename: "a.pdf", s3Key: "k1", metaData: { fileSize: 700 * MB, mimeType: "application/pdf" } },
        { filename: "b.pdf", s3Key: "k2", metaData: { fileSize: 700 * MB, mimeType: "application/pdf" } },
      ];
      const err = await rejection(
        CaseSvc.handleCreateCaseWithDocument({ caseId: "case-1", organizationId: "org-1", userId: "user-1" }, documentData),
      );
      expect(err.statusCode).to.equal(413);
      expect(writes).to.deep.equal([]);
    });
  });
});
