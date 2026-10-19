/** Uploads now go up to 1 GB with no per-file cap, and every file stays eligible for extraction.
 * extractPagesFromFile reads TXT and XLSX from disk in pieces (never one giant string), sends
 * JPG/PNG past Textract's inline-bytes limit to the S3-based OCR call, and hands PDF/DOCX/DOC to
 * the existing buffer parsers. The queue's hard timeout grows with file size.
 *
 * Real temp files and a real ExcelJS workbook; Textract is monkeypatched.
 */
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ExcelJS from "exceljs";
import * as ocr from "../src/utils/ocr";
import { extractPages, extractPagesFromFile, STREAMED_PAGE_MAX_CHARS } from "../src/utils/document-text-extraction";
import { leadingText } from "../src/services/document-extraction.service";
import { jobHardTimeoutMs } from "../src/queues/document-extraction.queue";

const MB = 1024 * 1024;

describe("large-document extraction", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "large-extract-spec-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, content: string | Buffer): Promise<{ path: string; bytes: number }> {
    const path = join(dir, name);
    await writeFile(path, content);
    return { path, bytes: Buffer.byteLength(content) };
  }

  describe("TXT", () => {
    it("matches the buffer path for a small file (BOM dropped, form feeds split pages)", async () => {
      const text = "﻿Page one line\nsecond line\fPage two";
      const { path, bytes } = await file("small.txt", text);
      const fromFile = await extractPagesFromFile(path, bytes, "text/plain", "small.txt");
      const fromBuffer = await extractPages(Buffer.from(text), "text/plain", "small.txt");
      expect(fromFile.pages).to.deep.equal(fromBuffer.pages);
    });

    it("splits a form-feed-free file into pages no longer than STREAMED_PAGE_MAX_CHARS, at line breaks, losing nothing", async () => {
      const line = "x".repeat(99);
      const lineCount = Math.ceil((STREAMED_PAGE_MAX_CHARS * 2.5) / 100);
      const text = Array.from({ length: lineCount }, () => line).join("\n");
      const { path, bytes } = await file("big.txt", text);

      const { pages } = await extractPagesFromFile(path, bytes, "text/plain", "big.txt");

      expect(pages.length).to.equal(3);
      expect(pages.every((p) => p.text.length <= STREAMED_PAGE_MAX_CHARS)).to.equal(true);
      expect(pages.map((p) => p.pageNumber)).to.deep.equal([1, 2, 3]);
      // Every page ends on a whole line, and rejoining at the cut line breaks gives the file back.
      expect(pages.every((p) => p.text.split("\n").every((l) => l === line))).to.equal(true);
      expect(pages.map((p) => p.text).join("\n")).to.equal(text);
    });

    it("keeps multi-byte characters intact across read-chunk boundaries", async () => {
      const text = "é".repeat(200_000) + "\n" + "한".repeat(200_000);
      const { path, bytes } = await file("utf8.txt", text);
      const { pages } = await extractPagesFromFile(path, bytes, "text/plain", "utf8.txt");
      expect(pages.map((p) => p.text).join("")).to.equal(text);
    });
  });

  describe("XLSX", () => {
    // Over XLSX_STREAM_MIN_BYTES (25 MB), so a small test file takes the streaming path.
    const STREAMED = 30 * MB;

    async function bookFile() {
      const workbook = new ExcelJS.Workbook();
      const parties = workbook.addWorksheet("Parties");
      parties.addRow(["Name", "Role"]);
      parties.addRow(["Juan Dela Cruz", "Complainant"]);
      workbook.addWorksheet("Empty");
      const damages = workbook.addWorksheet("Damages");
      damages.addRow(["Unpaid wages", 45000]);
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      return { buffer, ...(await file("book.xlsx", buffer)) };
    }

    it("reads a workbook up to 25 MB exactly as before", async () => {
      const { buffer, path, bytes } = await bookFile();
      const fromFile = await extractPagesFromFile(path, bytes, undefined, "book.xlsx");
      const fromBuffer = await extractPages(buffer, undefined, "book.xlsx");
      expect(fromFile.pages).to.deep.equal(fromBuffer.pages);
    });

    it("streams a larger one to the same rows (ExcelJS-written files fall back to Sheet<n> names)", async () => {
      const { buffer, path } = await bookFile();
      const streamed = await extractPagesFromFile(path, STREAMED, undefined, "book.xlsx");
      const loaded = await extractPages(buffer, undefined, "book.xlsx");

      const rowsOf = (pages: { text: string }[]) => pages.map((p) => p.text.split("\n").slice(1).join("\n"));
      expect(rowsOf(streamed.pages)).to.deep.equal(rowsOf(loaded.pages));
      // Whether the streaming reader has seen workbook.xml by the time a sheet is read depends on
      // timing, so each name is either the sheet's real one or the Sheet<n> fallback.
      const loadedNames = loaded.pages.map((p) => p.text.split("\n")[0]);
      streamed.pages.forEach((p, i) => {
        const name = p.text.split("\n")[0];
        expect([loadedNames[i], loadedNames[i] ? `Sheet${i + 1}` : ""], `sheet ${i + 1}`).to.include(name);
      });
    });

    it("splits one oversized sheet into several pages, each headed with the sheet's name", async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Ledger");
      const cell = "y".repeat(990);
      const rows = Math.ceil((STREAMED_PAGE_MAX_CHARS * 1.5) / 1000);
      for (let i = 0; i < rows; i++) sheet.addRow([cell]);
      const { path } = await file("ledger.xlsx", Buffer.from(await workbook.xlsx.writeBuffer()));

      const { pages } = await extractPagesFromFile(path, STREAMED, undefined, "ledger.xlsx");

      expect(pages.length).to.equal(2);
      // Here the reader does reach workbook.xml, so the name is resolved after the read.
      expect(pages.map((p) => p.text.split("\n")[0])).to.deep.equal(["Ledger", "Ledger"]);
      const rowCount = pages.reduce((n, p) => n + p.text.split("\n").length - 1, 0);
      expect(rowCount).to.equal(rows);
    });
  });

  describe("images", () => {
    const originals = { ocrImageFromS3: (ocr as any).ocrImageFromS3, ocrDocument: (ocr as any).ocrDocument };
    let calls: string[];

    before(() => {
      calls = [];
      (ocr as any).ocrImageFromS3 = async (key: string, bytes: number) => {
        calls.push(`s3:${key}:${bytes}`);
        return "scanned text";
      };
      (ocr as any).ocrDocument = async (buffer: Buffer) => {
        calls.push(`bytes:${buffer.length}`);
        return "scanned text";
      };
    });

    after(() => {
      (ocr as any).ocrImageFromS3 = originals.ocrImageFromS3;
      (ocr as any).ocrDocument = originals.ocrDocument;
    });

    it("OCRs an image over 5 MB from S3 instead of sending its bytes", async () => {
      const big = Buffer.alloc(6 * MB);
      const { path, bytes } = await file("photo.jpg", big);
      const result = await extractPagesFromFile(path, bytes, "image/jpeg", "photo.jpg", "documents/cases/c1/photo.jpg");
      expect(calls).to.deep.equal([`s3:documents/cases/c1/photo.jpg:${6 * MB}`]);
      expect(result.method).to.equal("ocr");
      expect(result.pages[0].text).to.equal("scanned text");
    });

    it("still sends a small image's bytes inline", async () => {
      calls = [];
      const { path, bytes } = await file("small.png", Buffer.alloc(1000));
      await extractPagesFromFile(path, bytes, "image/png", "small.png", "k");
      expect(calls).to.deep.equal(["bytes:1000"]);
    });
  });

  it("ocrImageFromS3 skips an image over Textract's 10 MB limit without calling AWS", async () => {
    expect(await ocr.ocrImageFromS3("k", 11 * MB)).to.equal("");
  });

  it("leadingText takes the opening characters page by page", () => {
    const pages = [
      { pageNumber: 1, text: "abc" },
      { pageNumber: 2, text: "def" },
      { pageNumber: 3, text: "never read" },
    ];
    expect(leadingText(pages, 7)).to.equal("abc\n\nde");
    expect(leadingText(pages, 2)).to.equal("ab");
  });

  it("jobHardTimeoutMs keeps 15 minutes up to 25 MB and grows 10 s per MB beyond", () => {
    expect(jobHardTimeoutMs(null)).to.equal(15 * 60_000);
    expect(jobHardTimeoutMs(25 * MB)).to.equal(15 * 60_000);
    expect(jobHardTimeoutMs(125 * MB)).to.equal(15 * 60_000 + 100 * 10_000);
    expect(jobHardTimeoutMs(1024 * MB)).to.equal(15 * 60_000 + 999 * 10_000);
  });
});
