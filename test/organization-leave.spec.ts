import { expect } from "chai";
import crypto from "crypto";
import { describe, it, after } from "mocha";
import prisma from "../src/lib/prisma";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import CaseAccess from "../src/utils/case-access";
import CaseSvc from "../src/services/case.service";

async function makeUser(createdUserIds: string[]) {
  const userId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: userId, email: `leave-${userId}@example.com`, username: `leave-${userId}` },
  });
  createdUserIds.push(userId);
  return userId;
}

async function makeCase(userId: string, organizationId: string) {
  return prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId, caseName: "Leave Case" } });
}

describe("Leaving an organization", () => {
  const createdUserIds: string[] = [];

  after(async () => {
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("removes the membership, so org-scoped routes reject the user, and lands them in their portfolio", async () => {
    const ownerId = await makeUser(createdUserIds);
    const memberId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Ivy Firm", undefined, "PH");
    await OrganizationMemberRepo.add(firm.id, memberId, "MEMBER");

    await OrganizationSvc.leave(firm.id, memberId);

    const err = await OrganizationSvc.requireMembership(firm.id, memberId).catch((e) => e);
    expect(err.statusCode).to.equal(403);
    const orgs = await OrganizationSvc.listForUser(memberId);
    expect(orgs).to.have.length(1);
    expect(orgs[0].isPersonal).to.equal(true);
  });

  it("revokes the user's per-case grants on the org's cases, and only those", async () => {
    const ownerId = await makeUser(createdUserIds);
    const otherOwnerId = await makeUser(createdUserIds);
    const memberId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Jo Firm", undefined, "PH");
    const otherFirm = await OrganizationSvc.create(otherOwnerId, "Kit Firm", undefined, "PH");
    await OrganizationMemberRepo.add(firm.id, memberId, "MEMBER");

    const firmCase = await makeCase(ownerId, firm.id);
    const otherCase = await makeCase(otherOwnerId, otherFirm.id);
    await prisma.caseAccess.createMany({
      data: [
        { caseId: firmCase.id, userId: memberId, permission: "EDIT" },
        { caseId: otherCase.id, userId: memberId, permission: "VIEW" },
      ],
    });

    await OrganizationSvc.leave(firm.id, memberId);

    const err = await CaseAccess.loadAccessibleCase(firmCase.id, memberId).catch((e) => e);
    expect(err.statusCode).to.equal(404);
    const remaining = await prisma.caseAccess.findMany({ where: { userId: memberId } });
    expect(remaining.map((a) => a.caseId)).to.deep.equal([otherCase.id]);
  });

  it("keeps a case the leaver created accessible to the members who remain", async () => {
    const ownerId = await makeUser(createdUserIds);
    const creatorId = await makeUser(createdUserIds);
    const memberId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Max Firm", undefined, "PH");
    await OrganizationMemberRepo.add(firm.id, creatorId, "MEMBER");
    await OrganizationMemberRepo.add(firm.id, memberId, "MEMBER");
    const firmCase = await makeCase(creatorId, firm.id);

    await OrganizationSvc.leave(firm.id, creatorId);

    const listed = await CaseSvc.list(firm.id, memberId, 1, 50);
    expect(listed.data.map((c) => c.id)).to.include(firmCase.id);
    expect((await CaseSvc.getById(firmCase.id, firm.id)).id).to.equal(firmCase.id);
    expect((await CaseAccess.loadAccessibleCase(firmCase.id, memberId)).id).to.equal(firmCase.id);
    expect((await CaseAccess.assertCanEdit(firmCase.id, ownerId)).id).to.equal(firmCase.id);
  });

  it("revokes per-case grants when an admin removes the member too", async () => {
    const ownerId = await makeUser(createdUserIds);
    const memberId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Lee Firm", undefined, "PH");
    await OrganizationMemberRepo.add(firm.id, memberId, "MEMBER");
    const firmCase = await makeCase(ownerId, firm.id);
    await prisma.caseAccess.create({ data: { caseId: firmCase.id, userId: memberId, permission: "VIEW" } });

    await OrganizationSvc.removeMember(firm.id, "OWNER", ownerId, memberId);

    expect(await prisma.caseAccess.count({ where: { userId: memberId } })).to.equal(0);
  });
});
