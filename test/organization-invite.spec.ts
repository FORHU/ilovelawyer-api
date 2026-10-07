import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

// Invites are created through the repo, not OrganizationSvc.inviteMember, which sends a real
// email — only its refusals (which throw before sending) are exercised through the service.
describe("Organization invites", () => {
  const createdUserIds: string[] = [];

  async function makeUser() {
    const userId = crypto.randomUUID();
    await prisma.user.create({
      data: { id: userId, email: `invite-${userId}@example.com`, username: `invite-${userId}` },
    });
    createdUserIds.push(userId);
    return userId;
  }

  async function makeOrg(name: string) {
    const ownerId = await makeUser();
    const org = await OrganizationSvc.create(ownerId, name, undefined, "PH");
    return { ownerId, organizationId: org.id };
  }

  after(async () => {
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  describe("for someone with no organization", () => {
    it("is not a membership until accepted, but shows as PENDING in the members list", async () => {
      const { organizationId } = await makeOrg("Ada Firm");
      const inviteeId = await makeUser();
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MEMBER");

      expect(await OrganizationSvc.listForUser(inviteeId)).to.have.length(0);
      const err = await OrganizationSvc.requireMembership(organizationId, inviteeId).catch((e) => e);
      expect(err.statusCode).to.equal(403);

      const members = await OrganizationSvc.listMembers(organizationId);
      expect(members.find((m) => m.userId === inviteeId)?.status).to.equal("PENDING");

      const res = await request(app)
        .get(`/api/organizations/${organizationId}/members`)
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(403);
    });

    it("GET /invites/me returns the caller's pending invite", async () => {
      const { ownerId, organizationId } = await makeOrg("Bo Firm");
      const inviteeId = await makeUser();
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MANAGER");

      const res = await request(app)
        .get("/api/organizations/invites/me")
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(200);
      expect(res.body.organizationId).to.equal(organizationId);
      expect(res.body.role).to.equal("MANAGER");
      expect(res.body.status).to.equal("PENDING");
      expect(res.body.organization.name).to.equal("Bo Firm");
      // The app activates the org from this record on accept, which needs its tenant.
      expect(res.body.organization.tenant.code).to.equal("PH");

      const ownerRes = await request(app)
        .get("/api/organizations/invites/me")
        .set("Authorization", `Bearer ${tokenFor(ownerId)}`);
      expect(ownerRes.status).to.equal(200);
      expect(ownerRes.body).to.be.null;
    });

    it("POST /invites/:id/accept makes them a member and uses up the invite", async () => {
      const { organizationId } = await makeOrg("Cy Firm");
      const inviteeId = await makeUser();
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MEMBER");

      const res = await request(app)
        .post(`/api/organizations/invites/${organizationId}/accept`)
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(200);

      const orgs = await OrganizationSvc.listForUser(inviteeId);
      expect(orgs.map((o) => o.id)).to.deep.equal([organizationId]);
      expect(orgs[0].role).to.equal("MEMBER");
      expect(await OrganizationInviteRepo.findForUser(inviteeId)).to.equal(null);
    });

    it("POST /invites/:id/decline removes the invite", async () => {
      const { organizationId } = await makeOrg("Di Firm");
      const inviteeId = await makeUser();
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MEMBER");

      const res = await request(app)
        .post(`/api/organizations/invites/${organizationId}/decline`)
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(204);
      expect(await OrganizationInviteRepo.findForUser(inviteeId)).to.equal(null);
      expect(await OrganizationMemberRepo.findAnyForUser(inviteeId)).to.equal(null);
    });

    it("rejects accept/decline when there's no pending invite for that org", async () => {
      const { organizationId } = await makeOrg("Ed Firm");
      const inviteeId = await makeUser();

      const res = await request(app)
        .post(`/api/organizations/invites/${organizationId}/accept`)
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(404);
    });
  });

  describe("for someone already in another organization", () => {
    it("keeps their current membership working while the invite is outstanding", async () => {
      const current = await makeOrg("Flo Firm");
      const inviting = await makeOrg("Gus Firm");
      const memberId = await makeUser();
      await OrganizationMemberRepo.add(current.organizationId, memberId, "MEMBER");
      await OrganizationInviteRepo.create(inviting.organizationId, memberId, "ADMIN");

      // Their current org keeps working while the invite is outstanding.
      const membership = await OrganizationSvc.requireMembership(current.organizationId, memberId);
      expect(membership.organizationId).to.equal(current.organizationId);
      expect((await OrganizationSvc.getPendingInviteForUser(memberId))?.organizationId).to.equal(inviting.organizationId);
    });

    it("refuses a second invite while one is outstanding, and re-inviting a member", async () => {
      const current = await makeOrg("Hana Firm");
      const first = await makeOrg("Ivo Firm");
      const second = await makeOrg("Jan Firm");
      const memberId = await makeUser();
      await OrganizationMemberRepo.add(current.organizationId, memberId, "MEMBER");
      await OrganizationInviteRepo.create(first.organizationId, memberId, "MEMBER");
      const email = `invite-${memberId}@example.com`;

      const elsewhere = await OrganizationSvc.inviteMember(second.organizationId, "OWNER", second.ownerId, email, "MEMBER").catch((e) => e);
      expect(elsewhere.statusCode).to.equal(409);
      const again = await OrganizationSvc.inviteMember(first.organizationId, "OWNER", first.ownerId, email, "MEMBER").catch((e) => e);
      expect(again.statusCode).to.equal(409);
      const member = await OrganizationSvc.inviteMember(current.organizationId, "OWNER", current.ownerId, email, "MEMBER").catch((e) => e);
      expect(member.statusCode).to.equal(409);
    });

    it("accepting leaves the current org (and its per-case grants) and joins the new one", async () => {
      const current = await makeOrg("Kai Firm");
      const inviting = await makeOrg("Lia Firm");
      const memberId = await makeUser();
      await OrganizationMemberRepo.add(current.organizationId, memberId, "MEMBER");
      const oldCase = await prisma.case.create({
        data: { id: crypto.randomUUID(), userId: current.ownerId, organizationId: current.organizationId, caseName: "Old" },
      });
      await prisma.caseAccess.create({ data: { caseId: oldCase.id, userId: memberId, permission: "EDIT" } });
      await OrganizationInviteRepo.create(inviting.organizationId, memberId, "ADMIN");

      await OrganizationSvc.acceptInvite(inviting.organizationId, memberId);

      const now = await OrganizationMemberRepo.findAnyForUser(memberId);
      expect(now?.organizationId).to.equal(inviting.organizationId);
      expect(now?.role).to.equal("ADMIN");
      const err = await OrganizationSvc.requireMembership(current.organizationId, memberId).catch((e) => e);
      expect(err.statusCode).to.equal(403);
      expect(await prisma.caseAccess.count({ where: { userId: memberId } })).to.equal(0);
      expect((await OrganizationSvc.listMembers(current.organizationId)).map((m) => m.userId)).to.deep.equal([current.ownerId]);
    });

    it("declining keeps them in their current org", async () => {
      const current = await makeOrg("Mo Firm");
      const inviting = await makeOrg("Nia Firm");
      const memberId = await makeUser();
      await OrganizationMemberRepo.add(current.organizationId, memberId, "MANAGER");
      await OrganizationInviteRepo.create(inviting.organizationId, memberId, "MEMBER");

      await OrganizationSvc.declineInvite(inviting.organizationId, memberId);

      const now = await OrganizationMemberRepo.findAnyForUser(memberId);
      expect(now?.organizationId).to.equal(current.organizationId);
      expect(now?.role).to.equal("MANAGER");
      expect(await OrganizationInviteRepo.findForUser(memberId)).to.equal(null);
    });

    it("won't let the only owner of a team accept until they hand ownership over", async () => {
      const current = await makeOrg("Oz Firm");
      const inviting = await makeOrg("Pia Firm");
      const teammateId = await makeUser();
      await OrganizationMemberRepo.add(current.organizationId, teammateId, "MEMBER");
      await OrganizationInviteRepo.create(inviting.organizationId, current.ownerId, "MEMBER");

      const err = await OrganizationSvc.acceptInvite(inviting.organizationId, current.ownerId).catch((e) => e);
      expect(err.statusCode).to.equal(400);
      expect((await OrganizationMemberRepo.findAnyForUser(current.ownerId))?.organizationId).to.equal(current.organizationId);
      expect(await OrganizationInviteRepo.findForUser(current.ownerId)).to.not.equal(null);

      await OrganizationSvc.changeMemberRole(current.organizationId, "OWNER", teammateId, "OWNER");
      await OrganizationSvc.acceptInvite(inviting.organizationId, current.ownerId);
      expect((await OrganizationMemberRepo.findAnyForUser(current.ownerId))?.organizationId).to.equal(inviting.organizationId);
    });

    it("lets a sole owner with no teammates accept", async () => {
      const current = await makeOrg("Quin Firm");
      const inviting = await makeOrg("Rae Firm");
      await OrganizationInviteRepo.create(inviting.organizationId, current.ownerId, "MEMBER");

      await OrganizationSvc.acceptInvite(inviting.organizationId, current.ownerId);
      expect((await OrganizationMemberRepo.findAnyForUser(current.ownerId))?.organizationId).to.equal(inviting.organizationId);
    });
  });
});
