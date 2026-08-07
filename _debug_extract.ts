import prisma from "./src/lib/prisma";
import DocumentExtractionSvc from "./src/services/document-extraction.service";

(async () => {
  const documentId = process.argv[2];
  await DocumentExtractionSvc.process(documentId);
  const doc = await prisma.caseDocument.findUnique({ where: { id: documentId } });
  console.log("ragStatus:", doc?.ragStatus);
  const [summary] = await prisma.$queryRawUnsafe<{ chunk_count: bigint; embedded_count: bigint }[]>(
    `SELECT count(*) AS chunk_count, count(embedding) AS embedded_count FROM "CaseDocumentChunk" WHERE "caseDocumentId" = $1`,
    documentId,
  );
  console.log("chunks:", Number(summary.chunk_count), "embedded:", Number(summary.embedded_count));
  await prisma.$disconnect();
})();
