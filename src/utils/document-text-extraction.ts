import { createReadStream } from "fs";
import { readFile } from "fs/promises";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import WordExtractor from "word-extractor";
import { ocrDocument, ocrImageFromS3, ocrPdfFromS3, TEXTRACT_SYNC_MAX_BYTES } from "./ocr";
import logger from "./logger";

type DocType = "pdf" | "doc" | "docx" | "image" | "xlsx" | "txt";

// Textract's synchronous DetectDocumentText only accepts these two raster formats (plus
// single-page PDF, handled separately above) — anything else (WEBP, GIF, HEIC, ...) still
// falls through to the "unsupported" error below rather than failing inside Textract itself.
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

// .xlsm/.xlam are macro-enabled/add-in variants of the same OOXML zip container as .xlsx, so
// exceljs reads them with the same workbook.xlsx.load path used for "xlsx" below.
const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel.addin.macroEnabled.12",
]);
const XLSX_EXTENSIONS = new Set(["xlsx", "xlsm", "xlam"]);

// Legacy .xls (binary BIFF8) is deliberately not included — exceljs only reads the modern
// OOXML .xlsx format, and loading a .xls through its xlsx parser just throws.

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

/** Largest "page" the file-streaming readers below build. A V8 string tops out around 512M
 * characters, and uploads go up to 1 GB, so a form-feed-free TXT or one huge sheet is split into
 * pages of at most this size (at a line break where there is one) instead of one giant string. */
export const STREAMED_PAGE_MAX_CHARS = 1_000_000;

/** True when any page has non-whitespace text — without joining every page into one string,
 * which can exceed V8's string limit for a very large document. */
function hasText(pages: ExtractedPage[]): boolean {
  return pages.some((p) => p.text.trim().length > 0);
}

/** Accumulates streamed text into pages: a form feed starts a new page (as pagesFromText does),
 * and a page past STREAMED_PAGE_MAX_CHARS is cut at its last line break into a new one. */
class PageBuilder {
  readonly pages: ExtractedPage[] = [];
  private current = "";

  append(text: string): void {
    text.split("\f").forEach((part, i) => {
      if (i > 0) this.flush();
      this.current += part;
      while (this.current.length > STREAMED_PAGE_MAX_CHARS) {
        const lineBreak = this.current.lastIndexOf("\n", STREAMED_PAGE_MAX_CHARS);
        const cut = lineBreak > 0 ? lineBreak : STREAMED_PAGE_MAX_CHARS;
        this.push(this.current.slice(0, cut));
        this.current = this.current.slice(lineBreak > 0 ? cut + 1 : cut);
      }
    });
  }

  flush(): void {
    this.push(this.current);
    this.current = "";
  }

  private push(text: string): void {
    this.pages.push({ pageNumber: this.pages.length + 1, text });
  }
}

function resolveType(mimeType?: string | null, filename?: string): DocType | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/msword") return "doc";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType && XLSX_MIME_TYPES.has(mimeType)) return "xlsx";
  if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (mimeType === "text/plain") return "txt";

  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "txt") return "txt";
  if (ext === "pdf") return "pdf";
  if (ext === "doc") return "doc";
  if (ext === "docx") return "docx";
  if (ext && XLSX_EXTENSIONS.has(ext)) return "xlsx";
  if (ext && IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

function pagesFromText(text: string): ExtractedPage[] {
  const parts = text.split(/\f/);
  if (parts.length > 1) {
    return parts.map((part, i) => ({ pageNumber: i + 1, text: part }));
  }
  return [{ pageNumber: 1, text }];
}

async function extractPdfPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const anyResult = result as { text?: string; pages?: { text?: string; num?: number }[] };
    if (Array.isArray(anyResult.pages) && anyResult.pages.length > 0) {
      return anyResult.pages.map((page, i) => ({
        pageNumber: page.num ?? i + 1,
        text: page.text ?? "",
      }));
    }
    return pagesFromText(anyResult.text ?? "");
  } finally {
    await parser.destroy();
  }
}

async function extractDocxPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const result = await mammoth.extractRawText({ buffer });
  return pagesFromText(result.value);
}

// word-extractor reads the legacy OLE compound-file .doc format that mammoth can't parse.
async function extractDocPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  return pagesFromText(document.getBody());
}

// exceljs represents a cell's parsed value as string | number | boolean | Date | null/undefined
// for plain cells, or an object for formulas/rich text/hyperlinks — narrow those down to the
// text a reader would actually see rather than dumping the raw object.
function cellValueToText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((run) => run.text).join("");
    if ("result" in value) return cellValueToText(value.result as ExcelJS.CellValue);
    if ("text" in value) return String((value as { text: unknown }).text ?? "");
    return "";
  }
  return String(value);
}

// One "page" per sheet, same idea as a PDF page — sheet name as a header line so the model
// (and the chunker, which reads plain text) knows which sheet a chunk came from.
async function extractXlsxPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  return workbook.worksheets.map((sheet, i) => {
    const lines: string[] = [];
    sheet.eachRow((row) => {
      const cells = (row.values as ExcelJS.CellValue[]).slice(1);
      const line = cells.map(cellValueToText).join("\t").trimEnd();
      if (line.trim()) lines.push(line);
    });
    const body = lines.join("\n");
    return { pageNumber: i + 1, text: body ? `${sheet.name}\n${body}` : "" };
  });
}

export async function extractPages(
  buffer: Buffer,
  mimeType?: string | null,
  filename?: string,
  s3Key?: string | null,
): Promise<{ pages: ExtractedPage[]; method: "text" | "ocr" | "mixed"; ocrAttempted: boolean }> {
  const type = resolveType(mimeType, filename);
  if (type === "docx") {
    return { pages: await extractDocxPages(buffer), method: "text", ocrAttempted: false };
  }

  if (type === "doc") {
    return { pages: await extractDocPages(buffer), method: "text", ocrAttempted: false };
  }

  if (type === "xlsx") {
    return { pages: await extractXlsxPages(buffer), method: "text", ocrAttempted: false };
  }

  // Plain text is already the text layer. Decoded as UTF-8 (a leading BOM, as Windows Notepad
  // writes, is dropped); form feeds still split pages via pagesFromText.
  if (type === "txt") {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    return { pages: pagesFromText(text), method: "text", ocrAttempted: false };
  }

  // A photo/scan has no embedded text layer to try first — straight to Textract, same call
  // the scanned-PDF fallback below uses, just skipping the (always-empty) text attempt.
  if (type === "image") {
    logger.info("Document extraction: image upload, running OCR");
    const ocrText = await ocrDocument(buffer);
    return { pages: pagesFromText(ocrText), method: "ocr", ocrAttempted: true };
  }

  if (type !== "pdf") {
    throw new Error(`Unsupported document type for extraction (mimeType=${mimeType ?? "unknown"}, filename=${filename ?? "unknown"})`);
  }

  const pages = await extractPdfPages(buffer);
  if (hasText(pages)) return { pages, method: "text", ocrAttempted: false };

  logger.info("Document extraction: empty PDF text, attempting OCR");
  // Case Documents (confirmed uploads) always have an s3Key — use the async, S3-based path,
  // since sync Textract rejects multi-page PDFs and caps out at 5MB. Callers without one (e.g.
  // law-fulltext.ts, which OCRs an externally-fetched PDF that was never stored in our S3) fall
  // back to the byte-based sync call — more limited (single-page, small), but still better than
  // skipping OCR outright for a source this code has no other way to hand Textract.
  const ocrPages = s3Key ? await ocrPdfFromS3(s3Key) : pagesFromText(await ocrDocument(buffer));
  if (hasText(ocrPages)) {
    return { pages: ocrPages, method: "ocr", ocrAttempted: true };
  }
  return { pages, method: "text", ocrAttempted: true };
}

/** TXT read in pieces, so a file of any size never becomes one string (see PageBuilder). Decoded
 * as UTF-8 across chunk boundaries; a leading BOM is dropped, as in extractPages. */
async function extractTxtPagesFromFile(filePath: string): Promise<ExtractedPage[]> {
  const builder = new PageBuilder();
  let first = true;
  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    const text = chunk as string;
    builder.append(first ? text.replace(/^﻿/, "") : text);
    first = false;
  }
  builder.flush();
  return builder.pages;
}

/** Spreadsheets at or under this size are loaded whole by extractXlsxPages, as before; larger ones
 * stream. The old 25 MB upload cap, so every workbook that could be uploaded before reads exactly
 * as it did. */
const XLSX_STREAM_MIN_BYTES = 25 * 1024 * 1024;

/** XLSX/XLSM/XLAM read row by row with ExcelJS's streaming reader instead of loading the whole
 * workbook. Same text as extractXlsxPages (sheet name, then tab-separated rows), except that a
 * sheet past STREAMED_PAGE_MAX_CHARS spans several pages, each headed with the sheet name, and a
 * sheet name the reader can't find falls back to "Sheet<n>" (see below). */
async function extractXlsxPagesFromFile(filePath: string): Promise<ExtractedPage[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });
  // ExcelJS 4.4's streaming reader looks each sheet's name up in xl/workbook.xml as it reaches the
  // sheet, and throws when the zip stores sheets before workbook.xml (ExcelJS's own writer does,
  // storing it last — where the reader then never parses it at all). An empty model avoids the
  // throw; names it couldn't look up are resolved after the read where possible, else they stay
  // "Sheet<n>". That's why only large files take this path (XLSX_STREAM_MIN_BYTES).
  const internals = reader as unknown as {
    model?: { sheets?: { id: number; name: string; rId: string }[] };
    workbookRels?: { Id: string; Target: string }[];
  };
  internals.model ??= { sheets: [] };

  const sheets: { id: number; name: string; named: boolean; texts: string[] }[] = [];
  for await (const sheet of reader) {
    const { id, name } = sheet as unknown as { id: number; name: string };
    // While the model is still empty, `id` is the sheet's file number (xl/worksheets/sheet<id>.xml).
    const named = (internals.model?.sheets?.length ?? 0) > 0;
    const builder = new PageBuilder();
    for await (const row of sheet) {
      const cells = (row.values as ExcelJS.CellValue[]).slice(1);
      // A form feed inside a cell is content, not a page break.
      const line = cells.map(cellValueToText).join("\t").trimEnd().replace(/\f/g, " ");
      if (line.trim()) builder.append(`${line}\n`);
    }
    builder.flush();
    sheets.push({ id, name, named, texts: builder.pages.map((p) => p.text.replace(/\n$/, "")) });
  }

  const pages: ExtractedPage[] = [];
  for (const sheet of sheets) {
    const rel = sheet.named ? undefined : internals.workbookRels?.find((r) => r.Target === `worksheets/sheet${sheet.id}.xml`);
    const name = (rel && internals.model?.sheets?.find((s) => s.rId === rel.Id)?.name) || sheet.name;
    // Same shape as extractXlsxPages: sheet name, then its rows; an empty sheet is one empty page.
    for (const text of sheet.texts) {
      pages.push({ pageNumber: pages.length + 1, text: text ? `${name}\n${text}` : "" });
    }
  }
  return pages;
}

/** Document extraction's entry point: reads an upload from a local file (see
 * downloadObjectToTempFile) rather than a buffer. TXT and large XLSX stream; JPG/PNG past
 * Textract's byte limit are OCR'd straight from S3; the PDF/DOCX/DOC parsers need the whole file,
 * so those (and smaller spreadsheets) are read into memory once and handed to extractPages. */
export async function extractPagesFromFile(
  filePath: string,
  bytes: number,
  mimeType?: string | null,
  filename?: string,
  s3Key?: string | null,
): Promise<{ pages: ExtractedPage[]; method: "text" | "ocr" | "mixed"; ocrAttempted: boolean }> {
  const type = resolveType(mimeType, filename);
  if (type === "txt") {
    return { pages: await extractTxtPagesFromFile(filePath), method: "text", ocrAttempted: false };
  }
  if (type === "xlsx" && bytes > XLSX_STREAM_MIN_BYTES) {
    return { pages: await extractXlsxPagesFromFile(filePath), method: "text", ocrAttempted: false };
  }
  if (type === "image" && bytes > TEXTRACT_SYNC_MAX_BYTES && s3Key) {
    logger.info("Document extraction: large image upload, running OCR from S3", { bytes });
    const ocrText = await ocrImageFromS3(s3Key, bytes);
    return { pages: pagesFromText(ocrText), method: "ocr", ocrAttempted: true };
  }
  return extractPages(await readFile(filePath), mimeType, filename, s3Key);
}

/** Extracts plain text from a Case Document's file bytes. Scanned PDFs try OCR once. */
export async function extractText(buffer: Buffer, mimeType?: string | null, filename?: string): Promise<string> {
  const { pages } = await extractPages(buffer, mimeType, filename);
  return pages.map((p) => p.text).join("\n\n");
}
