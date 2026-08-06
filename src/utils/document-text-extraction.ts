import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

type DocType = "pdf" | "docx";

function resolveType(mimeType?: string | null, filename?: string): DocType | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";

  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  return null;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/** Extracts plain text from a Case Document's file bytes. No OCR — a scanned/image-only PDF
 * yields empty (or near-empty) text, which the caller treats as a failed extraction. */
export async function extractText(buffer: Buffer, mimeType?: string | null, filename?: string): Promise<string> {
  const type = resolveType(mimeType, filename);
  if (type === "pdf") return extractPdfText(buffer);
  if (type === "docx") return extractDocxText(buffer);
  throw new Error(`Unsupported document type for extraction (mimeType=${mimeType ?? "unknown"}, filename=${filename ?? "unknown"})`);
}
