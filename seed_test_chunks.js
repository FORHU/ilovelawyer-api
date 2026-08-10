const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const userId = crypto.randomUUID();
  const caseDocumentId = crypto.randomUUID();

  await prisma.user.create({
    data: { id: userId, email: `seed-${userId}@example.com`, username: `seed-${userId}` },
  });
  await prisma.caseDocument.create({
    data: { id: caseDocumentId, userId, name: 'Manual Test Document' },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", "createdAt")
     VALUES ($1, $2, 0, 'First chunk of text', 20, now()), ($3, $2, 1, 'Second chunk of text', 21, now())`,
    crypto.randomUUID(), caseDocumentId, crypto.randomUUID(),
  );

  console.log('caseDocumentId:', caseDocumentId);
  await prisma.$disconnect();
})();
