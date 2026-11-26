import { expect } from "chai";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";
import { ownScope } from "../src/utils/workspace";
import CaseRepo from "../src/repositories/case.repository";
import CaseCopySvc from "../src/services/case-copy.service";
import CaseSeedSvc from "../src/services/case-seed.service";

describe("CaseSeedSvc", () => {
  const createdUserIds: string[] = [];
  const copiedKeys: [string, string][] = [];
  const originalCopyObject = CaseCopySvc.copyObject;

  before(() => {
    CaseCopySvc.copyObject = async (from, to) => {
      copiedKeys.push([from, to]);
    };
  });

  after(async () => {
    CaseCopySvc.copyObject = originalCopyObject;
    const cases = await prisma.case.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
    const caseIds = cases.map((c) => c.id);
    const docs = await prisma.document.findMany({ where: { caseId: { in: caseIds } }, select: { fileId: true } });
    await prisma.document.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.file.deleteMany({ where: { id: { in: docs.map((d) => d.fileId!).filter(Boolean) } } });
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  async function makeUser(name?: string) {
    const userId = crypto.randomUUID();
    await prisma.user.create({
      data: { id: userId, name, email: `case-seed-${userId}@example.com`, username: `case-seed-${userId}`, tenant: { connect: { code: "PH" } } },
    });
    createdUserIds.push(userId);
    return userId;
  }

  describe("seed", () => {
    it("creates a new Case owned by the lawyer with the client case's summary fields copied", async () => {
      const clientId = await makeUser("Cara Client");
      const lawyerId = await makeUser("Leo Lawyer");
      const source = await CaseRepo.create(ownScope(clientId), clientId, {
        caseName: "Dispute with landlord",
        jurisdiction: "Manchester",
        ukJurisdiction: "England and Wales",
        caseAreas: ["HOUSING"],
        notes: "Deposit not returned.",
      });

      const { caseId } = await CaseSeedSvc.seed({ sourceCaseId: source.id, lawyerId, organizationId: null });

      const created = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(created.userId).to.equal(lawyerId);
      expect(created.organizationId).to.equal(null);
      expect(created.caseName).to.equal("Dispute with landlord");
      expect(created.jurisdiction).to.equal("Manchester");
      expect(created.ukJurisdiction).to.equal("England and Wales");
      expect(created.caseAreas).to.deep.equal(["HOUSING"]);
      expect(created.notes).to.equal("Deposit not returned.");
      expect(created.copiedFromCaseId).to.equal(source.id);
      expect(created.copiedAt).to.be.instanceOf(Date);
    });

    it("copies each document to a fresh File/Document row via CaseSeedSvc's S3 copy point", async () => {
      const clientId = await makeUser("Dana Client");
      const lawyerId = await makeUser("Dex Lawyer");
      const source = await CaseRepo.create(ownScope(clientId), clientId, { caseName: "Two documents" });
      const fileA = await prisma.file.create({ data: { filename: "a.pdf", s3Key: `documents/cases/${source.id}/1-aa.pdf` } });
      const fileB = await prisma.file.create({ data: { filename: "b.pdf", s3Key: `documents/cases/${source.id}/2-bb.pdf` } });
      const docA = await prisma.document.create({
        data: { userId: clientId, caseId: source.id, name: "a.pdf", fileId: fileA.id, documentType: "EVIDENCE", fileSize: 100, mimeType: "application/pdf" },
      });
      const docB = await prisma.document.create({
        data: { userId: clientId, caseId: source.id, name: "b.pdf", fileId: fileB.id, documentType: "EVIDENCE", fileSize: 200, mimeType: "application/pdf" },
      });

      const before = copiedKeys.length;
      const { caseId } = await CaseSeedSvc.seed({ sourceCaseId: source.id, lawyerId, organizationId: null });

      const calls = copiedKeys.slice(before);
      expect(calls).to.have.lengthOf(2);
      const sources = calls.map(([from]) => from).sort();
      expect(sources).to.deep.equal([fileA.s3Key, fileB.s3Key].sort());
      const destinations = calls.map(([, to]) => to);
      expect(new Set(destinations).size).to.equal(2);
      for (const to of destinations) expect(to).to.match(new RegExp(`^documents/cases/${caseId}/.+\\.pdf$`));

      const copiedDocs = await prisma.document.findMany({ where: { caseId }, include: { file: true } });
      expect(copiedDocs).to.have.lengthOf(2);
      expect(copiedDocs.map((d) => d.userId)).to.deep.equal([lawyerId, lawyerId]);
      expect(copiedDocs.map((d) => d.id)).to.not.include(docA.id);
      expect(copiedDocs.map((d) => d.id)).to.not.include(docB.id);
      expect(copiedDocs.map((d) => d.name).sort()).to.deep.equal(["a.pdf", "b.pdf"]);
      for (const d of copiedDocs) {
        expect(d.fileId).to.not.be.oneOf([fileA.id, fileB.id]);
        expect(d.file?.s3Key).to.not.be.oneOf([fileA.s3Key, fileB.s3Key]);
      }
    });

    it("skips a document whose source file can't be read instead of throwing", async () => {
      const clientId = await makeUser("Eve Client");
      const lawyerId = await makeUser("Finn Lawyer");
      const source = await CaseRepo.create(ownScope(clientId), clientId, { caseName: "One good, one bad" });
      const goodFile = await prisma.file.create({ data: { filename: "good.pdf", s3Key: `documents/cases/${source.id}/1-gg.pdf` } });
      const badFile = await prisma.file.create({ data: { filename: "bad.pdf", s3Key: `documents/cases/${source.id}/2-bb.pdf` } });
      await prisma.document.create({ data: { userId: clientId, caseId: source.id, name: "good.pdf", fileId: goodFile.id } });
      await prisma.document.create({ data: { userId: clientId, caseId: source.id, name: "bad.pdf", fileId: badFile.id } });

      const stashed = CaseCopySvc.copyObject;
      CaseCopySvc.copyObject = async (from, to) => {
        if (from === badFile.s3Key) throw new Error("object not found");
        copiedKeys.push([from, to]);
      };

      let caseId: string;
      try {
        ({ caseId } = await CaseSeedSvc.seed({ sourceCaseId: source.id, lawyerId, organizationId: null }));
      } finally {
        CaseCopySvc.copyObject = stashed;
      }

      const copiedDocs = await prisma.document.findMany({ where: { caseId } });
      expect(copiedDocs).to.have.lengthOf(1);
      expect(copiedDocs[0].name).to.equal("good.pdf");
      const created = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(created.copiedFromCaseId).to.equal(source.id);
    });
  });
});
