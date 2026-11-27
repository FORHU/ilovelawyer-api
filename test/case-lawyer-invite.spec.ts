/** CaseLawyerInvite schema (client invites their own lawyer): a row round-trips with its PENDING
 * default, and the token is unique. Against the real database; the fixture user and case are removed
 * afterwards. */
import crypto from "crypto";
import type { ClientRequestStatus } from "@prisma/client";
import { expect } from "chai";
import { describe, it, before, beforeEach, afterEach, after } from "mocha";
import prisma from "../src/lib/prisma";
import CaseLawyerInviteRepo from "../src/repositories/case-lawyer-invite.repository";
import CaseLawyerInviteSvc from "../src/services/case-lawyer-invite.service";
import CaseSeedSvc from "../src/services/case-seed.service";
import HttpError from "../src/utils/http-error";
import * as mailerModule from "../src/utils/mailer";

/** Every status a ClientRequest is still open in (not CLOSED, EXPIRED or WITHDRAWN) short of ENGAGED:
 * a marketplace request in flight. */
const OPEN_NOT_ENGAGED: ClientRequestStatus[] = ["REQUESTED", "ROUTED", "CLAIMED", "QUOTED", "CONFIRMED"];

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

    it("findLatestForCase returns the row with the newest createdAt, regardless of status", async () => {
      const oldest = await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: makeToken(),
        status: "REVOKED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 3000),
      });
      const middle = await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: makeToken(),
        status: "ACCEPTED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 2000),
      });
      const newest = await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: makeToken(),
        status: "EXPIRED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 1000),
      });

      const found = await CaseLawyerInviteRepo.findLatestForCase(caseId);
      expect(found?.id).to.equal(newest.id);
      expect(found?.id).to.not.equal(middle.id);
      expect(found?.id).to.not.equal(oldest.id);
    });

    it("findLatestForCase returns null when the case has no invites", async () => {
      expect(await CaseLawyerInviteRepo.findLatestForCase(caseId)).to.equal(null);
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

    it("markAccepted sets status ACCEPTED, acceptedAt, acceptedById, and reports one row updated", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const returned = await CaseLawyerInviteRepo.markAccepted(invite.id, lawyerId);

      expect(returned.count).to.equal(1);
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("ACCEPTED");
      expect(read.acceptedById).to.equal(lawyerId);
      expect(read.acceptedAt).to.be.instanceOf(Date);
    });

    it("markAccepted runs inside a supplied transaction", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      await prisma.$transaction((tx) => CaseLawyerInviteRepo.markAccepted(invite.id, lawyerId, tx));
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("ACCEPTED");
    });

    it("markAccepted is a no-op (0 rows) when the invite is no longer PENDING", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "REVOKED", expiresAt: future });
      const returned = await CaseLawyerInviteRepo.markAccepted(invite.id, lawyerId);
      expect(returned.count).to.equal(0);
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("REVOKED");
      expect(read.acceptedById).to.equal(null);
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

    // The final review's C2: an invite used to be blocked only by an ENGAGED request, so a client
    // with a marketplace request still in flight could invite their own lawyer too, and both could
    // end up engaged. Every open (not closed, expired or withdrawn) status blocks it now.
    for (const status of OPEN_NOT_ENGAGED) {
      it(`createLinkInvite throws REQUEST_ALREADY_OPEN while a ${status} marketplace request is open, and creates no invite`, async () => {
        const open = await prisma.clientRequest.create({ data: { caseId, clientId, status, consentVersion: "v1", consentAcceptedAt: new Date() } });

        let err: unknown;
        try {
          await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(HttpError);
        expect((err as HttpError).statusCode).to.equal(409);
        expect((err as HttpError).code).to.equal("REQUEST_ALREADY_OPEN");
        expect((err as HttpError).details).to.deep.equal({ openRequestId: open.id });
        expect(await prisma.caseLawyerInvite.count({ where: { caseId } })).to.equal(0);
      });
    }

    it("createLinkInvite is allowed again once the marketplace request has closed", async () => {
      await prisma.clientRequest.create({ data: { caseId, clientId, status: "WITHDRAWN", consentVersion: "v1", consentAcceptedAt: new Date() } });
      const created = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);
      expect((await CaseLawyerInviteRepo.findByToken(created.token))?.status).to.equal("PENDING");
    });

    it("createEmailInvite stores the invite's email", async () => {
      const created = await CaseLawyerInviteSvc.createEmailInvite(clientId, caseId, "lawyer@example.com");
      const row = await CaseLawyerInviteRepo.findByToken(created.token);
      expect(row?.email).to.equal("lawyer@example.com");
    });

    it("createEmailInvite sends an email with a signup link containing the token and locked email", async () => {
      const originalSendEmail = mailerModule.sendEmail;
      const sent: { to: string; subject: string; html?: string }[] = [];
      (mailerModule as any).sendEmail = async (mail: { to: string; subject: string; html?: string }) => {
        sent.push(mail);
        return "sent";
      };

      let created: { token: string; expiresAt: Date };
      try {
        created = await CaseLawyerInviteSvc.createEmailInvite(clientId, caseId, "lawyer@example.com");
      } finally {
        (mailerModule as any).sendEmail = originalSendEmail;
      }

      expect(sent.length).to.equal(1);
      expect(sent[0]!.to).to.equal("lawyer@example.com");
      const html = sent[0]!.html!;
      expect(html).to.include("tab=signup");
      expect(html).to.include("invite=1");
      expect(html).to.include("lawyer%40example.com");
      expect(html).to.include(`caseInviteToken=${created.token}`);
      // Real copy, not placeholder text: the client's case name actually appears in the body.
      expect(html).to.include("Invite test");
      expect(html).to.include("represent them on ilovelawyer");
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

    it("getCurrentForCase returns an ACCEPTED invite (not null) when it's the most recent one for the case", async () => {
      const accepted = await CaseLawyerInviteRepo.create({ caseId, clientId, token: crypto.randomUUID(), status: "ACCEPTED", expiresAt: future });
      const current = await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId);
      expect(current).to.not.equal(null);
      expect(current?.status).to.equal("ACCEPTED");
      expect(current?.expiresAt.getTime()).to.equal(accepted.expiresAt.getTime());
    });

    it("getCurrentForCase returns a REVOKED invite (not null) when it's the most recent one for the case", async () => {
      await CaseLawyerInviteRepo.create({ caseId, clientId, token: crypto.randomUUID(), status: "REVOKED", expiresAt: future });
      const current = await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId);
      expect(current).to.not.equal(null);
      expect(current?.status).to.equal("REVOKED");
    });

    it("getCurrentForCase returns the newest of several historical rows for the case", async () => {
      await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: crypto.randomUUID(),
        status: "REVOKED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 2000),
      });
      const newer = await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: crypto.randomUUID(),
        status: "ACCEPTED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 1000),
      });

      const current = await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId);
      expect(current?.status).to.equal("ACCEPTED");
      expect(current?.acceptedAt?.getTime()).to.equal(newer.acceptedAt?.getTime());
    });

    it("getCurrentForCase returns the new PENDING invite, not an old revoked/accepted one, once createLinkInvite replaces it", async () => {
      // The sequence the client app relies on: a lawyer is revoked/removed from a case, then the
      // client creates a brand-new invite. getCurrentForCase must report the NEW pending invite,
      // not the stale outcome of the old one — createInvite's fresh createdAt on the new row is
      // what findLatestForCase's ordering depends on to get this right.
      await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: crypto.randomUUID(),
        status: "ACCEPTED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 5000),
      });
      await CaseLawyerInviteRepo.create({
        caseId,
        clientId,
        token: crypto.randomUUID(),
        status: "REVOKED",
        expiresAt: future,
        createdAt: new Date(Date.now() - 3000),
      });

      const created = await CaseLawyerInviteSvc.createLinkInvite(clientId, caseId);

      const current = await CaseLawyerInviteSvc.getCurrentForCase(clientId, caseId);
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

  describe("CaseLawyerInviteSvc.redeem", function () {
    const lawyerId = crypto.randomUUID();
    const lawyerEmail = `invite-redeem-lawyer-${lawyerId}@example.com`;
    const makeToken = () => `tok-${crypto.randomUUID()}`;
    const past = new Date(Date.now() - 60_000);
    const seededCaseIds: string[] = [];
    const otherLawyerIds: string[] = [];

    before(async () => {
      await prisma.user.create({ data: { id: lawyerId, email: lawyerEmail, username: `invite-redeem-lawyer-${lawyerId}`, role: "LAWYER" } });
    });

    afterEach(async () => {
      await prisma.case.deleteMany({ where: { id: { in: seededCaseIds } } });
      seededCaseIds.length = 0;
      await prisma.clientRequestClaim.deleteMany({ where: { request: { caseId } } });
      await prisma.clientRequest.deleteMany({ where: { caseId } });
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
      await prisma.user.deleteMany({ where: { id: { in: otherLawyerIds } } });
      otherLawyerIds.length = 0;
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { id: lawyerId } });
    });

    /** Puts an unrelated ENGAGED ClientRequest+claim on the case, so findEngagedLawyerForCase (and
     * so CASE_ALREADY_HAS_LAWYER) sees it — a different lawyer from the one redeeming the invite. */
    async function engageLawyerOnCase() {
      const otherLawyerId = crypto.randomUUID();
      otherLawyerIds.push(otherLawyerId);
      await prisma.user.create({ data: { id: otherLawyerId, email: `invite-redeem-other-${otherLawyerId}@example.com`, username: `invite-redeem-other-${otherLawyerId}` } });
      const request = await prisma.clientRequest.create({
        data: { caseId, clientId, status: "ENGAGED", consentVersion: "v1", consentAcceptedAt: new Date() },
      });
      await prisma.clientRequestClaim.create({ data: { requestId: request.id, lawyerId: otherLawyerId, outcome: "ENGAGED", expiresAt: future } });
      return request;
    }

    it("redeem attaches the lawyer: creates an ENGAGED ClientRequest+Claim, seeds a Case, sets lawyerCaseId, marks the invite ACCEPTED", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect("error" in result).to.equal(false);
      const ok = result as { requestId: string; caseId: string };
      seededCaseIds.push(ok.caseId);
      expect(ok.caseId).to.not.equal(caseId);

      const request = await prisma.clientRequest.findUniqueOrThrow({ where: { id: ok.requestId } });
      expect(request.status).to.equal("ENGAGED");
      expect(request.caseId).to.equal(caseId);
      expect(request.requestedLawyerId).to.equal(lawyerId);
      expect(request.requestedOnly).to.equal(true);
      expect(request.engagedAt).to.be.instanceOf(Date);

      const claim = await prisma.clientRequestClaim.findFirstOrThrow({ where: { requestId: ok.requestId } });
      expect(claim.lawyerId).to.equal(lawyerId);
      expect(claim.outcome).to.equal("ENGAGED");
      expect(claim.lawyerCaseId).to.equal(ok.caseId);

      const seededCase = await prisma.case.findUniqueOrThrow({ where: { id: ok.caseId } });
      expect(seededCase.userId).to.equal(lawyerId);
      expect(seededCase.copiedFromCaseId).to.equal(caseId);

      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("ACCEPTED");
      expect(row?.acceptedById).to.equal(lawyerId);
    });

    it("redeem returns INVITE_ALREADY_USED for an ACCEPTED invite and does not create a second Case", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "ACCEPTED", expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect(result).to.deep.equal({ error: "INVITE_ALREADY_USED" });
      expect(await prisma.clientRequest.count({ where: { caseId } })).to.equal(0);
      expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(0);
    });

    it("redeem returns INVITE_EXPIRED for a PENDING invite past expiresAt and flips its status", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: past });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect(result).to.deep.equal({ error: "INVITE_EXPIRED" });
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("EXPIRED");
    });

    it("redeem returns INVITE_EMAIL_MISMATCH when the invite has an email and user.email differs", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), email: "someone-else@example.com", expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect(result).to.deep.equal({ error: "INVITE_EMAIL_MISMATCH" });
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("PENDING");
    });

    it("redeem matches the invite's email case-insensitively", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), email: lawyerEmail.toUpperCase(), expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect("error" in result).to.equal(false);
      seededCaseIds.push((result as { caseId: string }).caseId);
    });

    it("redeem returns CASE_ALREADY_HAS_LAWYER when the case already has a live ENGAGED request, and leaves the invite PENDING", async () => {
      await engageLawyerOnCase();
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);

      expect(result).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("PENDING");
      expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(0);
    });

    it("redeem loses a race where the invite is revoked mid-seed: returns INVITE_ALREADY_USED, creates no ClientRequest, and cleans up the seeded Case", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const originalSeed = CaseSeedSvc.seed;
      let seededCaseId: string | undefined;
      // Simulates another request (e.g. the client revoking) landing in the window while seed()'s
      // S3 copies are in flight, between redeem's pre-seed checks and its own transaction.
      CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
        await CaseLawyerInviteRepo.revokePendingForCase(caseId);
        const seeded = await originalSeed(input);
        seededCaseId = seeded.caseId;
        return seeded;
      }) as typeof CaseSeedSvc.seed;

      let result: unknown;
      try {
        result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
      } finally {
        CaseSeedSvc.seed = originalSeed;
      }

      expect(result).to.deep.equal({ error: "INVITE_ALREADY_USED" });
      expect(await prisma.clientRequest.count({ where: { caseId } })).to.equal(0);
      expect(seededCaseId).to.be.a("string");
      expect(await prisma.case.findUnique({ where: { id: seededCaseId! } })).to.equal(null);
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("REVOKED");
    });

    it("redeem loses a race where a competing ENGAGED request lands mid-seed: returns CASE_ALREADY_HAS_LAWYER, creates no second ClientRequest, and cleans up the seeded Case", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const originalSeed = CaseSeedSvc.seed;
      let seededCaseId: string | undefined;
      // Simulates a competing engagement (another invite redeemed first, or the marketplace path)
      // reaching ENGAGED in the window while seed()'s S3 copies are in flight.
      CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
        await engageLawyerOnCase();
        const seeded = await originalSeed(input);
        seededCaseId = seeded.caseId;
        return seeded;
      }) as typeof CaseSeedSvc.seed;

      let result: unknown;
      try {
        result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
      } finally {
        CaseSeedSvc.seed = originalSeed;
      }

      expect(result).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
      expect(await prisma.clientRequest.count({ where: { caseId, requestedLawyerId: lawyerId } })).to.equal(0);
      expect(seededCaseId).to.be.a("string");
      expect(await prisma.case.findUnique({ where: { id: seededCaseId! } })).to.equal(null);
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("PENDING");
    });

    // C2: the pre-seed check refuses any open request, not only an ENGAGED one, so a marketplace
    // request in flight can't later settle to ENGAGED alongside this invite's.
    for (const status of OPEN_NOT_ENGAGED) {
      it(`redeem returns CASE_ALREADY_HAS_LAWYER while a ${status} marketplace request is open, seeding nothing and leaving the invite PENDING`, async () => {
        const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
        await prisma.clientRequest.create({ data: { caseId, clientId, status, consentVersion: "v1", consentAcceptedAt: new Date() } });
        const originalSeed = CaseSeedSvc.seed;
        let seedCalled = false;
        CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
          seedCalled = true;
          return originalSeed(input);
        }) as typeof CaseSeedSvc.seed;

        let result: unknown;
        try {
          result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
        } finally {
          CaseSeedSvc.seed = originalSeed;
        }

        expect(result).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
        expect(seedCalled).to.equal(false);
        expect(await prisma.clientRequest.count({ where: { caseId, requestedLawyerId: lawyerId } })).to.equal(0);
        expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(0);
        expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("PENDING");
      });
    }

    it("redeem's in-transaction recheck catches a non-ENGAGED open request landing mid-seed: CASE_ALREADY_HAS_LAWYER, and the seeded Case is cleaned up", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const originalSeed = CaseSeedSvc.seed;
      let seededCaseId: string | undefined;
      // The client asks for a marketplace lawyer (a ROUTED request, nobody engaged) while seed()'s S3
      // copies are in flight: the old ENGAGED-only recheck let this through.
      CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
        await prisma.clientRequest.create({ data: { caseId, clientId, status: "ROUTED", consentVersion: "v1", consentAcceptedAt: new Date() } });
        const seeded = await originalSeed(input);
        seededCaseId = seeded.caseId;
        return seeded;
      }) as typeof CaseSeedSvc.seed;

      let result: unknown;
      try {
        result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
      } finally {
        CaseSeedSvc.seed = originalSeed;
      }

      expect(result).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
      expect(await prisma.clientRequest.count({ where: { caseId, requestedLawyerId: lawyerId } })).to.equal(0);
      expect(seededCaseId).to.be.a("string");
      expect(await prisma.case.findUnique({ where: { id: seededCaseId! } })).to.equal(null);
      expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("PENDING");
    });

    it("redeem discards the seeded Case on any failure after seed(), not only a lost race, and rethrows the original error", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      const originalSeed = CaseSeedSvc.seed;
      const originalMarkAccepted = CaseLawyerInviteRepo.markAccepted;
      let seededCaseId: string | undefined;
      CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
        const seeded = await originalSeed(input);
        seededCaseId = seeded.caseId;
        return seeded;
      }) as typeof CaseSeedSvc.seed;
      // Something that isn't one of redeem's own outcomes failing inside its transaction (a
      // lock-wait or interactive-transaction timeout, say).
      const boom = new Error("lock wait timeout");
      CaseLawyerInviteRepo.markAccepted = (async () => {
        throw boom;
      }) as typeof CaseLawyerInviteRepo.markAccepted;

      let thrown: unknown;
      try {
        await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
      } catch (err) {
        thrown = err;
      } finally {
        CaseSeedSvc.seed = originalSeed;
        CaseLawyerInviteRepo.markAccepted = originalMarkAccepted;
      }

      expect(thrown).to.equal(boom);
      expect(seededCaseId).to.be.a("string");
      expect(await prisma.case.findUnique({ where: { id: seededCaseId! } })).to.equal(null);
      expect(await prisma.clientRequest.count({ where: { caseId } })).to.equal(0);
      expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("PENDING");
    });

    it("redeem returns NOT_A_LAWYER for a non-lawyer account (the client opening their own link), attaching nothing", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

      const result = await CaseLawyerInviteSvc.redeem({ id: clientId, email: `invite-${clientId}@example.com` }, invite.token);

      expect(result).to.deep.equal({ error: "NOT_A_LAWYER" });
      expect(await prisma.clientRequest.count({ where: { caseId } })).to.equal(0);
      expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(0);
      expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("PENDING");
    });

    it("redeem returns INVITE_NOT_FOUND for an unknown token", async () => {
      const result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, makeToken());
      expect(result).to.deep.equal({ error: "INVITE_NOT_FOUND" });
    });

    it("redeem returns CASE_NOT_FOUND when the source case is archived", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
      await prisma.case.update({ where: { id: caseId }, data: { status: "ARCHIVED" } });

      let result: unknown;
      try {
        result = await CaseLawyerInviteSvc.redeem({ id: lawyerId, email: lawyerEmail }, invite.token);
      } finally {
        await prisma.case.update({ where: { id: caseId }, data: { status: "ACTIVE" } });
      }

      expect(result).to.deep.equal({ error: "CASE_NOT_FOUND" });
      const row = await CaseLawyerInviteRepo.findByToken(invite.token);
      expect(row?.status).to.equal("PENDING");
    });
  });

  describe("lookupForSignup", function () {
    const noNameClientId = crypto.randomUUID();
    const makeToken = () => `tok-${crypto.randomUUID()}`;
    const past = new Date(Date.now() - 60_000);

    before(async () => {
      await prisma.user.update({ where: { id: clientId }, data: { name: "Jane Smith" } });
      await prisma.user.create({ data: { id: noNameClientId, email: `invite-noname-${noNameClientId}@example.com`, username: `invite-noname-${noNameClientId}` } });
    });

    beforeEach(async () => {
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    });

    after(async () => {
      await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
      await prisma.user.deleteMany({ where: { id: noNameClientId } });
      await prisma.user.update({ where: { id: clientId }, data: { name: null } });
    });

    it("lookupForSignup reports expired for a PENDING invite past expiresAt, without redeeming it", async () => {
      const token = makeToken();
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token, expiresAt: past });

      const result = await CaseLawyerInviteSvc.lookupForSignup(token);

      expect(result.status).to.equal("expired");
      const row = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(row.status).to.equal("EXPIRED");
      expect(row.acceptedAt).to.equal(null);
      expect(row.acceptedById).to.equal(null);
    });

    it("lookupForSignup maps each invite status to its DTO value", async () => {
      const cases = [
        ["PENDING", "valid"],
        ["ACCEPTED", "accepted"],
        ["REVOKED", "revoked"],
        ["EXPIRED", "expired"],
      ] as const;
      for (const [dbStatus, dtoStatus] of cases) {
        const token = makeToken();
        await CaseLawyerInviteRepo.create({ caseId, clientId, token, status: dbStatus, expiresAt: future });
        const result = await CaseLawyerInviteSvc.lookupForSignup(token);
        expect(result.status, dbStatus).to.equal(dtoStatus);
      }
    });

    it("lookupForSignup returns only status, first name, case name and email", async () => {
      const token = makeToken();
      await CaseLawyerInviteRepo.create({ caseId, clientId, token, email: "lawyer@example.com", expiresAt: future });

      const result = await CaseLawyerInviteSvc.lookupForSignup(token);

      expect(result).to.deep.equal({ status: "valid", clientFirstName: "Jane", caseName: "Invite test", email: "lawyer@example.com" });
    });

    it("lookupForSignup falls back to the username when the client has no name, and email is null when the invite has none", async () => {
      const token = makeToken();
      await CaseLawyerInviteRepo.create({ caseId, clientId: noNameClientId, token, expiresAt: future });

      const result = await CaseLawyerInviteSvc.lookupForSignup(token);

      expect(result.clientFirstName).to.equal(`invite-noname-${noNameClientId}`);
      expect(result.email).to.equal(null);
    });

    it("lookupForSignup 404s for an unknown token", async () => {
      let err: unknown;
      try {
        await CaseLawyerInviteSvc.lookupForSignup(makeToken());
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(404);
      expect((err as HttpError).code).to.equal("INVITE_NOT_FOUND");
    });

    it("lookupForSignup 404s with INVITE_NOT_FOUND when the invite's case has gone, rather than throwing a Prisma error", async () => {
      // Foreign keys cascade, so a real database can't hold an invite whose case is gone: simulate the
      // race where the case is deleted between the invite load and the name lookup.
      const token = makeToken();
      await CaseLawyerInviteRepo.create({ caseId, clientId, token, expiresAt: future });
      const original = prisma.case.findUnique;
      prisma.case.findUnique = (async () => null) as unknown as typeof original;
      let err: unknown;
      try {
        await CaseLawyerInviteSvc.lookupForSignup(token);
      } catch (e) {
        err = e;
      } finally {
        prisma.case.findUnique = original;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(404);
      expect((err as HttpError).code).to.equal("INVITE_NOT_FOUND");
    });

    it("lookupForSignup 404s with INVITE_NOT_FOUND when the invite's client has gone", async () => {
      const token = makeToken();
      await CaseLawyerInviteRepo.create({ caseId, clientId, token, expiresAt: future });
      const original = prisma.user.findUnique;
      prisma.user.findUnique = (async () => null) as unknown as typeof original;
      let err: unknown;
      try {
        await CaseLawyerInviteSvc.lookupForSignup(token);
      } catch (e) {
        err = e;
      } finally {
        prisma.user.findUnique = original;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect((err as HttpError).statusCode).to.equal(404);
      expect((err as HttpError).code).to.equal("INVITE_NOT_FOUND");
    });

    it("markExpired leaves a non-PENDING invite's status unchanged", async () => {
      const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), status: "ACCEPTED", expiresAt: past });
      await CaseLawyerInviteRepo.markExpired(invite.id);
      const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(read.status).to.equal("ACCEPTED");
    });
  });
});
