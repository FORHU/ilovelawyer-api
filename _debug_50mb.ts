import prisma from "./src/lib/prisma";
import UserDocumentRepo from "./src/repositories/user-document.repository";
import { getObjectBuffer } from "./src/utils/s3";
import { extractText } from "./src/utils/document-text-extraction";
import { chunkText } from "./src/utils/chunking";
import { embedText } from "./src/utils/embedding";

(async () => {
  const documentId = process.argv[2];
  try {
    const doc = await UserDocumentRepo.findByIdWithFile(documentId);
    console.log("doc:", doc?.name, doc?.mimeType, doc?.fileSize, doc?.file?.s3Key);
    console.time("s3");
    const buffer = await getObjectBuffer(doc!.file!.s3Key as string);
    console.timeEnd("s3");
    console.log("buffer size:", buffer.length);
    console.time("extract");
    const text = await extractText(buffer, doc!.mimeType!, doc!.name);
    console.timeEnd("extract");
    console.log("text length:", text.trim().length);
    const chunks = chunkText(text.trim());
    console.log("chunks:", chunks.length);
  } catch (err: any) {
    console.error("ERROR message:", err?.message);
    console.error("ERROR name:", err?.name);
    console.error("ERROR stack:", err?.stack);
    console.error("full:", err);
  } finally {
    await prisma.$disconnect();
  }
})();
