import { expect } from "chai";
import crypto from "crypto";
import { describe, it, before, after, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";

const DIMS = 1536;

/** Unit-ish vector with the given non-zero components; everything else 0. */
function vec(components: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, value] of Object.entries(components)) v[Number(i)] = value;
  return v;
}

// Query vector points along axis 0. `near` is identical, `mid` is ~45° off, `citation` and
// `report` are orthogonal — so vector-only order is near, mid, then nothing (orthogonal chunks
// sit below the 0.3 floor in scoped searches). Only `citation` and `report` carry the exact
// references the lexical side extracts from the question ("Brackenmoor Holdings", D01, para. 25);
// `citation` carries all three so it outranks `report` lexically.
const queryEmbedding = vec({ 0: 1 });
const CITATION_QUERY = "Does D01 para. 25 or Brackenmoor Holdings v Aksoy settle the scope of the duty of care?";

describe("DocumentChunkRepo hybrid retrieval", () => {
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const mainDocId = crypto.randomUUID();
  const reportDocId = crypto.randomUUID();
  const nearId = crypto.randomUUID();
  const midId = crypto.randomUUID();
  const citationId = crypto.randomUUID();
  const reportChunkId = crypto.randomUUID();
  const originalFlag = process.env.HYBRID_RETRIEVAL_ENABLED;

  async function insertChunk(caseDocumentId: string, id: string, index: number, text: string, embedding: number[]) {
    const literal = `[${embedding.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", embedding, "createdAt")
      VALUES (${id}, ${caseDocumentId}, ${index}, ${text}, ${text.length}, ${literal}::vector, now())
    `;
  }

  // Setup/teardown are ~10 round-trips to a remote Postgres; mocha's 2s default is too tight.
  before(async function () {
    this.timeout(30_000);
    const tenant = await prisma.tenant.upsert({
      where: { code: "UK" },
      update: {},
      create: { code: "UK", name: "United Kingdom" },
    });
    await prisma.user.create({
      data: { id: userId, email: `test-${userId}@example.com`, username: `test-${userId}` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Test Org", slug: `test-org-${organizationId}`, tenantId: tenant.id, createdById: userId },
    });
    await prisma.case.create({ data: { id: caseId, userId, organizationId, caseName: "Hybrid Test Case" } });
    await prisma.document.createMany({
      data: [
        { id: mainDocId, userId, organizationId, caseId, name: "Main.pdf", ragStatus: "READY" },
        { id: reportDocId, userId, organizationId, caseId, name: "Report.pdf", ragStatus: "READY" },
      ],
    });
    await insertChunk(mainDocId, nearId, 0, "The claimant slipped on the wet floor near the loading bay.", vec({ 0: 1 }));
    await insertChunk(mainDocId, midId, 1, "The loading bay floor was wet because the drain had blocked.", vec({ 0: 0.7, 1: 0.7 }));
    await insertChunk(
      mainDocId,
      citationId,
      2,
      "Judgment in [2019] UKSC 41, Brackenmoor Holdings v Aksoy (see D01 para. 25), on the scope of the duty of care.",
      vec({ 2: 1 }),
    );
    await insertChunk(
      reportDocId,
      reportChunkId,
      0,
      "Brackenmoor Holdings annual report, prepared after the judgment was handed down.",
      vec({ 3: 1 }),
    );
  });

  after(async function () {
    this.timeout(30_000);
    if (originalFlag === undefined) delete process.env.HYBRID_RETRIEVAL_ENABLED;
    else process.env.HYBRID_RETRIEVAL_ENABLED = originalFlag;
    await prisma.$executeRaw`DELETE FROM "CaseDocumentChunk" WHERE "caseDocumentId" IN (${mainDocId}, ${reportDocId})`;
    await prisma.document.deleteMany({ where: { id: { in: [mainDocId, reportDocId] } } });
    await prisma.case.delete({ where: { id: caseId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  afterEach(() => {
    delete process.env.HYBRID_RETRIEVAL_ENABLED;
  });

  describe("findRelevantByDocument (single document)", () => {
    it("flag off: returns vector-only order, citation chunk last", async () => {
      const ids = await DocumentChunkRepo.findRelevantByDocument(mainDocId, queryEmbedding, CITATION_QUERY, 3);
      expect(ids).to.deep.equal([nearId, midId, citationId]);
    });

    it("flag on: lexical match lifts the citation chunk to the top despite a poor vector rank", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const ids = await DocumentChunkRepo.findRelevantByDocument(mainDocId, queryEmbedding, CITATION_QUERY, 3);
      expect(ids[0]).to.equal(citationId);
      expect(ids).to.have.members([nearId, midId, citationId]);
    });

    it("flag on with a blank query: falls back to vector-only order", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const ids = await DocumentChunkRepo.findRelevantByDocument(mainDocId, queryEmbedding, "   ", 3);
      expect(ids).to.deep.equal([nearId, midId, citationId]);
    });

    it("flag on with no lexical matches: vector order is unchanged", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const ids = await DocumentChunkRepo.findRelevantByDocument(mainDocId, queryEmbedding, "zzqx nonexistent", 3);
      expect(ids).to.deep.equal([nearId, midId, citationId]);
    });

    it("flag on but lexical search throws: degrades to vector-only instead of failing", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const original = DocumentChunkRepo.lexicalIdsByDocument;
      DocumentChunkRepo.lexicalIdsByDocument = async () => {
        throw new Error("simulated: column missing");
      };
      try {
        const ids = await DocumentChunkRepo.findRelevantByDocument(mainDocId, queryEmbedding, CITATION_QUERY, 3);
        expect(ids).to.deep.equal([nearId, midId, citationId]);
      } finally {
        DocumentChunkRepo.lexicalIdsByDocument = original;
      }
    });
  });

  describe("findRelevantByCase (case portfolio, per-document floor 2)", () => {
    it("flag off: only chunks above the similarity floor, so the lexical-only document contributes nothing", async () => {
      const rows = await DocumentChunkRepo.findRelevantByCase(caseId, queryEmbedding, CITATION_QUERY, 2);
      expect(rows.map((r) => r.id)).to.deep.equal([nearId, midId]);
    });

    it("flag on: a lexical match takes a floor slot in its document and a lexical-only document now surfaces", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const rows = await DocumentChunkRepo.findRelevantByCase(caseId, queryEmbedding, CITATION_QUERY, 2);
      const ids = rows.map((r) => r.id);
      expect(ids).to.include(citationId);
      expect(ids).to.include(reportChunkId);
      expect(ids).to.not.include(midId);
      expect(rows.find((r) => r.id === reportChunkId)?.caseDocumentId).to.equal(reportDocId);
    });

    it("flag on with a blank query: identical to flag off", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const rows = await DocumentChunkRepo.findRelevantByCase(caseId, queryEmbedding, " ", 2);
      expect(rows.map((r) => r.id)).to.deep.equal([nearId, midId]);
    });

    it("flag on, startRank pages past each document's fused top slice", async () => {
      process.env.HYBRID_RETRIEVAL_ENABLED = "true";
      const page2 = await DocumentChunkRepo.findRelevantByCase(caseId, queryEmbedding, CITATION_QUERY, 2, prisma, 3);
      // Main doc's fused order is near, citation, mid — rank 3 is mid. Report doc has one chunk.
      expect(page2.map((r) => r.id)).to.deep.equal([midId]);
    });
  });
});
