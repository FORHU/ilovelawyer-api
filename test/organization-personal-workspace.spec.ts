import { expect } from "chai";
import crypto from "crypto";
import { describe, it, after } from "mocha";
import prisma from "../src/lib/prisma";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";

async function makeUser(createdUserIds: string[], role: "USER" | "LAWYER" = "USER") {
  const userId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: userId, role, email: `personal-${userId}@example.com`, username: `personal-${userId}` },
  });
  createdUserIds.push(userId);
  return userId;
}

// A personal workspace is a client-app account's (ClientCaseSvc.workspaceFor). A lawyer never gets
// one: a solo lawyer has no organization at all (docs/adr/0022, test/solo-lawyer.spec.ts).
describe("Personal workspace (client-app accounts)", () => {
  const createdUserIds: string[] = [];

  after(async () => {
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("creates a personal SOLO workspace, and a retried request returns the same one", async () => {
    const userId = await makeUser(createdUserIds);

    const first = await OrganizationSvc.create(userId, "Ana", undefined, "PH", true);
    expect(first.isPersonal).to.equal(true);
    expect(first.packageSku).to.equal("SOLO");

    const second = await OrganizationSvc.create(userId, "Ana", undefined, "PH", true);
    expect(second.id).to.equal(first.id);
  });

  it("is never made for a lawyer", async () => {
    const lawyerId = await makeUser(createdUserIds, "LAWYER");

    const err = await OrganizationSvc.create(lawyerId, "Lee", undefined, "PH", true).catch((e) => e);
    expect(err.statusCode).to.equal(400);
    expect(err.code).to.equal("SOLO_HAS_NO_ORGANIZATION");
    expect(await prisma.organization.count({ where: { createdById: lawyerId } })).to.equal(0);
  });

  it("refuses to create a second organization for someone already in a real one", async () => {
    const userId = await makeUser(createdUserIds);
    await OrganizationSvc.create(userId, "Cora Firm", undefined, "PH");

    const err = await OrganizationSvc.create(userId, "Another", undefined, "PH").catch((e) => e);
    expect(err.statusCode).to.equal(409);
  });

  it("can't be left", async () => {
    const userId = await makeUser(createdUserIds);
    const personal = await OrganizationSvc.create(userId, "Dan", undefined, "PH", true);

    const err = await OrganizationSvc.leave(personal.id, userId).catch((e) => e);
    expect(err.statusCode).to.equal(400);
  });

  it("stays active while an invite is pending, and declining leaves it as it was", async () => {
    const ownerId = await makeUser(createdUserIds);
    const inviteeId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Eve Firm", undefined, "PH");
    const personal = await OrganizationSvc.create(inviteeId, "Finn", undefined, "PH", true);

    await OrganizationInviteRepo.create(firm.id, inviteeId, "MEMBER");
    expect((await OrganizationMemberRepo.findAnyForUser(inviteeId))?.organizationId).to.equal(personal.id);

    await OrganizationSvc.declineInvite(firm.id, inviteeId);
    expect((await OrganizationMemberRepo.findAnyForUser(inviteeId))?.organizationId).to.equal(personal.id);
  });
});
