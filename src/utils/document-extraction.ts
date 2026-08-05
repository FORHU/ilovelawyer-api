import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export type FileKind = "pdf" | "docx";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Determines a file's real kind from its bytes rather than its filename or claimed
 * content-type — neither of those can be trusted for a file that arrived via a client-signed
 * S3 PUT. A DOCX is a zip archive; well-formedness beyond the signature is left to mammoth's
 * own parse, which throws on anything that isn't actually valid OOXML. */
export function sniffFileKind(buf: Buffer): FileKind | null {
  if (buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return "pdf";
  if (buf.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) return "docx";
  return null;
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function extractDocxText(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

export async function extractText(buf: Buffer, kind: FileKind): Promise<string> {
  return kind === "pdf" ? extractPdfText(buf) : extractDocxText(buf);
}

/** Splits text into overlapping ~1000-char chunks (200-char overlap) so a chunk near a
 * boundary still retrieves alongside its neighbor's context. */
export function chunkText(text: string, size = 1000, overlap = 200): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  const step = size - overlap;
  for (let start = 0; start < trimmed.length; start += step) {
    const chunk = trimmed.slice(start, start + size).trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= trimmed.length) break;
  }
  return chunks;
}
