/** DataExportSvc — the "export my data" document. The first block needs no database; the second
 * runs against the real one like the organization specs, creating its own rows and removing them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import { Readable } from "stream";
import JSZip from "jszip";
import { Prisma } from "@prisma/client";
import prisma from "../src/lib/prisma";
import DataExportSvc, { EXPORT_EXCLUDED_MODELS, planExport, type ExportFileSource } from "../src/services/data-export.service";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import CaseAccess from "../src/utils/case-access";
import EvidenceRepo from "../src/repositories/evidence.repository";
import * as config from "../src/config";

const models = Prisma.dmmf.datamodel.models;

describe("planExport (schema coverage)", () => {
  const plan = planExport("user-1");
  const planned = new Set(plan.map((s) => s.model));

  it("includes every table that points at a user, so a new one can't be forgotten", () => {
    const pointsAtUser = models
      .filter((m) => m.name !== "User" && m.fields.some((f) => f.kind === "object" && f.type === "User" && (f.relationFromFields?.length ?? 0) > 0))
      .map((m) => m.name);
    const missing = pointsAtUser.filter((name) => !planned.has(name) && !EXPORT_EXCLUDED_MODELS.has(name));
    expect(missing, `tables pointing at User but missing from the export: ${missing.join(", ")}`).to.deep.equal([]);
  });

  it("only excludes tables that exist", () => {
    const names = new Set(models.map((m) => m.name));
    for (const excluded of EXPORT_EXCLUDED_MODELS) expect(names.has(excluded), `${excluded} is not a model`).to.equal(true);
  });

  it("never exports sessions (credentials)", () => {
    expect(planned.has("Session")).to.equal(false);
  });

  it("limits case tables to cases the user owns", () => {
    const claims = plan.find((s) => s.model === "CaseClaim");
    expect(claims?.where).to.deep.equal({ case: CaseAccess.ownedWhere("user-1") });
    expect(plan.find((s) => s.model === "Case")?.where).to.deep.equal(CaseAccess.ownedWhere("user-1"));
  });

  it("does not take a user's documents, recordings or chats out of an organization they don't own", () => {
    for (const model of ["Document", "Transcription", "Consultation"]) {
      const where = JSON.stringify(plan.find((s) => s.model === model)?.where);
      expect(where, `${model} must be limited to owned organizations`).to.include(JSON.stringify(CaseAccess.ownedOrganizationWhere("user-1")));
    }
  });

  it("limits a chat message to the consultation it sits in, so it can't leave through a case the user lost", () => {
    const where = JSON.stringify(plan.find((s) => s.model === "Message")?.where);
    expect(where).to.include(JSON.stringify(CaseAccess.ownedWhere("user-1")));
  });

  it("limits a user's audit events to the ones they caused", () => {
    const audit = plan.find((s) => s.model === "AuditEvent");
    expect(audit?.where).to.deep.equal({ actorId: "user-1" });
  });
});

describe("DataExportSvc.stream (real database)", () => {
  const userId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const email = `export-${userId}@example.com`;
  const createdUserIds = [userId, strangerId];
  let ownCaseId = "";
  let strangerCaseId = "";
  let output = "";
  let counts: Record<string, number> = {};
  const cfg = config as unknown as Record<string, unknown>;
  const savedEncryption = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY };
  const PRIVILEGED_NOTE = "Client admitted the transfer was a gift";

  before(async () => {
    await prisma.user.create({ data: { id: userId, email, username: `export-${userId}`, password: "bcrypt-hash-must-not-leak" } });
    await prisma.user.create({ data: { id: strangerId, email: `export-${strangerId}@example.com`, username: `export-${strangerId}` } });

    const org = await OrganizationSvc.create(userId, "Export Firm", undefined, "PH");
    ownCaseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId: org.id, caseName: "My Own Case" } })).id;
    // The stranger's case sits in the stranger's own organization, not one the user owns (an owner
    // is entitled to every case in their organization, which the ownership block below covers).
    const strangerOrg = await OrganizationSvc.create(strangerId, "Stranger Firm", undefined, "PH");
    strangerCaseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId: strangerId, organizationId: strangerOrg.id, caseName: "Someone Else's Case" } })).id;

    // A privileged evidence note is stored sealed; the export must hand the person the readable text.
    cfg.FIELD_ENCRYPTION_ENABLED = true;
    cfg.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    await EvidenceRepo.upsertMatrix(ownCaseId, crypto.randomUUID(), { privilegeStatus: "ATTORNEY_CLIENT", notes: PRIVILEGED_NOTE });

    await prisma.consent.create({ data: { userId, purpose: "MARKETING", version: "2026-10", grantedAt: new Date(), source: "settings" } });
    await prisma.session.create({ data: { userId, refreshToken: `refresh-${userId}`, expiresAt: new Date(Date.now() + 3600_000) } });
    await prisma.auditEvent.create({ data: { actorId: userId, action: "auth.login", payload: { method: "password" } } });
    await prisma.auditEvent.create({ data: { actorId: strangerId, action: "auth.login", payload: { method: "password" } } });

    counts = await DataExportSvc.stream(userId, (chunk) => {
      output += chunk;
    });
  });

  after(async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = savedEncryption.enabled;
    cfg.FIELD_ENCRYPTION_KEY = savedEncryption.key;
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: createdUserIds } } });
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("hands over privileged evidence notes as readable text, though they are stored sealed", async () => {
    const row = await prisma.evidenceMatrixItem.findFirst({ where: { caseId: ownCaseId } });
    expect(row?.notes?.startsWith("enc1:")).to.equal(true);
    const exported = JSON.parse(output).data.EvidenceMatrixItem as { notes: string }[];
    expect(exported.map((r) => r.notes)).to.deep.equal([PRIVILEGED_NOTE]);
    expect(output).to.not.include("enc1:");
  });

  it("writes one valid JSON document", () => {
    const parsed = JSON.parse(output);
    expect(parsed).to.have.keys(["exportedAt", "user", "notice", "data"]);
    expect(parsed.user).to.include({ id: userId, email });
  });

  it("includes the user's own rows and counts them", () => {
    const { data } = JSON.parse(output);
    expect(data.Case.map((c: { id: string }) => c.id)).to.deep.equal([ownCaseId]);
    expect(data.Consent).to.have.length(1);
    expect(data.AuditEvent).to.have.length(1);
    expect(counts.Case).to.equal(1);
  });

  it("leaves out other people's rows", () => {
    expect(output).to.not.include(strangerCaseId);
    expect(output).to.not.include("Someone Else's Case");
  });

  it("leaves out credentials: the password hash, and the whole Session table", () => {
    expect(output).to.not.include("bcrypt-hash-must-not-leak");
    expect(output).to.not.include(`refresh-${userId}`);
    expect(JSON.parse(output).data).to.not.have.property("Session");
  });
});

describe("DataExportSvc.streamZip (real database, fake file storage)", () => {
  const userId = crypto.randomUUID();
  const email = `export-zip-${userId}@example.com`;
  const goodKey = `export-test/${userId}/contract.txt`;
  const brokenKey = `export-test/${userId}/missing.txt`;
  const fileIds: string[] = [];
  let archive: JSZip;
  let result: { filesIncluded: number; filesSkipped: number };

  const storage: ExportFileSource = {
    open: async (key) => {
      if (key === goodKey) return { body: Readable.from([Buffer.from("FICTIONAL contract text, "), Buffer.from("two chunks")]), contentLength: 35 };
      throw new Error("NoSuchKey");
    },
  };

  before(async () => {
    const avatar = await prisma.file.create({ data: { filename: "contract.txt", s3Key: goodKey } });
    const broken = await prisma.file.create({ data: { filename: "missing.txt", s3Key: brokenKey } });
    fileIds.push(avatar.id, broken.id);
    // The avatar link is the simplest way to make a File belong to this user without building a case.
    await prisma.user.create({ data: { id: userId, email, username: `export-zip-${userId}`, name: "Zip Tester", avatarId: avatar.id } });
    // A second file the user owns (a recording), whose bytes can't be read.
    const org = await OrganizationSvc.create(userId, "Zip Export Firm", undefined, "PH");
    await prisma.transcription.create({ data: { userId, organizationId: org.id, audioFileId: broken.id } });

    const chunks: Buffer[] = [];
    result = await DataExportSvc.streamZip(userId, (chunk) => void chunks.push(chunk), storage);
    archive = await JSZip.loadAsync(Buffer.concat(chunks), { checkCRC32: true });
  });

  after(async () => {
    await prisma.transcription.deleteMany({ where: { userId } });
    await prisma.organizationMember.deleteMany({ where: { userId } });
    await prisma.organization.deleteMany({ where: { createdById: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.file.deleteMany({ where: { id: { in: fileIds } } });
  });

  it("contains the data record, the readable report and the user's file", () => {
    const names = Object.keys(archive.files);
    expect(names).to.include("data.json");
    expect(names).to.include("README.pdf");
    expect(names.some((n) => n.startsWith("files/") && n.endsWith("-contract.txt"))).to.equal(true);
  });

  it("writes the file's bytes unchanged, even when storage hands them over in pieces", async () => {
    const name = Object.keys(archive.files).find((n) => n.endsWith("-contract.txt"))!;
    expect(await archive.file(name)!.async("string")).to.equal("FICTIONAL contract text, two chunks");
  });

  it("produces a real PDF report", async () => {
    const pdf = await archive.file("README.pdf")!.async("nodebuffer");
    expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
    expect(pdf.length).to.be.greaterThan(1000);
  });

  it("keeps data.json valid and about this user", async () => {
    const doc = JSON.parse(await archive.file("data.json")!.async("string"));
    expect(doc.user).to.include({ id: userId, email });
  });

  it("leaves out a file it cannot read, and still finishes", () => {
    expect(result.filesIncluded).to.equal(1);
    expect(result.filesSkipped, "the unreadable file must have been seen and skipped, not just never attached").to.equal(1);
    expect(Object.keys(archive.files).some((n) => n.includes("missing.txt"))).to.equal(false);
  });
});
