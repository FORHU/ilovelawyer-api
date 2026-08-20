import { AWS_ACCESS_KEY, AWS_REGION, AWS_SECRET_ACCESS_KEY } from "../config";
import logger from "./logger";

const TEXTRACT_SYNC_MAX_BYTES = 5 * 1024 * 1024;

type TextractBlock = { BlockType?: string; Text?: string };

export async function ocrPdf(buffer: Buffer): Promise<string> {
  if (!AWS_ACCESS_KEY || !AWS_SECRET_ACCESS_KEY) {
    logger.warn("OCR skipped: AWS credentials not configured");
    return "";
  }
  if (buffer.length > TEXTRACT_SYNC_MAX_BYTES) {
    logger.warn("OCR skipped: PDF exceeds Textract sync limit", { bytes: buffer.length });
    return "";
  }

  try {
    // Optional dependency — OCR is skipped if the client is not installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const textract = require("@aws-sdk/client-textract") as {
      TextractClient: new (cfg: object) => { send: (cmd: unknown) => Promise<{ Blocks?: TextractBlock[] }> };
      DetectDocumentTextCommand: new (input: object) => unknown;
    };
    const client = new textract.TextractClient({
      region: AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: AWS_ACCESS_KEY,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
    const result = await client.send(
      new textract.DetectDocumentTextCommand({
        Document: { Bytes: buffer },
      }),
    );
    const lines = (result.Blocks ?? [])
      .filter((block: TextractBlock) => block.BlockType === "LINE" && block.Text)
      .map((block: TextractBlock) => block.Text as string);
    return lines.join("\n");
  } catch (err) {
    logger.warn("OCR via Textract failed", { err });
    return "";
  }
}
