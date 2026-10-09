/** #91: an uploaded document's size is checked against S3 at confirm time, since a presigned PUT
 * can't cap it. The client's own `fileSize` is never trusted for this — or stored.
 *
 * No live S3: getObjectSize and deleteS3Object are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as s3 from "../src/utils/s3";
import { assertUploadedSizesAllowed, maxDocumentBytes } from "../src/utils/document-size";
import { DOCUMENT_MAX_BYTES, IMAGE_DOCUMENT_MAX_BYTES } from "../src/constants";

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

describe("#91 — document upload size cap", () => {
  /** key -> size S3 reports; a missing key means no object. */
  let sizes: Record<string, number>;
  let deleted: string[];

  beforeEach(() => {
    sizes = {};
    deleted = [];
    stub(s3, "getObjectSize", async (key: string) => (key in sizes ? sizes[key] : null));
    stub(s3, "deleteS3Object", async (key: string) => {
      deleted.push(key);
    });
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  describe("maxDocumentBytes", () => {
    it("gives documents the document cap", () => {
      expect(maxDocumentBytes("bundle.pdf")).to.equal(DOCUMENT_MAX_BYTES);
      expect(maxDocumentBytes("hearing.mp4")).to.equal(DOCUMENT_MAX_BYTES);
    });

    it("gives images the sync-OCR cap, whatever the extension's case", () => {
      expect(maxDocumentBytes("scan.jpg")).to.equal(IMAGE_DOCUMENT_MAX_BYTES);
      expect(maxDocumentBytes("SCAN.PNG")).to.equal(IMAGE_DOCUMENT_MAX_BYTES);
    });
  });

  describe("assertUploadedSizesAllowed", () => {
    it("returns S3's sizes, in order, for files within their caps", async () => {
      sizes = { a: 20 * MB, b: 4 * MB };
      const result = await assertUploadedSizesAllowed([
        { key: "a", name: "bundle.pdf" },
        { key: "b", name: "photo.jpg" },
      ]);
      expect(result).to.deep.equal([20 * MB, 4 * MB]);
      expect(deleted).to.deep.equal([]);
    });

    it("accepts a file exactly at the cap", async () => {
      sizes = { a: DOCUMENT_MAX_BYTES };
      await assertUploadedSizesAllowed([{ key: "a", name: "bundle.pdf" }]);
      expect(deleted).to.deep.equal([]);
    });

    it("refuses the batch with a 413 and deletes only the oversized objects", async () => {
      sizes = { ok: 10 * MB, big: DOCUMENT_MAX_BYTES + 1, photo: 6 * MB };
      const err = await rejection(
        assertUploadedSizesAllowed([
          { key: "ok", name: "letter.pdf" },
          { key: "big", name: "bundle.pdf" },
          { key: "photo", name: "scan.png" },
        ]),
      );
      expect(err.statusCode).to.equal(413);
      expect(err.message).to.contain("bundle.pdf (limit 25 MB)").and.to.contain("scan.png (limit 5 MB)");
      expect(deleted).to.have.members(["big", "photo"]);
    });

    it("still refuses when deleting the oversized object fails", async () => {
      sizes = { big: DOCUMENT_MAX_BYTES + 1 };
      stub(s3, "deleteS3Object", async () => {
        throw new Error("s3 down");
      });
      const err = await rejection(assertUploadedSizesAllowed([{ key: "big", name: "bundle.pdf" }]));
      expect(err.statusCode).to.equal(413);
    });

    it("refuses a confirm for a file that was never uploaded", async () => {
      const err = await rejection(assertUploadedSizesAllowed([{ key: "nothing", name: "bundle.pdf" }]));
      expect(err.statusCode).to.equal(400);
      expect(deleted).to.deep.equal([]);
    });
  });
});
