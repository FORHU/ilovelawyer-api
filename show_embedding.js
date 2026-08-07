const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const documentId = process.argv[2];
if (!documentId) {
  console.error('Usage: node show_embedding.js <caseDocumentId>');
  process.exit(1);
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, "chunkIndex", embedding::text AS embedding_text
     FROM "CaseDocumentChunk"
     WHERE "caseDocumentId" = $1
     ORDER BY "chunkIndex"`,
    documentId,
  );

  for (const row of rows) {
    const vec = JSON.parse(row.embedding_text); // pgvector ::text -> "[0.1,-0.2,...]"
    console.log(`chunk ${row.chunkIndex} (id=${row.id})`);
    console.log(`  dimensions: ${vec.length}`);
    console.log(`  first 8 values: [${vec.slice(0, 8).map((v) => v.toFixed(5)).join(', ')}, ...]`);
    console.log(`  magnitude: ${Math.sqrt(vec.reduce((s, v) => s + v * v, 0)).toFixed(4)}`);
  }

  await prisma.$disconnect();
})();
