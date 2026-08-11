const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const documentId = process.argv[2];
if (!documentId) {
  console.error('Usage: node check_chunks.js <caseDocumentId>');
  process.exit(1);
}

(async () => {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  console.log('Document.ragStatus:', doc?.ragStatus);

  const [summary] = await prisma.$queryRawUnsafe(
    `SELECT count(*) AS chunk_count, count(embedding) AS embedded_count FROM "CaseDocumentChunk" WHERE "caseDocumentId" = $1`,
    documentId,
  );
  console.log('chunk_count:', Number(summary.chunk_count), 'embedded_count:', Number(summary.embedded_count));

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, "chunkIndex", "charCount", left("chunkText", 60) AS preview, (embedding IS NOT NULL) AS has_embedding FROM "CaseDocumentChunk" WHERE "caseDocumentId" = $1 ORDER BY "chunkIndex" LIMIT 5`,
    documentId,
  );
  console.log('sample rows:', rows);

  await prisma.$disconnect();
})();
