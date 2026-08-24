import { expect } from "chai";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";

function vectorLiteral(primary: number): string {
  const values = new Array(1536).fill(0);
  values[0] = primary;
  return `[${values.join(",")}]`;
}

describe("Case document embedding isolation", () => {
  const userId = crypto.randomUUID();
  const caseAId = crypto.randomUUID();
  const caseBId = crypto.randomUUID();
  const docAId = crypto.randomUUID();
  const docBId = crypto.randomUUID();
  const chunkAId = crypto.randomUUID();
  const chunkBId = crypto.randomUUID();

  before(async () => {
    await prisma.user.create({
      data: { id: userId, email: `iso-${userId}@example.com`, username: `iso-${userId}` },
    });
    await prisma.case.createMany({
      data: [
        { id: caseAId, userId, caseName: "Isolation Case A" },
        { id: caseBId, userId, caseName: "Isolation Case B" },
      ],
    });
    await prisma.document.createMany({
      data: [
        { id: docAId, userId, caseId: caseAId, name: "A.pdf", ragStatus: "READY" },
        { id: docBId, userId, caseId: caseBId, name: "B.pdf", ragStatus: "READY" },
      ],
    });

    const textA = "UNIQUE_TOKEN_CASE_A_CRUZ_CONTRACT";
    const textB = "UNIQUE_TOKEN_CASE_B_OTHER_MATTER";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", embedding, "createdAt")
       VALUES ($1, $2, 0, $3, $4, $5::vector, now()), ($6, $7, 0, $8, $9, $10::vector, now())`,
      chunkAId,
      docAId,
      textA,
      textA.length,
      vectorLiteral(1),
      chunkBId,
      docBId,
      textB,
      textB.length,
      vectorLiteral(0.99),
    );
  });

  after(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "CaseDocumentChunk" WHERE id IN ($1, $2)`,
      chunkAId,
      chunkBId,
    );
    await prisma.document.deleteMany({ where: { id: { in: [docAId, docBId] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseAId, caseBId] } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("does not return another case's chunks even when those embeddings are nearer the query", async () => {
    const queryEmbedding = new Array(1536).fill(0);
    queryEmbedding[0] = 1;

    const rows = await DocumentChunkRepo.findRelevantByCase(caseAId, queryEmbedding, 20);
    expect(rows.map((r) => r.id)).to.deep.equal([chunkAId]);
    expect(rows.map((r) => r.caseDocumentId)).to.deep.equal([docAId]);
  });

  it("ranks only the requested case when querying case B", async () => {
    const queryEmbedding = new Array(1536).fill(0);
    queryEmbedding[0] = 1;

    const rows = await DocumentChunkRepo.findRelevantByCase(caseBId, queryEmbedding, 20);
    expect(rows.map((r) => r.id)).to.deep.equal([chunkBId]);
  });
});
