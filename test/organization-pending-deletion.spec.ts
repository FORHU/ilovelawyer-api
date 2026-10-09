import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, after, beforeEach, afterEach } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";
import OrganizationEmailInviteRepo from "../src/repositories/organization-email-invite.repository";
import { ORGANIZATION_DELETION_GRACE_PERIOD_DAYS } from "../src/constants/organization-deletion.constants";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Organization pending deletion", () => {
  const createdUserIds: string[] = [];
  const createdEmails: string[] = [];
  let restore: (() => void)[] = [];

  async function makeUser() {
    const userId = crypto.randomUUID();
    await prisma.user.create({
      data: { id: userId, email: `pending-${userId}@example.com`, username: `pending-${userId}` },
    });
    createdUserIds.push(userId);
    return userId;
  }

  async function makeOrg(name: string) {
    const ownerId = await makeUser();
    const org = await OrganizationSvc.create(ownerId, name, undefined, "PH");
    return { ownerId, organizationId: org.id };
  }

  const statusOf = (id: string) => prisma.organization.findUnique({ where: { id } });

  // inviteMember sends a real email; these specs only care about the invite rows.
  beforeEach(() => {
    restore = [stash(mailerModule, ["sendEmail"]), stash(templateModule, ["renderTemplate"])];
    (templateModule as any).renderTemplate = async (name: string) => name;
    (mailerModule as any).sendEmail = async () => {};
  });
  afterEach(() => restore.forEach((r) => r()));

  after(async () => {
    await prisma.organizationEmailInvite.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.consultation.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  describe("leaving", () => {
    it("won't let the only owner of a team leave until they make someone else an owner", async () => {
      const { ownerId, organizationId } = await makeOrg("Ada Firm");
      const teammateId = await makeUser();
      await OrganizationMemberRepo.add(organizationId, teammateId, "ADMIN");

      const err = await OrganizationSvc.leave(organizationId, ownerId).catch((e) => e);
      expect(err.statusCode).to.equal(400);
      expect((await OrganizationMemberRepo.findAnyForUser(ownerId))?.organizationId).to.equal(organizationId);

      await OrganizationSvc.changeMemberRole(organizationId, "OWNER", teammateId, "OWNER");
      await OrganizationSvc.leave(organizationId, ownerId);
      expect((await statusOf(organizationId))?.status).to.equal("ACTIVE");
    });

    it("keeps the org's invites working when the owner hands over before leaving", async () => {
      const { ownerId, organizationId } = await makeOrg("Bo Firm");
      const teammateId = await makeUser();
      const inviteeId = await makeUser();
      await OrganizationMemberRepo.add(organizationId, teammateId, "OWNER");
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MEMBER");

      await OrganizationSvc.leave(organizationId, ownerId);
      expect((await OrganizationSvc.getPendingInviteForUser(inviteeId))?.organizationId).to.equal(organizationId);
    });

    it("archives the org for deletion in 30 days when its last member leaves", async () => {
      const { ownerId, organizationId } = await makeOrg("Cy Firm");
      const before = Date.now();

      await OrganizationSvc.leave(organizationId, ownerId);

      const org = await statusOf(organizationId);
      expect(org?.status).to.equal("PENDING_DELETION");
      expect(org?.archivedById).to.equal(ownerId);
      expect(org?.archivedAt?.getTime()).to.be.at.least(before - 1000);
      expect(org!.deletionScheduledAt!.getTime() - org!.archivedAt!.getTime()).to.equal(ORGANIZATION_DELETION_GRACE_PERIOD_DAYS * DAY_MS);
      // The leaver lands in their portfolio, as with any leave.
      const orgs = await OrganizationSvc.listForUser(ownerId);
      expect(orgs.map((o) => o.isPersonal)).to.deep.equal([true]);
    });

    it("archives the old org when its sole owner accepts an invite elsewhere", async () => {
      const current = await makeOrg("Di Firm");
      const inviting = await makeOrg("Ed Firm");
      await OrganizationInviteRepo.create(inviting.organizationId, current.ownerId, "MEMBER");

      await OrganizationSvc.acceptInvite(inviting.organizationId, current.ownerId);

      expect((await statusOf(current.organizationId))?.status).to.equal("PENDING_DELETION");
      expect((await statusOf(inviting.organizationId))?.status).to.equal("ACTIVE");
    });

    it("leaves a parked personal workspace alone", async () => {
      const userId = await makeUser();
      const personal = await OrganizationSvc.create(userId, "Flo", undefined, "PH", true);
      const inviting = await makeOrg("Gus Firm");
      await OrganizationInviteRepo.create(inviting.organizationId, userId, "MEMBER");

      await OrganizationSvc.acceptInvite(inviting.organizationId, userId);

      expect((await statusOf(personal.id))?.status).to.equal("ACTIVE");
    });
  });

  describe("invites to an archived org", () => {
    async function archivedOrgWithInvitee() {
      const { ownerId, organizationId } = await makeOrg("Hana Firm");
      const inviteeId = await makeUser();
      await OrganizationInviteRepo.create(organizationId, inviteeId, "MEMBER");
      await OrganizationSvc.leave(organizationId, ownerId);
      return { organizationId, inviteeId };
    }

    it("aren't returned as the invitee's pending invite", async () => {
      const { inviteeId } = await archivedOrgWithInvitee();

      const res = await request(app)
        .get("/api/organizations/invites/me")
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.be.null;
    });

    it("can't be accepted: 410, the invite is used up and nobody joins", async () => {
      const { organizationId, inviteeId } = await archivedOrgWithInvitee();

      const res = await request(app)
        .post(`/api/organizations/invites/${organizationId}/accept`)
        .set("Authorization", `Bearer ${tokenFor(inviteeId)}`);
      expect(res.status).to.equal(410);
      expect(res.body.message).to.match(/no longer valid/i);
      expect(await OrganizationInviteRepo.findForUser(inviteeId)).to.equal(null);
      expect(await OrganizationMemberRepo.findAnyForUser(inviteeId)).to.equal(null);
      expect(await prisma.organizationMember.count({ where: { organizationId } })).to.equal(0);
    });

    it("don't stop another org from inviting the same person", async () => {
      const { inviteeId } = await archivedOrgWithInvitee();
      const other = await makeOrg("Ivo Firm");

      await OrganizationSvc.inviteMember(other.organizationId, "OWNER", other.ownerId, `pending-${inviteeId}@example.com`, "MEMBER");

      expect((await OrganizationSvc.getPendingInviteForUser(inviteeId))?.organizationId).to.equal(other.organizationId);
    });

    it("sent to an address with no account: don't carry over on signup or approve the account", async () => {
      const { ownerId, organizationId } = await makeOrg("Jan Firm");
      const email = `pending-signup-${crypto.randomUUID()}@example.com`;
      createdEmails.push(email);
      await OrganizationEmailInviteRepo.create(organizationId, email, "MEMBER");
      await OrganizationSvc.leave(organizationId, ownerId);

      expect(await OrganizationEmailInviteRepo.hasLiveInvite(email)).to.equal(false);
      const userId = await makeUser();
      expect(await OrganizationEmailInviteRepo.claim(userId, email)).to.equal(false);
      expect(await OrganizationInviteRepo.findForUser(userId)).to.equal(null);
      expect(await OrganizationEmailInviteRepo.findByEmail(email)).to.equal(null);
    });
  });

  describe("deletion after the grace period", () => {
    it("is due only once deletionScheduledAt has passed", async () => {
      const { ownerId, organizationId } = await makeOrg("Kai Firm");
      await OrganizationSvc.leave(organizationId, ownerId);
      const { deletionScheduledAt } = (await statusOf(organizationId))!;

      const dueIds = async (now: Date) => {
        const ids: string[] = [];
        let afterId: string | undefined;
        let page: { id: string }[];
        do {
          page = await OrganizationRepo.findDueForDeletion(now, { afterId, take: 500 });
          ids.push(...page.map((o) => o.id));
          afterId = page.at(-1)?.id;
        } while (page.length === 500);
        return ids;
      };
      expect(await dueIds(new Date(deletionScheduledAt!.getTime() - 1000))).to.not.include(organizationId);
      expect(await dueIds(new Date(deletionScheduledAt!.getTime() + 1000))).to.include(organizationId);
    });

    it("deletes the org with its cases and consultations", async () => {
      const { ownerId, organizationId } = await makeOrg("Lia Firm");
      const caseRow = await prisma.case.create({
        data: { id: crypto.randomUUID(), userId: ownerId, organizationId, caseName: "Old matter" },
      });
      const consultation = await prisma.consultation.create({ data: { userId: ownerId, organizationId, caseId: caseRow.id } });
      await OrganizationSvc.leave(organizationId, ownerId);

      const result = await OrganizationRepo.deletePermanently(organizationId);

      expect(result).to.deep.include({ casesDeleted: 1, consultationsDeleted: 1 });
      expect(await statusOf(organizationId)).to.equal(null);
      expect(await prisma.case.findUnique({ where: { id: caseRow.id } })).to.equal(null);
      expect(await prisma.consultation.findUnique({ where: { id: consultation.id } })).to.equal(null);
    });

    it("skips an org support restored to ACTIVE", async () => {
      const { ownerId, organizationId } = await makeOrg("Mo Firm");
      await OrganizationSvc.leave(organizationId, ownerId);
      await prisma.organization.update({ where: { id: organizationId }, data: { status: "ACTIVE" } });

      expect(await OrganizationRepo.deletePermanently(organizationId)).to.equal(null);
      expect((await statusOf(organizationId))?.status).to.equal("ACTIVE");
    });
  });
});
