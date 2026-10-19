/** --rekey on the two backfill scripts: data sealed under two different keys ends up under ONE key
 * and is readable with that key alone. Real database, own rows, removed afterwards. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import OrganizationSvc from "../src/services/organization.service";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import { backfillChunks } from "../src/scripts/encrypt-document-chunks";
import { backfillNotes } from "../src/scripts/encrypt-privileged-notes";

const axis = (i: number) => Array.from({ length: 1536 }, (_, d) => (d === i ? 1 : 0));
const quiet = () => {};
const idOf = (key: string) => crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);
const idInside = (sealed: string) => sealed.split(":")[1];

describe("--rekey puts everything under one key (real database)", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const saved = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY, oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS };
  const ONE = crypto.randomBytes(32).toString("base64"); // the key that stays
  const OTHER = crypto.randomBytes(32).toString("base64"); // an earlier key
  const userId = crypto.randomUUID();
  let caseId = "", docA = "", docB = "";

  const set = (enabled: boolean, key: string | undefined, oldKeys?: string) => {
    cfg.FIELD_ENCRYPTION_ENABLED = enabled;
    cfg.FIELD_ENCRYPTION_KEY = key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = oldKeys;
  };
  const rawChunks = async (documentId: string) => (await prisma.$queryRaw<{ chunkText: string }[]>`SELECT "chunkText" FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${documentId} ORDER BY "chunkIndex"`).map((r) => r.chunkText);
  const insert = (documentId: string, texts: string[]) =>
    DocumentChunkRepo.insertMany(texts.map((chunkText, i) => ({ caseDocumentId: documentId, chunkIndex: i, chunkText, charCount: chunkText.length, embedding: axis(i), pageNumber: 1 })));

  before(async () => {
    await prisma.user.create({ data: { id: userId, email: `rekey-${userId}@example.com`, username: `rekey-${userId}` } });
    const organizationId = (await OrganizationSvc.create(userId, "Rekey Firm", undefined, "PH")).id;
    caseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseName: "Rekey Case" } })).id;
    docA = (await prisma.document.create({ data: { userId, organizationId, caseId, name: "a.txt" } })).id;
    docB = (await prisma.document.create({ data: { userId, organizationId, caseId, name: "b.txt" } })).id;
  });

  after(async () => {
    set(saved.enabled as boolean, saved.key as string | undefined, saved.oldKeys as string | undefined);
    await prisma.document.deleteMany({ where: { userId } });
    await prisma.case.deleteMany({ where: { userId } });
    await prisma.organizationMember.deleteMany({ where: { userId } });
    await prisma.organization.deleteMany({ where: { createdById: userId } });
    await prisma.auditEvent.deleteMany({ where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  describe("document chunks", () => {
    // Every run is limited to docB (--document), the one sealed under the earlier key: a developer's
    // database holds real chunks sealed under their own key, which these throwaway keys can't open,
    // and a whole-table run would count them as unreadable. docA, under the one key, is never picked
    // up by --rekey either way.
    beforeEach(async () => {
      for (const d of [docA, docB]) await DocumentChunkRepo.deleteByDocument(d);
      set(true, ONE); await insert(docA, ["a one", "a two"]); // already under the one key
      set(true, OTHER); await insert(docB, ["b one", "b two", "b three"]); // under an earlier key
    });

    it("a dry run counts the chunks under the earlier key and changes nothing", async () => {
      set(true, ONE, OTHER);
      const before = await rawChunks(docB);
      expect(await backfillChunks({ documentId: docB,apply: false, rekey: true }, quiet)).to.deep.equal({ matched: 3, changed: 0, unreadable: 0 });
      expect(await rawChunks(docB)).to.deep.equal(before);
    });

    it("re-seals them under the one key, leaves the rest alone, and everything opens with that key alone", async () => {
      set(true, ONE, OTHER);
      const untouched = await rawChunks(docA);
      expect(await backfillChunks({ documentId: docB,apply: true, rekey: true }, quiet)).to.deep.equal({ matched: 3, changed: 3, unreadable: 0 });
      expect(await rawChunks(docA)).to.deep.equal(untouched);
      expect((await rawChunks(docB)).map(idInside)).to.deep.equal([idOf(ONE), idOf(ONE), idOf(ONE)]);
      set(true, ONE, undefined); // the earlier key is gone from the settings
      expect((await DocumentChunkRepo.findByDocument(docA)).map((c) => c.chunkText)).to.deep.equal(["a one", "a two"]);
      expect((await DocumentChunkRepo.findByDocument(docB)).map((c) => c.chunkText)).to.deep.equal(["b one", "b two", "b three"]);
    });

    it("keeps the embeddings and can be repeated", async () => {
      set(true, ONE, OTHER);
      await backfillChunks({ documentId: docB,apply: true, rekey: true }, quiet);
      const n = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(embedding) AS n FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${docB}`)[0]!.n);
      expect(n).to.equal(3);
      expect(await backfillChunks({ documentId: docB,apply: true, rekey: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 0 });
    });

    it("without the earlier key, counts those chunks as unreadable and leaves them exactly as they are", async () => {
      set(true, ONE, undefined);
      const before = await rawChunks(docB);
      expect(await backfillChunks({ documentId: docB,apply: true, rekey: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 3 });
      expect(await rawChunks(docB)).to.deep.equal(before);
    });

    it("refuses with no key, and refuses --reverse together with --rekey; nothing is changed", async () => {
      set(true, undefined, OTHER);
      let error: Error | undefined;
      try { await backfillChunks({ documentId: docB,apply: true, rekey: true }, quiet); } catch (e) { error = e as Error; }
      expect(error?.message).to.match(/FIELD_ENCRYPTION_KEY/);
      set(true, ONE, OTHER);
      error = undefined;
      try { await backfillChunks({ documentId: docB,apply: true, rekey: true, reverse: true }, quiet); } catch (e) { error = e as Error; }
      expect(error?.message).to.match(/not both/);
    });
  });

  describe("privileged notes", () => {
    it("re-seals the notes and custody notes sealed under the earlier key and leaves the others", async () => {
      await prisma.evidenceMatrixItem.deleteMany({ where: { caseId } });
      set(true, OTHER);
      const earlier = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "earlier note" });
      await EvidenceRepo.addCustodyEvent(earlier.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "earlier custody" });
      set(true, ONE);
      const current = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { privilegeStatus: "WORK_PRODUCT", notes: "current note" });
      const currentBefore = (await prisma.evidenceMatrixItem.findUnique({ where: { id: current.id } }))!.notes;

      set(true, ONE, OTHER);
      expect(await backfillNotes({ apply: false, rekey: true }, quiet)).to.include({ matched: 1, changed: 0, unreadable: 0 });
      expect(await backfillNotes({ apply: true, rekey: true }, quiet)).to.include({ matched: 1, changed: 1, failed: 0, unreadable: 0 });

      const item = (await prisma.evidenceMatrixItem.findUnique({ where: { id: earlier.id }, include: { custodyEvents: true } }))!;
      expect(idInside(item.notes!)).to.equal(idOf(ONE));
      expect(idInside(item.custodyEvents[0]!.notes!)).to.equal(idOf(ONE));
      expect((await prisma.evidenceMatrixItem.findUnique({ where: { id: current.id } }))!.notes).to.equal(currentBefore);

      set(true, ONE, undefined); // earlier key gone
      const listed = await EvidenceRepo.listMatrix(caseId);
      expect(listed.map((i) => i.notes).sort()).to.deep.equal(["current note", "earlier note"]);
      expect(await backfillNotes({ apply: true, rekey: true }, quiet)).to.include({ matched: 0, changed: 0 });
    });

    it("without the earlier key leaves the notes exactly as they are", async () => {
      await prisma.evidenceMatrixItem.deleteMany({ where: { caseId } });
      set(true, OTHER);
      const earlier = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "earlier note" });
      const before = (await prisma.evidenceMatrixItem.findUnique({ where: { id: earlier.id } }))!.notes;
      set(true, ONE, undefined);
      expect(await backfillNotes({ apply: true, rekey: true }, quiet)).to.include({ matched: 1, changed: 0, unreadable: 1 });
      expect((await prisma.evidenceMatrixItem.findUnique({ where: { id: earlier.id } }))!.notes).to.equal(before);
    });
  });
});
