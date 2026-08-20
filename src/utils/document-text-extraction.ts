import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { ocrPdf } from "./ocr";
import logger from "./logger";

type DocType = "pdf" | "docx";

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

function resolveType(mimeType?: string | null, filename?: string): DocType | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";

  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
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

export async function extractPages(
  buffer: Buffer,
  mimeType?: string | null,
  filename?: string,
): Promise<{ pages: ExtractedPage[]; method: "text" | "ocr" | "mixed"; ocrAttempted: boolean }> {
  const type = resolveType(mimeType, filename);
  if (type === "docx") {
    return { pages: await extractDocxPages(buffer), method: "text", ocrAttempted: false };
  }
  if (type !== "pdf") {
    throw new Error(`Unsupported document type for extraction (mimeType=${mimeType ?? "unknown"}, filename=${filename ?? "unknown"})`);
  }

  const pages = await extractPdfPages(buffer);
  const joined = pages.map((p) => p.text).join("\n").trim();
  if (joined) return { pages, method: "text", ocrAttempted: false };

  logger.info("Document extraction: empty PDF text, attempting OCR");
  const ocrText = await ocrPdf(buffer);
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
