import axios from "axios";
import UserDocumentRepo from "../repositories/user-document.repository";
import UserDocumentChunkRepo from "../repositories/user-document-chunk.repository";
import { getPresignedDownloadUrl } from "../utils/s3";
import { sniffFileKind, extractText, chunkText } from "../utils/document-extraction";
import { embedText } from "../utils/embedding";
import logger from "../utils/logger";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

interface ExtractableDocument {
  id: string;
  s3Key: string | null;
  name: string;
}

export default class DocumentExtractionSvc {
  /** Fire-and-forget: fetches the Document's bytes fresh from S3, extracts text, chunks and
   * embeds it, and stores the chunks. Any failure — fetch error, oversized file, a file that
   * isn't actually a PDF/DOCX despite its claimed type, extraction error, embedding error —
   * marks the Document FAILED, logs it, and stops. No retry, no error surfaced to the user;
   * this mirrors how the Document simply stays without RAG context if extraction never
   * succeeds. */
  static async process(doc: ExtractableDocument): Promise<void> {
    try {
      if (!doc.s3Key) throw new Error("Document has no s3Key");

      const url = await getPresignedDownloadUrl(doc.s3Key);
      const res = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
      const buf = Buffer.from(res.data);

      if (buf.byteLength > MAX_FILE_BYTES) {
        throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes (${buf.byteLength})`);
      }

      const kind = sniffFileKind(buf);
      if (!kind) {
        throw new Error("File is not a recognizable PDF or DOCX");
      }

      const text = await extractText(buf, kind);
      const chunks = chunkText(text);
      if (!chunks.length) {
        throw new Error("No extractable text");
      }

      const embedded = await Promise.all(
        chunks.map(async (chunk, chunkIndex) => ({
          chunkIndex,
          chunkText: chunk,
          charCount: chunk.length,
          embedding: await embedText(chunk),
        })),
      );

      await UserDocumentChunkRepo.insertMany(doc.id, embedded);
      await UserDocumentRepo.updateRagStatus(doc.id, "READY");
    } catch (err) {
      logger.error("Document extraction failed", { err, documentId: doc.id, name: doc.name });
      await UserDocumentRepo.updateRagStatus(doc.id, "FAILED").catch(() => {});
    }
  }
}
