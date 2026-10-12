/** The two backfill scripts (#343), forward and reverse: they seal what was stored before field
 * encryption was turned on, and can put it all back. Real database, own rows, removed afterwards.
 * The scripts' own safety rules are what is checked: a dry run changes nothing, a run can be
 * repeated, a document filter stays inside its document, and sealed text that cannot be opened
 * is left exactly as it is. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import OrganizationSvc from "../src/services/organization.service";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import { encryptField } from "../src/utils/field-crypto";
import { backfillChunks } from "../src/scripts/encrypt-document-chunks";
import { backfillNotes } from "../src/scripts/encrypt-privileged-notes";

const axis = (i: number) => Array.from({ length: 1536 }, (_, d) => (d === i ? 1 : 0));
const quiet = () => {};

describe("backfill scripts (real database)", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const saved = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY, oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS };
  const KEY = crypto.randomBytes(32).toString("base64");
  const userId = crypto.randomUUID();
  let organizationId = "";
  let caseId = "";
  let docA = "";
  let docB = "";
  const A_TEXTS = ["alpha one", "alpha two", "alpha three"];
  const B_TEXTS = ["bravo one", "bravo two"];

  const set = (enabled: boolean, key: string | undefined, oldKeys?: string) => {
    cfg.FIELD_ENCRYPTION_ENABLED = enabled;
    cfg.FIELD_ENCRYPTION_KEY = key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = oldKeys;
  };
  const raw = async (documentId: string) =>
    (await prisma.$queryRaw<{ chunkText: string }[]>`SELECT "chunkText" FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${documentId} ORDER BY "chunkIndex"`).map((r) => r.chunkText);
  const sealedCount = async (documentId: string) => (await raw(documentId)).filter((t) => t.startsWith("enc1:")).length;
  const embeddings = async (documentId: string) =>
    Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(embedding) AS n FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${documentId}`)[0]!.n);

  before(async () => {
    await prisma.user.create({ data: { id: userId, email: `backfill-${userId}@example.com`, username: `backfill-${userId}` } });
    organizationId = (await OrganizationSvc.create(userId, "Backfill Firm", undefined, "PH")).id;
    caseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseName: "Backfill Case" } })).id;
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
    // Stored the old way: plain, because sealing was off when they were written.
    beforeEach(async () => {
      set(false, undefined);
      for (const [documentId, texts] of [[docA, A_TEXTS], [docB, B_TEXTS]] as const) {
        await DocumentChunkRepo.deleteByDocument(documentId);
        await DocumentChunkRepo.insertMany(texts.map((chunkText, i) => ({ caseDocumentId: documentId, chunkIndex: i, chunkText, charCount: chunkText.length, embedding: axis(i), pageNumber: 1 })));
      }
      set(true, KEY);
    });

    it("a dry run reports what it would seal and changes nothing", async () => {
      const result = await backfillChunks({ apply: false, documentId: docA }, quiet);
      expect(result).to.deep.equal({ matched: 3, changed: 0, unreadable: 0 });
      expect(await raw(docA)).to.deep.equal(A_TEXTS);
    });

    it("seals only the document it is limited to, keeps the embeddings, and reads back plain", async () => {
      const result = await backfillChunks({ apply: true, documentId: docA }, quiet);
      expect(result).to.deep.equal({ matched: 3, changed: 3, unreadable: 0 });
      expect(await sealedCount(docA)).to.equal(3);
      expect(await raw(docB)).to.deep.equal(B_TEXTS);
      expect(await embeddings(docA)).to.equal(3);
      expect((await DocumentChunkRepo.findByDocument(docA)).map((c) => c.chunkText)).to.deep.equal(A_TEXTS);
    });

    it("can be run again and does nothing the second time", async () => {
      await backfillChunks({ apply: true, documentId: docA }, quiet);
      expect(await backfillChunks({ apply: true, documentId: docA }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 0 });
    });

    it("reverse puts the text back exactly as it was, only for the document asked for", async () => {
      await backfillChunks({ apply: true }, quiet); // seals both documents
      expect(await sealedCount(docA)).to.equal(3);
      expect(await sealedCount(docB)).to.equal(2);

      set(false, KEY); // the switch off, the key still there so the text can be opened
      const dry = await backfillChunks({ apply: false, reverse: true, documentId: docA }, quiet);
      expect(dry.matched).to.equal(3);
      expect(await sealedCount(docA)).to.equal(3);

      const result = await backfillChunks({ apply: true, reverse: true, documentId: docA }, quiet);
      expect(result).to.deep.equal({ matched: 3, changed: 3, unreadable: 0 });
      expect(await raw(docA)).to.deep.equal(A_TEXTS);
      expect(await sealedCount(docB)).to.equal(2); // the other document is untouched
      expect(await embeddings(docA)).to.equal(3);
    });

    it("reverse leaves a chunk it cannot open exactly as it is", async () => {
      await backfillChunks({ apply: true, documentId: docA }, quiet);
      const before = await raw(docA);
      set(false, crypto.randomBytes(32).toString("base64")); // the key that sealed them is lost
      const result = await backfillChunks({ apply: true, reverse: true, documentId: docA }, quiet);
      expect(result).to.deep.equal({ matched: 0, changed: 0, unreadable: 3 });
      expect(await raw(docA)).to.deep.equal(before);
    });

    it("reverse works with a rotated key once the old one is listed", async () => {
      await backfillChunks({ apply: true, documentId: docA }, quiet);
      set(false, crypto.randomBytes(32).toString("base64"), KEY);
      const result = await backfillChunks({ apply: true, reverse: true, documentId: docA }, quiet);
      expect(result.changed).to.equal(3);
      expect(await raw(docA)).to.deep.equal(A_TEXTS);
    });

    it("refuses to run, and changes nothing, when it is not configured for what was asked", async () => {
      set(false, undefined);
      let sealError = "";
      try { await backfillChunks({ apply: true, documentId: docA }, quiet); } catch (e) { sealError = (e as Error).message; }
      expect(sealError).to.match(/FIELD_ENCRYPTION_ENABLED=true/);
      let reverseError = "";
      try { await backfillChunks({ apply: true, reverse: true, documentId: docA }, quiet); } catch (e) { reverseError = (e as Error).message; }
      expect(reverseError).to.match(/FIELD_ENCRYPTION_KEY/);
      expect(await raw(docA)).to.deep.equal(A_TEXTS);
    });

    it("warns when reversing while the switch is still on", async () => {
      await backfillChunks({ apply: true, documentId: docA }, quiet);
      const lines: string[] = [];
      await backfillChunks({ apply: false, reverse: true, documentId: docA }, (l) => lines.push(l));
      expect(lines.join(" ")).to.match(/new uploads will be sealed again/);
    });
  });

  describe("privileged notes", () => {
    let privilegedId = "";
    let ordinaryId = "";
    const noteOf = async (id: string) => (await prisma.evidenceMatrixItem.findUnique({ where: { id }, include: { custodyEvents: true } }))!;

    beforeEach(async () => {
      await prisma.evidenceMatrixItem.deleteMany({ where: { caseId } });
      set(false, undefined); // stored the old way
      const privileged = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "privileged note" });
      await EvidenceRepo.addCustodyEvent(privileged.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "custody note" });
      const ordinary = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { notes: "ordinary note" });
      privilegedId = privileged.id;
      ordinaryId = ordinary.id;
      set(true, KEY);
    });

    it("a dry run changes nothing", async () => {
      const result = await backfillNotes({ apply: false }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 0, failed: 0, unreadable: 0 });
      expect((await noteOf(privilegedId)).notes).to.equal("privileged note");
    });

    it("seals the privileged item's notes and custody notes and leaves the ordinary item alone", async () => {
      const result = await backfillNotes({ apply: true }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 1, failed: 0, unreadable: 0 });
      const privileged = await noteOf(privilegedId);
      expect(privileged.notes!.startsWith("enc1:")).to.equal(true);
      expect(privileged.custodyEvents[0]!.notes!.startsWith("enc1:")).to.equal(true);
      expect((await noteOf(ordinaryId)).notes).to.equal("ordinary note");
      expect(await backfillNotes({ apply: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, failed: 0, unreadable: 0 });
    });

    it("reverse puts every sealed note back to plain text, including a sealed note on a non-privileged item", async () => {
      await backfillNotes({ apply: true }, quiet);
      await prisma.evidenceMatrixItem.update({ where: { id: ordinaryId }, data: { notes: encryptField("ordinary note", "EvidenceMatrixItem.notes") } });

      set(false, KEY);
      const dry = await backfillNotes({ apply: false, reverse: true }, quiet);
      expect(dry.matched).to.equal(2);
      expect((await noteOf(privilegedId)).notes!.startsWith("enc1:")).to.equal(true);

      const result = await backfillNotes({ apply: true, reverse: true }, quiet);
      expect(result).to.deep.equal({ matched: 2, changed: 2, failed: 0, unreadable: 0 });
      const privileged = await noteOf(privilegedId);
      expect(privileged.notes).to.equal("privileged note");
      expect(privileged.custodyEvents[0]!.notes).to.equal("custody note");
      expect((await noteOf(ordinaryId)).notes).to.equal("ordinary note");
    });

    it("reverse leaves notes it cannot open exactly as they are", async () => {
      await backfillNotes({ apply: true }, quiet);
      const before = (await noteOf(privilegedId)).notes;
      set(false, crypto.randomBytes(32).toString("base64")); // the key is lost
      const result = await backfillNotes({ apply: true, reverse: true }, quiet);
      expect(result.changed).to.equal(0);
      expect(result.unreadable).to.equal(2); // the item's note and its custody note
      expect((await noteOf(privilegedId)).notes).to.equal(before);
    });

    it("refuses to run when it is not configured for what was asked", async () => {
      set(false, undefined);
      let message = "";
      try { await backfillNotes({ apply: true }, quiet); } catch (e) { message = (e as Error).message; }
      expect(message).to.match(/FIELD_ENCRYPTION_ENABLED=true/);
    });
  });
});
