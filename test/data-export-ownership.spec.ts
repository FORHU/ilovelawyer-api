/** A user's export may only hand over what they own. Runs against the real database, like the
 * organization specs: creates its own people, organizations, cases and documents, and removes them. */
import crypto from "crypto";
import { Readable } from "stream";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import JSZip from "jszip";
import prisma from "../src/lib/prisma";
import DataExportSvc, { type ExportFileSource } from "../src/services/data-export.service";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";

describe("DataExportSvc ownership: a user can only take out what they own", () => {
  // Three people, because a person belongs to one organization at a time:
  //   owner  - OWNER of "Owned" (plus a personal portfolio), whose export is checked first
  //   member - plain MEMBER of "Foreign" (plus a personal portfolio), checked second
  //   other  - OWNER of "Foreign", who wrote the colleague cases
  const owner = crypto.randomUUID();
  const member = crypto.randomUUID();
  const other = crypto.randomUUID();
  const tag = crypto.randomUUID().slice(0, 8);
  const people = [owner, member, other];
  const fileIds: string[] = [];
  let opened: string[] = [];
  type Exported = { notice: string; data: Record<string, Array<Record<string, unknown>>> };
  type Result = { json: Exported; files: string[]; opened: string[] };
  let asOwner: Result;
  let asMember: Result;

  const storage: ExportFileSource = {
    open: async (key) => {
      opened.push(key);
      return { body: Readable.from([Buffer.from(`bytes of ${key}`)]), contentLength: 20 };
    },
  };
  const names = (e: Result, model: string, field: string) => (e.json.data[model] ?? []).map((row) => String(row[field]));

  async function exportFor(userId: string): Promise<Result> {
    opened = [];
    const chunks: Buffer[] = [];
    await DataExportSvc.streamZip(userId, (chunk) => void chunks.push(chunk), storage);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks), { checkCRC32: true });
    return {
      json: JSON.parse(await zip.file("data.json")!.async("string")) as Exported,
      files: Object.keys(zip.files).filter((n) => n.startsWith("files/")),
      opened: [...opened],
    };
  }

  before(async () => {
    for (const id of people) await prisma.user.create({ data: { id, email: `own-${id}@example.com`, username: `own-${id}` } });

    const ownedOrg = await OrganizationSvc.create(owner, `Owned ${tag}`, undefined, "PH");
    const foreignOrg = await OrganizationSvc.create(other, `Foreign ${tag}`, undefined, "PH");
    await OrganizationMemberRepo.add(foreignOrg.id, member, "MEMBER");
    // Personal portfolios aren't memberships: they are owned by whoever created them.
    const portfolio = (userId: string, name: string) =>
      prisma.organization.create({
        data: { name: `${name} ${tag}`, slug: `p-${userId.slice(0, 8)}-${tag}`, createdById: userId, isPersonal: true, tenantId: ownedOrg.tenantId },
      });
    const ownerPortfolio = await portfolio(owner, "Owner portfolio");
    const memberPortfolio = await portfolio(member, "Member portfolio");

    const makeCase = (name: string, userId: string, organizationId: string, confidential = false) =>
      prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseName: `${name} ${tag}`, confidential } });
    const ownerPortfolioCase = await makeCase("OWNER PORTFOLIO case", owner, ownerPortfolio.id);
    const colleagueCase = await makeCase("OWNED-ORG case by colleague", other, ownedOrg.id);
    await makeCase("OWNED-ORG confidential case", other, ownedOrg.id, true);
    const memberPortfolioCase = await makeCase("MEMBER PORTFOLIO case", member, memberPortfolio.id);
    const memberCaseInForeign = await makeCase("MEMBER-CREATED case in foreign org", member, foreignOrg.id);
    const sharedCase = await makeCase("SHARED-WITH-MEMBER case", other, foreignOrg.id);
    await makeCase("FOREIGN-ORG case by owner", other, foreignOrg.id);
    await prisma.caseAccess.create({ data: { caseId: sharedCase.id, userId: member, permission: "EDIT" } });

    const makeDoc = async (name: string, userId: string, organizationId: string, caseId: string | null) => {
      const file = await prisma.file.create({ data: { filename: `${name}.txt`, s3Key: `own-test/${tag}/${name.replace(/\W+/g, "-")}.txt` } });
      fileIds.push(file.id);
      return prisma.document.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseId, name: `${name} ${tag}`, fileId: file.id } });
    };
    await makeDoc("OWNER doc in portfolio case", owner, ownerPortfolio.id, ownerPortfolioCase.id);
    await makeDoc("OWNER doc in owned org no case", owner, ownedOrg.id, null);
    await makeDoc("OWNER doc in colleague case", owner, ownedOrg.id, colleagueCase.id);
    await makeDoc("MEMBER doc in portfolio", member, memberPortfolio.id, memberPortfolioCase.id);
    await makeDoc("MEMBER doc in foreign org no case", member, foreignOrg.id, null);
    await makeDoc("MEMBER doc in own case in foreign org", member, foreignOrg.id, memberCaseInForeign.id);
    await makeDoc("MEMBER doc in shared case", member, foreignOrg.id, sharedCase.id);

    const chat = (title: string, userId: string, organizationId: string) =>
      prisma.consultation.create({ data: { id: crypto.randomUUID(), userId, organizationId, title: `${title} ${tag}` } });
    await chat("OWNER chat in owned org", owner, ownedOrg.id);
    await chat("MEMBER chat in foreign org", member, foreignOrg.id);
    await chat("MEMBER chat in portfolio", member, memberPortfolio.id);

    asOwner = await exportFor(owner);
    asMember = await exportFor(member);
  });

  after(async () => {
    await prisma.document.deleteMany({ where: { name: { endsWith: tag } } });
    await prisma.consultation.deleteMany({ where: { title: { endsWith: tag } } });
    await prisma.caseAccess.deleteMany({ where: { userId: { in: people } } });
    await prisma.case.deleteMany({ where: { caseName: { endsWith: tag } } });
    await prisma.file.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: people } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
  });

  describe("an organization owner", () => {
    it("exports their portfolio and every case of the organization they own, confidential ones included", () => {
      expect(names(asOwner, "Case", "caseName").sort()).to.deep.equal(
        [`OWNER PORTFOLIO case ${tag}`, `OWNED-ORG case by colleague ${tag}`, `OWNED-ORG confidential case ${tag}`].sort(),
      );
    });

    it("exports documents and chats from organizations they own", () => {
      expect(names(asOwner, "Document", "name").sort()).to.deep.equal(
        [`OWNER doc in portfolio case ${tag}`, `OWNER doc in owned org no case ${tag}`, `OWNER doc in colleague case ${tag}`].sort(),
      );
      expect(names(asOwner, "Consultation", "title")).to.deep.equal([`OWNER chat in owned org ${tag}`]);
      expect(asOwner.files).to.have.length(3);
    });

    it("never touches another organization's cases", () => {
      expect(names(asOwner, "Case", "caseName").join("|")).to.not.match(/FOREIGN|MEMBER|SHARED/);
    });
  });

  describe("a plain member who is not the owner", () => {
    it("exports only their own portfolio's case, not the ones they created in the organization, were shared, or the owner wrote", () => {
      expect(names(asMember, "Case", "caseName")).to.deep.equal([`MEMBER PORTFOLIO case ${tag}`]);
    });

    it("exports only the documents in their portfolio, none from the organization", () => {
      expect(names(asMember, "Document", "name")).to.deep.equal([`MEMBER doc in portfolio ${tag}`]);
    });

    it("exports only the chat in their portfolio", () => {
      expect(names(asMember, "Consultation", "title")).to.deep.equal([`MEMBER chat in portfolio ${tag}`]);
    });

    it("does not even read the files of what was left out", () => {
      expect(asMember.opened.map((k) => k.split("/").pop())).to.deep.equal(["MEMBER-doc-in-portfolio.txt"]);
      expect(asMember.files).to.have.length(1);
    });

    it("leaves no trace of the organization's cases anywhere in the file", () => {
      const text = JSON.stringify(asMember.json);
      for (const word of ["MEMBER-CREATED", "SHARED-WITH-MEMBER", "FOREIGN-ORG case", "foreign org"]) {
        expect(text, `"${word}" must not be in the member's export`).to.not.include(word);
      }
    });

    it("tells them what was left out and why", () => {
      expect(asMember.json.notice).to.include("do not own");
    });
  });
});
