import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import sharp from "sharp";
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_DOCUMENT_FILENAME_PATTERN,
  MEDIA_DOCUMENT_EXTENSIONS,
} from "../src/constants";
import { presignClientDocumentSchema } from "../src/validation/client-case.validation";
import * as upload from "../src/utils/upload-content";
import { extractPages, isImageDocument } from "../src/utils/document-text-extraction";
import DocumentSvc from "../src/services/document.service";
import FilesRepo from "../src/repositories/files.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";
import CaseAccess from "../src/utils/case-access";
import prisma from "../src/lib/prisma";
import * as s3 from "../src/utils/s3";
import * as ocr from "../src/utils/ocr";
import { firmScope } from "../src/utils/workspace";

const { contentMatchesExtension, webpToJpeg } = upload;

const bytes = (...b: number[]) => Buffer.from(b);
const ftyp = (brand: string) => Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(16)]);
const riff = (form: string) => Buffer.concat([Buffer.from("RIFF", "latin1"), bytes(0, 0, 0, 0), Buffer.from(form, "latin1"), Buffer.alloc(16)]);

describe("#990 - more upload file types", () => {
  describe("the allowlist", () => {
    it("accepts the new photo and audio types", () => {
      for (const ext of ["heic", "webp", "m4a", "wav"]) {
        expect(ALLOWED_DOCUMENT_EXTENSIONS, ext).to.include(ext);
        expect(ALLOWED_DOCUMENT_FILENAME_PATTERN.test(`file.${ext.toUpperCase()}`), ext).to.equal(true);
      }
    });

    it("still refuses executables, saying which formats are supported", () => {
      expect(ALLOWED_DOCUMENT_FILENAME_PATTERN.test("setup.exe")).to.equal(false);
      const { error } = presignClientDocumentSchema.validate({ filename: "setup.exe", contentType: "application/octet-stream" });
      expect(error?.message).to.match(/Unsupported file type\. Supported formats: .*WEBP, HEIC.*M4A.*WAV/);
    });

    it("transcribes the new audio types", () => {
      expect(MEDIA_DOCUMENT_EXTENSIONS).to.include.members(["m4a", "wav"]);
    });
  });

  describe("contentMatchesExtension", () => {
    it("accepts files whose bytes match the extension", () => {
      expect(contentMatchesExtension("a.heic", ftyp("heic"))).to.equal(true);
      expect(contentMatchesExtension("a.webp", riff("WEBP"))).to.equal(true);
      expect(contentMatchesExtension("a.wav", riff("WAVE"))).to.equal(true);
      expect(contentMatchesExtension("a.m4a", ftyp("M4A "))).to.equal(true);
      expect(contentMatchesExtension("a.mp3", Buffer.from("ID3\u0003", "latin1"))).to.equal(true);
      expect(contentMatchesExtension("a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0))).to.equal(true);
      expect(contentMatchesExtension("a.pdf", Buffer.from("%PDF-1.7"))).to.equal(true);
      expect(contentMatchesExtension("notes.txt", Buffer.from("anything at all"))).to.equal(true);
    });

    it("refuses an executable renamed to an allowed extension", () => {
      const exe = Buffer.from("MZ\u0090\u0000\u0003", "latin1");
      for (const name of ["a.heic", "a.webp", "a.wav", "a.m4a", "a.mp3", "a.jpg", "a.png", "a.pdf", "a.docx"]) {
        expect(contentMatchesExtension(name, exe), name).to.equal(false);
      }
    });

    it("refuses a mismatched type (a WAV named .m4a, a PNG named .heic)", () => {
      expect(contentMatchesExtension("a.m4a", riff("WAVE"))).to.equal(false);
      expect(contentMatchesExtension("a.heic", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).to.equal(false);
    });
  });

  describe("WEBP images", () => {
    let webp: Buffer;
    beforeEach(async () => {
      webp = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    });

    it("are treated as images", () => {
      expect(isImageDocument("image/webp", "shot.webp")).to.equal(true);
      expect(isImageDocument(null, "shot.WEBP")).to.equal(true);
    });

    it("convert to a JPEG, flattening transparency onto white", async () => {
      const jpeg = await webpToJpeg(webp);
      expect(contentMatchesExtension("a.jpg", jpeg)).to.equal(true);
      const { data } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
      expect(data[0]).to.be.greaterThan(240);
    });

    it("go through OCR as a JPEG instead of being rejected as unsupported", async () => {
      const target = ocr as unknown as Record<string, unknown>;
      const original = target.ocrDocument;
      let sent: Buffer | undefined;
      target.ocrDocument = async (buffer: Buffer) => {
        sent = buffer;
        return "line one";
      };
      try {
        const result = await extractPages(webp, "image/webp", "shot.webp");
        expect(result.method).to.equal("ocr");
        expect(result.ocrAttempted).to.equal(true);
        expect(result.pages[0].text).to.equal("line one");
        expect(contentMatchesExtension("a.jpg", sent ?? Buffer.alloc(0))).to.equal(true);
      } finally {
        target.ocrDocument = original;
      }
    });
  });

  describe("confirming an upload", () => {
    const restore: (() => void)[] = [];
    const stub = (obj: object, key: string, value: unknown) => {
      const target = obj as Record<string, unknown>;
      const original = target[key];
      target[key] = value;
      restore.push(() => {
        target[key] = original;
      });
    };
    let objects: Map<string, Buffer>;
    let deleted: string[];
    let created: { name: string; mimeType?: string; fileSize?: number }[];
    let fileRows: { filename: string; s3Key: string }[];

    beforeEach(() => {
      objects = new Map();
      deleted = [];
      created = [];
      fileRows = [];
      stub(CaseAccess, "canEdit", async () => true);
      stub(CaseAccess, "loadAccessibleCase", async () => ({ id: "case-1", organizationId: "org-1" }));
      stub(s3, "s3UrlForKey", (key: string) => `https://s3.example/${key}`);
      stub(s3, "getObjectHead", async (key: string) => {
        const body = objects.get(key);
        if (!body) throw new Error("NoSuchKey");
        return body.subarray(0, 64);
      });
      stub(s3, "getObjectBuffer", async (key: string) => objects.get(key));
      stub(s3, "uploadToS3", async (key: string, body: Buffer) => {
        objects.set(key, body);
        return key;
      });
      stub(s3, "deleteFromS3", async (key: string) => {
        deleted.push(key);
        objects.delete(key);
      });
      stub(upload, "heicToJpeg", async () => bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
      stub(FilesRepo, "create", async (filename: string, _url: string, s3Key: string) => {
        fileRows.push({ filename, s3Key });
        return { id: "file-1" };
      });
      stub(FilesRepo, "createFile", async (rows: { filename: string; s3Key: string }[]) => {
        fileRows.push(...rows);
        return rows.map((r, i) => ({ id: `file-${i}`, ...r }));
      });
      stub(DocumentRepo, "create", async (_org: string, _user: string, data: { name: string; mimeType?: string; fileSize?: number }) => {
        created.push(data);
        return { id: "doc-1" };
      });
      stub(DocumentRepo, "createManyAndReturn", async (rows: { name: string; mimeType?: string; fileSize?: number }[]) => {
        created.push(...rows);
        return rows.map((r, i) => ({ id: `doc-${i}`, ...r }));
      });
      stub(prisma, "$transaction", async (fn: (tx: unknown) => unknown) => fn({}));
      stub(DocumentExtractionQueue, "enqueue", () => undefined);
      stub(DocumentExtractionQueue, "enqueueMany", () => undefined);
    });

    afterEach(() => {
      while (restore.length) restore.pop()!();
    });

    const scope = firmScope("org-1");

    it("registers a WAV whose bytes are a WAV", async () => {
      objects.set("k/a.wav", riff("WAVE"));
      await DocumentSvc.create(scope, "user-1", { key: "k/a.wav", name: "recording.wav", caseId: "case-1", contentType: "audio/wav", fileSize: 32 });
      expect(created.map((d) => d.name)).to.deep.equal(["recording.wav"]);
      expect(deleted).to.deep.equal([]);
    });

    it("refuses and removes a file that isn't what its extension says", async () => {
      objects.set("k/a.m4a", Buffer.from("MZ\u0090\u0000", "latin1"));
      let err: { statusCode?: number; message?: string } | undefined;
      try {
        await DocumentSvc.create(scope, "user-1", { key: "k/a.m4a", name: "voice-memo.m4a", caseId: "case-1" });
      } catch (e) {
        err = e as typeof err;
      }
      expect(err?.statusCode).to.equal(400);
      expect(err?.message).to.match(/Supported formats/);
      expect(created).to.deep.equal([]);
      expect(deleted).to.deep.equal(["k/a.m4a"]);
    });

    it("stores a HEIC photo as a JPEG, replacing the original", async () => {
      objects.set("k/p.heic", ftyp("heic"));
      await DocumentSvc.createMany(scope, "user-1", [{ key: "k/p.heic", name: "phone-photo.heic", contentType: "image/heic", fileSize: 99 }], "case-1");
      expect(created).to.have.length(1);
      expect(created[0]).to.include({ name: "phone-photo.jpg", mimeType: "image/jpeg", fileSize: 7 });
      expect(fileRows[0]).to.include({ s3Key: "k/p.jpg" });
      expect(deleted).to.deep.equal(["k/p.heic"]);
      expect(objects.has("k/p.jpg")).to.equal(true);
    });
  });
});
