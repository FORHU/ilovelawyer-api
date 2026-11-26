/** CaseLawyerInvite schema (client invites their own lawyer): a row round-trips with its PENDING
 * default, and the token is unique. Against the real database; the fixture user and case are removed
 * afterwards. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, beforeEach, after } from "mocha";
import prisma from "../src/lib/prisma";
import CaseLawyerInviteRepo from "../src/repositories/case-lawyer-invite.repository";

describe("CaseLawyerInvite", function () {
  this.timeout(20_000);
  const clientId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  before(async () => {
    await prisma.user.create({ data: { id: clientId, email: `invite-${clientId}@example.com`, username: `invite-${clientId}` } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Invite test", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: clientId } });
  });

  it("creates and reads back a CaseLawyerInvite with a unique token", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    const invite = await prisma.caseLawyerInvite.create({ data: { caseId, clientId, token, expiresAt: future } });
    expect(invite.status).to.equal("PENDING");

    const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(read.token).to.equal(token);
    expect(read.acceptedById).to.equal(null);

    let duplicateError: unknown;
    try {
      await prisma.caseLawyerInvite.create({ data: { caseId, clientId, token, expiresAt: future } });
    } catch (err) {
      duplicateError = err;
    }
    expect((duplicateError as { code?: string } | undefined)?.code).to.equal("P2002");
  });

  describe("CaseLawyerInviteRepo", function () {
    const lawyerId = crypto.randomUUID();
    const makeToken = () => `tok-${crypto.randomUUID()}`;

    before(async () => {
      await prisma.user.create({ data: { id: lawyerId, email: `invite-lawyer-${lawyerId}@example.com`, username: `invite-lawyer-${lawyerId}` } });
    });

    beforeEach(async () => {
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    });

    after(async () => {
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
      await prisma.user.deleteMany({ where: { id: lawyerId } });
    });

    it("create stores the row with the given fields and the PENDING default", async () => {
      const token = makeToken();
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token, email: "lawyer@example.com", expiresAt: future });
      expect(invite.status).to.equal("PENDING");
      expect(invite.email).to.equal("lawyer@example.com");
      expect(invite.token).to.equal(token);
    });

    it("findPendingForCase returns only the PENDING row", async () => {
      await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "REVOKED", expiresAt: future });
      await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "ACCEPTED", expiresAt: future });
      await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "EXPIRED", expiresAt: future });
      const pending = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

      const found = await CaseLawyerInviteRepo.findPendingForCase(caseId);
      expect(found?.id).to.equal(pending.id);
    });

    it("findPendingForCase returns null when no PENDING row exists for the case", async () => {
      await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "REVOKED", expiresAt: future });
      expect(await CaseLawyerInviteRepo.findPendingForCase(caseId)).to.equal(null);
    });

    it("findByToken returns the matching row, or null for an unknown token", async () => {
      const token = makeToken();
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token, expiresAt: future });
      expect((await CaseLawyerInviteRepo.findByToken(token))?.id).to.equal(invite.id);
      expect(await CaseLawyerInviteRepo.findByToken(makeToken())).to.equal(null);
    });

    it("revokePendingForCase flips PENDING rows to REVOKED with revokedAt, leaving other statuses alone", async () => {
      const pending = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const accepted = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "ACCEPTED", expiresAt: future });

      await CaseLawyerInviteRepo.revokePendingForCase(caseId);

      const revoked = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: pending.id } });
      expect(revoked.status).to.equal("REVOKED");
      expect(revoked.revokedAt).to.be.instanceOf(Date);
      const untouched = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: accepted.id } });
      expect(untouched.status).to.equal("ACCEPTED");
      expect(untouched.revokedAt).to.equal(null);
    });

    it("revokePendingForCase runs inside a supplied transaction", async () => {
      const pending = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      await prisma.$transaction((tx) => CaseLawyerInviteRepo.revokePendingForCase(caseId, tx));
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: pending.id } });
      expect(read.status).to.equal("REVOKED");
    });

    it("markAccepted sets status ACCEPTED, acceptedAt, acceptedById", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const returned = await CaseLawyerInviteRepo.markAccepted(invite.id, lawyerId);

      expect(returned.status).to.equal("ACCEPTED");
      expect(returned.acceptedById).to.equal(lawyerId);
      expect(returned.acceptedAt).to.be.instanceOf(Date);
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("ACCEPTED");
      expect(read.acceptedById).to.equal(lawyerId);
    });

    it("markAccepted runs inside a supplied transaction", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      await prisma.$transaction((tx) => CaseLawyerInviteRepo.markAccepted(invite.id, lawyerId, tx));
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("ACCEPTED");
    });

    it("markExpired sets status EXPIRED", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      await CaseLawyerInviteRepo.markExpired(invite.id);
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("EXPIRED");
    });
  });
});
