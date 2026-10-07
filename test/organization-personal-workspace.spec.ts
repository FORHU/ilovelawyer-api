import { expect } from "chai";
import crypto from "crypto";
import { describe, it, after } from "mocha";
import prisma from "../src/lib/prisma";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";

async function makeUser(createdUserIds: string[]) {
  const userId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: userId, email: `personal-${userId}@example.com`, username: `personal-${userId}` },
  });
  createdUserIds.push(userId);
  return userId;
}

describe("Personal workspace (onboarding Skip)", () => {
  const createdUserIds: string[] = [];

  after(async () => {
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("creates a personal SOLO workspace, and a retried Skip returns the same one", async () => {
    const userId = await makeUser(createdUserIds);

    const first = await OrganizationSvc.create(userId, "Ana", undefined, "PH", true);
    expect(first.isPersonal).to.equal(true);
    expect(first.packageSku).to.equal("SOLO");

    const second = await OrganizationSvc.create(userId, "Ana", undefined, "PH", true);
    expect(second.id).to.equal(first.id);
  });

  it("stays behind as the portfolio when the user creates an organization", async () => {
    const userId = await makeUser(createdUserIds);
    const personal = await OrganizationSvc.create(userId, "Ben", undefined, "PH", true);

    const org = await OrganizationSvc.create(userId, "Ben Law Office", "PROFESSIONAL", "PH");
    expect(org.id).to.not.equal(personal.id);
    expect(org.isPersonal).to.equal(false);
    expect(org.name).to.equal("Ben Law Office");
    expect(org.packageSku).to.equal("PROFESSIONAL");
    const stillPersonal = await prisma.organization.findUniqueOrThrow({ where: { id: personal.id } });
    expect(stillPersonal.isPersonal).to.equal(true);
    expect((await OrganizationSvc.getPortfolio(userId)).id).to.equal(personal.id);
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

  it("is parked by accepting an invite, and restored when the user leaves that organization", async () => {
    const ownerId = await makeUser(createdUserIds);
    const inviteeId = await makeUser(createdUserIds);
    const firm = await OrganizationSvc.create(ownerId, "Gail Firm", undefined, "PH");
    const personal = await OrganizationSvc.create(inviteeId, "Hal", undefined, "PH", true);

    await OrganizationInviteRepo.create(firm.id, inviteeId, "MEMBER");
    await OrganizationSvc.acceptInvite(firm.id, inviteeId);
    expect((await OrganizationMemberRepo.findAnyForUser(inviteeId))?.organizationId).to.equal(firm.id);

    await OrganizationSvc.leave(firm.id, inviteeId);
    const restored = await OrganizationMemberRepo.findAnyForUser(inviteeId);
    expect(restored?.organizationId).to.equal(personal.id);
    expect(restored?.status).to.equal("ACCEPTED");
    expect(restored?.role).to.equal("OWNER");
  });
});
