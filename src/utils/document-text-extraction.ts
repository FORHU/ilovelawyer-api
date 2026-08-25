import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { ocrDocument } from "./ocr";
import logger from "./logger";

type DocType = "pdf" | "docx" | "image" | "xlsx";

// Textract's synchronous DetectDocumentText only accepts these two raster formats (plus
// single-page PDF, handled separately above) — anything else (WEBP, GIF, HEIC, ...) still
// falls through to the "unsupported" error below rather than failing inside Textract itself.
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

// Legacy .xls (binary BIFF8) is deliberately not included — exceljs only reads the modern
// OOXML .xlsx format, and loading a .xls through its xlsx parser just throws.

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

function resolveType(mimeType?: string | null, filename?: string): DocType | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) return "image";

  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
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
): Promise<{ pages: ExtractedPage[]; method: "text" | "ocr" | "mixed"; ocrAttempted: boolean }> {
  const type = resolveType(mimeType, filename);
  if (type === "docx") {
    return { pages: await extractDocxPages(buffer), method: "text", ocrAttempted: false };
  }

  if (type === "xlsx") {
    return { pages: await extractXlsxPages(buffer), method: "text", ocrAttempted: false };
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
  const joined = pages.map((p) => p.text).join("\n").trim();
  if (joined) return { pages, method: "text", ocrAttempted: false };

  logger.info("Document extraction: empty PDF text, attempting OCR");
  const ocrText = await ocrDocument(buffer);
  if (ocrText.trim()) {
    return { pages: pagesFromText(ocrText), method: "ocr", ocrAttempted: true };
  }
  return { pages, method: "text", ocrAttempted: true };
}

/** Extracts plain text from a Case Document's file bytes. Scanned PDFs try OCR once. */
export async function extractText(buffer: Buffer, mimeType?: string | null, filename?: string): Promise<string> {
  const { pages } = await extractPages(buffer, mimeType, filename);
  return pages.map((p) => p.text).join("\n\n");
}
