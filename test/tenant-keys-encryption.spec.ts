/** The Singapore server holds PH, ph-dev and uk-dev data in one database (#343). With a key for each
 * tenant, a document or evidence note is sealed with the key of the tenant whose organization owns
 * it, and everything is still readable on that one server. Real database, own rows, removed afterwards. */
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
const keyIdOf = (base64Key: string) => crypto.createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 8);
const idInside = (sealed: string) => sealed.split(":")[1];

describe("per-tenant keys on one server (real database)", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const saved = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY, oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS, tenantKeys: cfg.FIELD_ENCRYPTION_TENANT_KEYS };
  const PH_KEY = crypto.randomBytes(32).toString("base64");
  const UK_KEY = crypto.randomBytes(32).toString("base64");
  const phUser = crypto.randomUUID();
  const ukUser = crypto.randomUUID();
  const soloUser = crypto.randomUUID();
  let phDoc = "", ukDoc = "", phCase = "", ukCase = "", soloCase = "";

  /** The Singapore server's settings: the PH key is the default, UK has its own. */
  const singapore = () => {
    cfg.FIELD_ENCRYPTION_ENABLED = true;
    cfg.FIELD_ENCRYPTION_KEY = PH_KEY;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = undefined;
    cfg.FIELD_ENCRYPTION_TENANT_KEYS = { PH: undefined, UK: UK_KEY };
  };
  const off = () => {
    cfg.FIELD_ENCRYPTION_ENABLED = false;
    cfg.FIELD_ENCRYPTION_KEY = undefined;
    cfg.FIELD_ENCRYPTION_TENANT_KEYS = { PH: undefined, UK: undefined };
  };
  const rawChunk = async (documentId: string) => (await prisma.$queryRaw<{ chunkText: string }[]>`SELECT "chunkText" FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${documentId} ORDER BY "chunkIndex" LIMIT 1`)[0]!.chunkText;
  const insert = (documentId: string, text: string) => DocumentChunkRepo.insertMany([{ caseDocumentId: documentId, chunkIndex: 0, chunkText: text, charCount: text.length, embedding: axis(0), pageNumber: 1 }]);

  before(async () => {
    for (const id of [phUser, ukUser, soloUser]) await prisma.user.create({ data: { id, email: `tk-${id}@example.com`, username: `tk-${id}` } });
    const phOrg = await OrganizationSvc.create(phUser, "PH Firm", undefined, "PH");
    const ukOrg = await OrganizationSvc.create(ukUser, "UK Firm", undefined, "UK");
    phCase = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId: phUser, organizationId: phOrg.id, caseName: "PH case" } })).id;
    ukCase = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId: ukUser, organizationId: ukOrg.id, caseName: "UK case" } })).id;
    soloCase = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId: soloUser, caseName: "Personal case, no organization" } })).id;
    phDoc = (await prisma.document.create({ data: { userId: phUser, organizationId: phOrg.id, caseId: phCase, name: "ph.txt" } })).id;
    ukDoc = (await prisma.document.create({ data: { userId: ukUser, organizationId: ukOrg.id, caseId: ukCase, name: "uk.txt" } })).id;
  });

  beforeEach(async () => {
    off();
    for (const id of [phDoc, ukDoc]) await DocumentChunkRepo.deleteByDocument(id);
    await prisma.evidenceMatrixItem.deleteMany({ where: { caseId: { in: [phCase, ukCase, soloCase] } } });
    singapore();
  });

  after(async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = saved.enabled;
    cfg.FIELD_ENCRYPTION_KEY = saved.key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = saved.oldKeys;
    cfg.FIELD_ENCRYPTION_TENANT_KEYS = saved.tenantKeys;
    const users = [phUser, ukUser, soloUser];
    await prisma.document.deleteMany({ where: { userId: { in: users } } });
    await prisma.case.deleteMany({ where: { userId: { in: users } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: users } } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  describe("document text", () => {
    it("seals a UK document with the UK key and a PH document with the default (PH) key", async () => {
      await insert(phDoc, "ph document text");
      await insert(ukDoc, "uk document text");
      expect(idInside(await rawChunk(phDoc))).to.equal(keyIdOf(PH_KEY));
      expect(idInside(await rawChunk(ukDoc))).to.equal(keyIdOf(UK_KEY));
    });

    it("reads both back on the same server", async () => {
      await insert(phDoc, "ph document text");
      await insert(ukDoc, "uk document text");
      expect((await DocumentChunkRepo.findByDocument(phDoc)).map((c) => c.chunkText)).to.deep.equal(["ph document text"]);
      expect((await DocumentChunkRepo.findByDocument(ukDoc)).map((c) => c.chunkText)).to.deep.equal(["uk document text"]);
    });

    it("a server that has only the PH key cannot open the UK document, which is the separation the keys give", async () => {
      await insert(ukDoc, "uk document text");
      cfg.FIELD_ENCRYPTION_TENANT_KEYS = { PH: undefined, UK: undefined };
      expect((await DocumentChunkRepo.findByDocument(ukDoc)).map((c) => c.chunkText)).to.deep.equal([""]);
    });

    it("a server with one key makes no tenant lookup and seals everything with it", async () => {
      cfg.FIELD_ENCRYPTION_TENANT_KEYS = { PH: undefined, UK: undefined };
      await insert(ukDoc, "uk document text");
      expect(idInside(await rawChunk(ukDoc))).to.equal(keyIdOf(PH_KEY));
    });

    it("refuses to store a UK chunk when the UK key is not valid, and does not use the PH key instead", async () => {
      cfg.FIELD_ENCRYPTION_TENANT_KEYS = { PH: undefined, UK: "not-a-key" };
      let error: Error | undefined;
      try { await insert(ukDoc, "uk document text"); } catch (e) { error = e as Error; }
      expect(error?.message).to.match(/FIELD_ENCRYPTION_KEY_UK/);
      await insert(phDoc, "ph document text"); // the PH tenant is not affected
      expect(idInside(await rawChunk(phDoc))).to.equal(keyIdOf(PH_KEY));
    });
  });

  describe("privileged evidence notes", () => {
    const itemOf = async (caseId: string) => (await prisma.evidenceMatrixItem.findFirst({ where: { caseId }, include: { custodyEvents: true } }))!;

    it("seals notes and custody notes with the key of the tenant that owns the case", async () => {
      for (const [caseId, text] of [[phCase, "ph note"], [ukCase, "uk note"]] as const) {
        const item = await EvidenceRepo.upsertMatrix(caseId, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: text });
        await EvidenceRepo.addCustodyEvent(item.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: `${text} custody` });
      }
      const ph = await itemOf(phCase);
      const uk = await itemOf(ukCase);
      expect(idInside(ph.notes!)).to.equal(keyIdOf(PH_KEY));
      expect(idInside(ph.custodyEvents[0]!.notes!)).to.equal(keyIdOf(PH_KEY));
      expect(idInside(uk.notes!)).to.equal(keyIdOf(UK_KEY));
      expect(idInside(uk.custodyEvents[0]!.notes!)).to.equal(keyIdOf(UK_KEY));
    });

    it("reads both back as plain text", async () => {
      await EvidenceRepo.upsertMatrix(ukCase, crypto.randomUUID(), { privilegeStatus: "WORK_PRODUCT", notes: "uk note" });
      expect((await EvidenceRepo.listMatrix(ukCase))[0]!.notes).to.equal("uk note");
    });

    it("a personal case with no organization uses the default key", async () => {
      await EvidenceRepo.upsertMatrix(soloCase, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "personal note" });
      expect(idInside((await itemOf(soloCase)).notes!)).to.equal(keyIdOf(PH_KEY));
    });
  });

  describe("the backfill scripts", () => {
    it("seal each document with its own tenant's key, and reverse puts both back", async () => {
      off(); // stored the old way, as plain text
      await insert(phDoc, "ph document text");
      await insert(ukDoc, "uk document text");
      singapore();

      const result = await backfillChunks({ apply: true }, quiet);
      expect(result.changed).to.be.at.least(2);
      expect(idInside(await rawChunk(phDoc))).to.equal(keyIdOf(PH_KEY));
      expect(idInside(await rawChunk(ukDoc))).to.equal(keyIdOf(UK_KEY));

      cfg.FIELD_ENCRYPTION_ENABLED = false; // keys stay, so everything can be opened
      await backfillChunks({ apply: true, reverse: true }, quiet);
      expect(await rawChunk(phDoc)).to.equal("ph document text");
      expect(await rawChunk(ukDoc)).to.equal("uk document text");
    });

    it("seal privileged notes with the right key for each tenant", async () => {
      off();
      const ph = await EvidenceRepo.upsertMatrix(phCase, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "ph note" });
      const uk = await EvidenceRepo.upsertMatrix(ukCase, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: "uk note" });
      singapore();
      await backfillNotes({ apply: true }, quiet);
      expect(idInside((await prisma.evidenceMatrixItem.findUnique({ where: { id: ph.id } }))!.notes!)).to.equal(keyIdOf(PH_KEY));
      expect(idInside((await prisma.evidenceMatrixItem.findUnique({ where: { id: uk.id } }))!.notes!)).to.equal(keyIdOf(UK_KEY));
    });
  });
});
