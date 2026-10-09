/** Document text is stored sealed (#343): every CaseDocumentChunk.chunkText, for every document,
 * while field encryption is on. Everything that reads it (BM25 ranking, chat, Chat Wonder's
 * document fetch) must still get readable text, vector search must still work, and the Redis
 * copy must not keep the text readable.
 *
 * Runs against the real local database and Redis, creating its own rows and removing them, like
 * test/data-export.spec.ts. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import * as config from "../src/config";
import OrganizationSvc from "../src/services/organization.service";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";

const DIMENSIONS = 1536;
/** A unit vector along one axis, so similarity search has an unambiguous nearest neighbour. */
const axis = (i: number) => Array.from({ length: DIMENSIONS }, (_, d) => (d === i ? 1 : 0));

const TEXTS = [
  "The defendant admitted receiving the transfer on 3 May",
  "A forensic examination of the handset found no deleted messages",
  "Witness Carlo Mendoza signed the statement on 18 July",
];

describe("document chunk encryption (real database and Redis)", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const saved = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY, oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS };
  const KEY = crypto.randomBytes(32).toString("base64");
  const userId = crypto.randomUUID();
  let organizationId = "";
  let documentId = "";
  let chunkIds: string[] = [];

  const rawTexts = async () =>
    (await prisma.$queryRaw<{ chunkText: string }[]>`SELECT "chunkText" FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${documentId} ORDER BY "chunkIndex" ASC`).map((r) => r.chunkText);

  const insertChunks = async () => {
    await DocumentChunkRepo.deleteByDocument(documentId);
    await DocumentChunkRepo.insertMany(TEXTS.map((chunkText, i) => ({ caseDocumentId: documentId, chunkIndex: i, chunkText, charCount: chunkText.length, embedding: axis(i), pageNumber: i + 1 })));
    chunkIds = await DocumentChunkRepo.findIdsByDocument(documentId);
  };

  before(async () => {
    await prisma.user.create({ data: { id: userId, email: `chunk-enc-${userId}@example.com`, username: `chunk-enc-${userId}` } });
    organizationId = (await OrganizationSvc.create(userId, "Chunk Enc Firm", undefined, "PH")).id;
    const caseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseName: "Chunk Enc Case" } })).id;
    documentId = (await prisma.document.create({ data: { userId, organizationId, caseId, name: "statement.txt" } })).id;
  });

  beforeEach(async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = true;
    cfg.FIELD_ENCRYPTION_KEY = KEY;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = undefined;
    await redis.del(`case_document_chunks:${documentId}`);
    await insertChunks();
  });

  after(async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = saved.enabled;
    cfg.FIELD_ENCRYPTION_KEY = saved.key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = saved.oldKeys;
    await redis.del(`case_document_chunks:${documentId}`);
    await prisma.document.deleteMany({ where: { userId } });
    await prisma.case.deleteMany({ where: { userId } });
    await prisma.organizationMember.deleteMany({ where: { userId } });
    await prisma.organization.deleteMany({ where: { createdById: userId } });
    await prisma.auditEvent.deleteMany({ where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("stores every chunk sealed, with none of the text readable in the table", async () => {
    const stored = await rawTexts();
    expect(stored).to.have.length(3);
    for (const value of stored) expect(value.startsWith("enc1:")).to.equal(true);
    const everything = stored.join(" ");
    for (const word of ["defendant", "forensic", "Mendoza"]) expect(everything).to.not.include(word);
  });

  it("stores plain text while the switch is off", async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = false;
    await insertChunks();
    expect(await rawTexts()).to.deep.equal(TEXTS);
  });

  it("returns readable text from every reader", async () => {
    const byDocument = await DocumentChunkRepo.findByDocument(documentId);
    expect(byDocument.map((c) => c.chunkText)).to.deep.equal(TEXTS);
    expect(byDocument.map((c) => c.charCount)).to.deep.equal(TEXTS.map((t) => t.length));

    const byIds = await DocumentChunkRepo.findTextsByIds([chunkIds[2]!, chunkIds[0]!]);
    expect(byIds.map((c) => c.chunkText)).to.deep.equal([TEXTS[2], TEXTS[0]]);

    expect(await DocumentChunkRepo.findTextsByPage(documentId, 2)).to.deep.equal([TEXTS[1]]);
    expect((await DocumentChunkRepo.findFullTextsByDocuments([documentId])).get(documentId)).to.equal(TEXTS.join("\n"));
  });

  it("keeps vector search working, because embeddings are not sealed", async () => {
    const nearest = await DocumentChunkRepo.findRelevantByDocument(documentId, axis(1), 1);
    expect(nearest).to.deep.equal([chunkIds[1]]);
  });

  it("lets BM25 rank the chunks by a word in their readable text", async () => {
    const ranked = await DocumentChunkSvc.listByDocument(documentId, "forensic handset deleted messages");
    expect(ranked.chunks[0]!.chunkText).to.equal(TEXTS[1]);
    const other = await DocumentChunkSvc.listByDocument(documentId, "Mendoza signed statement");
    expect(other.chunks[0]!.chunkText).to.equal(TEXTS[2]);
  });

  it("does not leave readable document text in the Redis cache", async () => {
    await redis.del(`case_document_chunks:${documentId}`);
    const served = await DocumentChunkSvc.listByDocument(documentId);
    expect(served.chunks.map((c) => c.chunkText)).to.deep.equal(TEXTS);

    const cached = await redis.get<{ chunks: { chunkText: string }[] }>(`case_document_chunks:${documentId}`);
    expect(cached, "the document should be cached").to.not.equal(null);
    expect(cached!.chunks.every((c) => c.chunkText.startsWith("enc1:"))).to.equal(true);

    const again = await DocumentChunkSvc.listByDocument(documentId); // served from the cache
    expect(again.chunks.map((c) => c.chunkText)).to.deep.equal(TEXTS);
  });

  it("reads a chunk it can no longer open as empty text instead of failing the whole document", async () => {
    cfg.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); // the old key is lost
    const chunks = await DocumentChunkRepo.findByDocument(documentId);
    expect(chunks.map((c) => c.chunkText)).to.deep.equal(["", "", ""]);
  });

  it("opens chunks sealed under an earlier key after rotation", async () => {
    cfg.FIELD_ENCRYPTION_OLD_KEYS = KEY;
    cfg.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect((await DocumentChunkRepo.findByDocument(documentId)).map((c) => c.chunkText)).to.deep.equal(TEXTS);
  });

  it("refuses to store a chunk in the clear when it should seal and has no key", async () => {
    cfg.FIELD_ENCRYPTION_KEY = undefined;
    let error: Error | undefined;
    try {
      await insertChunks();
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/FIELD_ENCRYPTION_KEY/);
    expect(await rawTexts()).to.deep.equal([]); // deleteByDocument ran, nothing readable was written
  });
});
