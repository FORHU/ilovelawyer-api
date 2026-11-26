/** CaseLawyerInvite schema (client invites their own lawyer): a row round-trips with its PENDING
 * default, and the token is unique. Against the real database; the fixture user and case are removed
 * afterwards. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, beforeEach, afterEach, after } from "mocha";
import prisma from "../src/lib/prisma";
import CaseLawyerInviteRepo from "../src/repositories/case-lawyer-invite.repository";
import CaseLawyerInviteSvc from "../src/services/case-lawyer-invite.service";
import HttpError from "../src/utils/http-error";

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

    it("create runs inside a supplied transaction, so it rolls back with a revoke in the same transaction", async () => {
      // Proves revokePendingForCase and create genuinely share one transaction (CaseLawyerInviteSvc.createInvite's
      // revoke-then-create): if the transaction aborts after both calls, BOTH must be undone. Before create(data, tx)
      // existed, create ran on the module's own prisma client, outside the transaction, so it would have survived
      // this abort and this assertion would have failed.
      const pending = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const newToken = makeToken();

      let thrown: unknown;
      try {
        await prisma.$transaction(async (tx) => {
          await CaseLawyerInviteRepo.revokePendingForCase(caseId, tx);
          await CaseLawyerInviteRepo.create({ caseId, clientId, token: newToken, expiresAt: future }, tx);
          throw new Error("boom: abort after both writes");
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error)?.message).to.equal("boom: abort after both writes");

      const revokeRolledBack = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: pending.id } });
      expect(revokeRolledBack.status).to.equal("PENDING");
      expect(await CaseLawyerInviteRepo.findByToken(newToken)).to.equal(null);
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

  describe("CaseLawyerInviteSvc", function () {
    const otherClientId = crypto.randomUUID();
    const lawyerId = crypto.randomUUID();

    before(async () => {
      await prisma.user.create({ data: { id: otherClientId, email: `invite-other-${otherClientId}@example.com`, username: `invite-other-${otherClientId}` } });
      await prisma.user.create({ data: { id: lawyerId, email: `invite-svc-lawyer-${lawyerId}@example.com`, username: `invite-svc-lawyer-${lawyerId}` } });
    });

    afterEach(async () => {
      await prisma.clientRequestClaim.deleteMany({ where: { request: { caseId } } });
      await prisma.clientRequest.deleteMany({ where: { caseId } });
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [otherClientId, lawyerId] } } });
    });

    /** Puts an ENGAGED ClientRequest with an ENGAGED claim on the case, so
     * ClientRequestRepo.findEngagedLawyerForCase (and so CASE_HAS_LAWYER) sees it. */
    async function engageLawyerOnCase() {
      const request = await prisma.clientRequest.create({
        data: { caseId, clientId, status: "ENGAGED", consentVersion: "v1", consentAcceptedAt: new Date() },
      });
      await prisma.clientRequestClaim.create({ data: { requestId: request.id, lawyerId, outcome: "ENGAGED", expiresAt: future } });
      return request;
    }

    it("createLinkInvite revokes an existing pending invite for the case first", async () => {
      const first = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
      const second = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);

      expect(second.token).to.not.equal(first.token);
      const firstRow = await CaseLawyerInviteRepo.findByToken(first.token);
      expect(firstRow?.status).to.equal("REVOKED");
      const secondRow = await CaseLawyerInviteRepo.findByToken(second.token);
      expect(secondRow?.status).to.equal("PENDING");
    });

    it("createLinkInvite 404s when the case isn't the client's own", async () => {
      let err: unknown;
      try {
        await CaseLawyerInviteSvc.createLinkInvite(otherClientId, caseId);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(404);
    });

    it("createLinkInvite throws CASE_HAS_LAWYER when the case already has a live ENGAGED request", async () => {
      await engageLawyerOnCase();

      let err: unknown;
      try {
        await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(409);
      expect((err as HttpError).code).to.equal("CASE_HAS_LAWYER");
    });

    it("createEmailInvite stores the invite's email", async () => {
      const created = await CaseLawyerInviteSvc.createEmailInvite(clientId, caseId, "lawyer@example.com");
      const row = await CaseLawyerInviteRepo.findByToken(created.token);
      expect(row?.email).to.equal("lawyer@example.com");
    });

    it("getCurrentForCase returns null when there is no invite", async () => {
      expect(await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId)).to.equal(null);
    });

    it("getCurrentForCase returns the pending invite's status", async () => {
      const created = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
      const current = await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId);
      expect(current).to.not.equal(null);
      expect(current?.status).to.equal("PENDING");
      expect(current?.expiresAt.getTime()).to.equal(created.expiresAt.getTime());
    });

    it("revoke sets status REVOKED and 404s if there is no pending invite", async () => {
      const created = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
      await CaseLawyerInviteSvc.revoke(clientId, caseId);
      const row = await CaseLawyerInviteRepo.findByToken(created.token);
      expect(row?.status).to.equal("REVOKED");

      let err: unknown;
      try {
        await CaseLawyerInviteSvc.revoke(clientId, caseId);
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(404);
      expect((err as HttpError).code).to.equal("INVITE_NOT_FOUND");
    });
  });
});
