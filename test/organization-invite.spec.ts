import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, before, after } from "mocha";
import { OrganizationMemberStatus } from "@prisma/client";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import OrganizationSvc from "../src/services/organization.service";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

describe("Organization pending invite flow", () => {
  const ownerId = crypto.randomUUID();
  const inviteeId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();

  before(async () => {
    await prisma.user.create({
      data: { id: ownerId, email: `owner-${ownerId}@example.com`, username: `owner-${ownerId}` },
    });
    await prisma.user.create({
      data: { id: inviteeId, email: `invitee-${inviteeId}@example.com`, username: `invitee-${inviteeId}` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Test Org",
        slug: `test-org-${organizationId}`,
        createdById: ownerId,
        members: { create: { userId: ownerId, role: "OWNER" } },
      },
    });
  });

  after(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
    await prisma.user.delete({ where: { id: inviteeId } }).catch(() => {});
  });

  afterEach(async () => {
    // Each test that creates the invitee's membership row cleans it up so the
    // next test starts from a clean (no membership) slate.
    await prisma.organizationMember.deleteMany({ where: { userId: inviteeId } });
  });

  it("adds an invited member as PENDING, not immediately active", async () => {
    const member = await prisma.organizationMember.create({
      data: { organizationId, userId: inviteeId, role: "MEMBER", status: OrganizationMemberStatus.PENDING },
    });
    expect(member.status).to.equal("PENDING");

    // A pending member must not show up in the org list used by the frontend switcher.
    const orgsForInvitee = await OrganizationSvc.listForUser(inviteeId);
    expect(orgsForInvitee).to.have.length(0);

    // But should show up in the members list (so the UI can render a "Pending" badge).
    const members = await OrganizationSvc.listMembers(organizationId);
    const inviteeRow = members.find((m) => m.userId === inviteeId);
    expect(inviteeRow?.status).to.equal("PENDING");
  });

  it("blocks a pending member from org-scoped actions (requireMembership gate)", async () => {
    await prisma.organizationMember.create({
      data: { organizationId, userId: inviteeId, role: "MEMBER", status: OrganizationMemberStatus.PENDING },
    });

    try {
      await OrganizationSvc.requireMembership(organizationId, inviteeId);
      expect.fail("expected requireMembership to throw for a pending member");
    } catch (err: any) {
      expect(err.statusCode).to.equal(403);
    }

    // Confirmed at the HTTP layer too: GET /:id/members needs an accepted membership,
    // and a pending invitee gets refused instead of resource access.
    const res = await request(app)
      .get(`/api/organizations/${organizationId}/members`)
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
    expect(res.status).to.equal(403);
  });

  it("GET /invites/me returns the caller's pending invite", async () => {
    await prisma.organizationMember.create({
      data: { organizationId, userId: inviteeId, role: "MANAGER", status: OrganizationMemberStatus.PENDING },
    });

    const res = await request(app)
      .get("/api/organizations/invites/me")
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);

    expect(res.status).to.equal(200);
    expect(res.body).to.not.be.null;
    expect(res.body.organizationId).to.equal(organizationId);
    expect(res.body.role).to.equal("MANAGER");
    expect(res.body.organization.name).to.equal("Test Org");

    // The owner has no pending invite of their own.
    const ownerRes = await request(app)
      .get("/api/organizations/invites/me")
      .set("Authorization", `Bearer ${tokenFor(ownerId)}`);
    expect(ownerRes.status).to.equal(200);
    expect(ownerRes.body).to.be.null;
  });

  it("POST /invites/:id/accept flips PENDING to ACCEPTED and grants org access", async () => {
    await prisma.organizationMember.create({
      data: { organizationId, userId: inviteeId, role: "MEMBER", status: OrganizationMemberStatus.PENDING },
    });

    const res = await request(app)
      .post(`/api/organizations/invites/${organizationId}/accept`)
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
    expect(res.status).to.equal(200);

    const updated = await prisma.organizationMember.findUnique({ where: { userId: inviteeId } });
    expect(updated?.status).to.equal("ACCEPTED");

    // Now that they're accepted, org-scoped routes work.
    const membersRes = await request(app)
      .get(`/api/organizations/${organizationId}/members`)
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
    expect(membersRes.status).to.equal(200);

    // And they now show up in the org switcher list.
    const orgsForInvitee = await OrganizationSvc.listForUser(inviteeId);
    expect(orgsForInvitee).to.have.length(1);
    expect(orgsForInvitee[0].role).to.equal("MEMBER");
  });

  it("POST /invites/:id/decline deletes the pending row instead of accepting it", async () => {
    await prisma.organizationMember.create({
      data: { organizationId, userId: inviteeId, role: "MEMBER", status: OrganizationMemberStatus.PENDING },
    });

    const res = await request(app)
      .post(`/api/organizations/invites/${organizationId}/decline`)
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
    expect(res.status).to.equal(204);

    const gone = await prisma.organizationMember.findUnique({ where: { userId: inviteeId } });
    expect(gone).to.be.null;
  });

  it("rejects accept/decline when there's no pending invite for that org", async () => {
    const res = await request(app)
      .post(`/api/organizations/invites/${organizationId}/accept`)
      .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
    expect(res.status).to.equal(404);
  });
});
