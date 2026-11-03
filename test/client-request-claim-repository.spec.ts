/** ClientRequestClaimRepo — lawyers joining a client request (#511; up to 3 at once since phase 5),
 * quoting, and their claims ending. Runs against the real database, like
 * test/audit-event-repository.spec.ts: the race can only be shown against Postgres. It makes its own
 * users, organization, case and request, and removes them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import prisma from "../src/lib/prisma";
import ClientRequestClaimRepo, { CLAIM_HOLD_MS } from "../src/repositories/client-request-claim.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import OrganizationChargeRepo from "../src/repositories/organization-charge.repository";
import { CLIENT_REQUEST_MAX_LAWYERS, CLIENT_REQUEST_PICK_WINDOW_MS } from "../src/constants/client-request.constants";

const HOUR_MS = 60 * 60 * 1000;
const LAWYERS = 8;
const QUOTE = { type: "FIXED_FEE" as const, amountMinor: 50_000, currency: "GBP", message: "Fixed fee." };

describe("ClientRequestClaimRepo", () => {
  const clientId = crypto.randomUUID();
  const lawyerIds = Array.from({ length: LAWYERS }, () => crypto.randomUUID());
  const orgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;

  /** Joins, and returns the claim (failing the test if the join was refused). */
  async function join(lawyerId: string, at: Date = new Date()) {
    const result = await ClientRequestClaimRepo.claim(requestId, lawyerId, orgId, at);
    if (!("claim" in result) || !result.claim) throw new Error(`join refused: ${result.refused}`);
    return result.claim;
  }
  const request = () => prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } });
  const claimRow = (id: string) => prisma.clientRequestClaim.findUniqueOrThrow({ where: { id } });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [clientId, ...lawyerIds].map((id) => ({ id, email: `claim-race-${id}@example.com`, username: `claim-race-${id}` })),
    });
    await prisma.organization.create({ data: { id: orgId, name: "Claim Race Org", slug: `claim-race-${orgId}`, createdById: lawyerIds[0]!, tenantId: tenant.id } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: orgId, caseName: "Claim Race Case" } });
  });

  beforeEach(async () => {
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    const created = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED", routingExpiresAt: new Date(Date.now() + 48 * HOUR_MS) },
    });
    requestId = created.id;
  });

  after(async () => {
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.delete({ where: { id: caseId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: [clientId, ...lawyerIds] } } });
  });

  describe("claim (joining)", () => {
    it("lets exactly 3 of many simultaneous joins in, and keeps the request ROUTED", async () => {
      const results = await Promise.all(lawyerIds.map((lawyerId) => ClientRequestClaimRepo.claim(requestId, lawyerId, orgId)));

      expect(results.filter((r) => "claim" in r && r.claim)).to.have.length(CLIENT_REQUEST_MAX_LAWYERS);
      expect(results.filter((r) => r.refused === "FULL")).to.have.length(LAWYERS - CLIENT_REQUEST_MAX_LAWYERS);
      expect(await prisma.clientRequestClaim.count({ where: { requestId, outcome: null } })).to.equal(CLIENT_REQUEST_MAX_LAWYERS);
      expect((await request()).status).to.equal("ROUTED");
    });

    it("gives each lawyer 24h from joining, and says how many are on it", async () => {
      const now = new Date();
      const first = await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, now);
      const second = await ClientRequestClaimRepo.claim(requestId, lawyerIds[1]!, orgId, now);

      expect(first.claim!.claimedAt.getTime()).to.equal(now.getTime());
      expect(first.claim!.expiresAt.getTime()).to.equal(now.getTime() + 24 * HOUR_MS);
      expect(CLAIM_HOLD_MS).to.equal(24 * HOUR_MS);
      expect([first.joined, second.joined]).to.deep.equal([1, 2]);
    });

    it("refuses a lawyer already on it, without a second claim", async () => {
      await join(lawyerIds[0]!);
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.deep.equal({ refused: "JOINED" });
      expect(await prisma.clientRequestClaim.count({ where: { requestId } })).to.equal(1);
    });

    it("refuses once the 48h routing window is over, even before the sweep has expired it", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.deep.equal({ refused: "CLOSED" });
      expect(await prisma.clientRequestClaim.count({ where: { requestId } })).to.equal(0);
    });

    it("refuses a lawyer who passed on the request or left it before", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { excludedLawyerIds: [lawyerIds[0]!] } });
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.deep.equal({ refused: "CLOSED" });
      await join(lawyerIds[1]!);
    });
  });

  describe("quote", () => {
    it("saves the quote once, and the first quote starts the client's 7 days to pick", async () => {
      const a = await join(lawyerIds[0]!);
      const b = await join(lawyerIds[1]!);
      const first = new Date();

      expect(await ClientRequestClaimRepo.quote(a, QUOTE, first)).to.equal(true);
      expect(await ClientRequestClaimRepo.quote(a, QUOTE, first)).to.equal(false);
      expect(await ClientRequestClaimRepo.quote(b, QUOTE, new Date(first.getTime() + HOUR_MS))).to.equal(true);

      expect((await claimRow(a.id)).quotedAt!.getTime()).to.equal(first.getTime());
      const r = await request();
      expect(r.status).to.equal("ROUTED");
      expect(r.pickByAt!.getTime()).to.equal(first.getTime() + CLIENT_REQUEST_PICK_WINDOW_MS);
    });

    it("refuses after the lawyer's 24h, or once the request has moved on", async () => {
      const late = await join(lawyerIds[0]!, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      expect(await ClientRequestClaimRepo.quote(late, QUOTE)).to.equal(false);

      const ok = await join(lawyerIds[1]!);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "WITHDRAWN" } });
      expect(await ClientRequestClaimRepo.quote(ok, QUOTE)).to.equal(false);
    });
  });

  describe("a claim ending frees its place", () => {
    it("release: the lawyer leaves and isn't offered it again; the others carry on", async () => {
      const a = await join(lawyerIds[0]!);
      await join(lawyerIds[1]!);
      await join(lawyerIds[2]!);
      const routedAt = (await request()).routedAt;

      expect(await ClientRequestClaimRepo.release(a, { reason: "CONFLICT", note: null })).to.equal(true);

      expect(await claimRow(a.id)).to.deep.include({ outcome: "RELEASED", releaseReason: "CONFLICT" });
      const r = await request();
      expect(r).to.deep.include({ status: "ROUTED", excludedLawyerIds: [lawyerIds[0]!], routedAt });
      // A place is free again: a new lawyer can join, the one who left can't.
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.deep.equal({ refused: "CLOSED" });
      await join(lawyerIds[3]!);
    });

    it("decline: only a quoted claim; with no quote left open, there's nothing to pick by", async () => {
      const a = await join(lawyerIds[0]!);
      const b = await join(lawyerIds[1]!);
      expect(await ClientRequestClaimRepo.decline(a, "Too expensive")).to.equal(false);
      await ClientRequestClaimRepo.quote(a, QUOTE);

      expect(await ClientRequestClaimRepo.decline(a, "Too expensive")).to.equal(true);

      expect(await claimRow(a.id)).to.deep.include({ outcome: "DECLINED", declineReason: "Too expensive" });
      expect(await claimRow(b.id)).to.deep.include({ outcome: null });
      expect(await request()).to.deep.include({ status: "ROUTED", pickByAt: null });
    });

    it("the last lawyer leaving puts the request back in the pool for a fresh 48h, to be announced again", async () => {
      const a = await join(lawyerIds[0]!);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { announcedAt: new Date() } });
      const now = new Date();

      expect(await ClientRequestClaimRepo.release(a, { reason: "CAPACITY", note: null }, now)).to.equal(true);

      const r = await request();
      expect(r).to.deep.include({ status: "ROUTED", announcedAt: null, pickByAt: null });
      expect(r.routedAt!.getTime()).to.equal(now.getTime());
      expect(r.routingExpiresAt!.getTime()).to.equal(now.getTime() + 48 * HOUR_MS);
    });
  });

  describe("findLapsed / lapse", () => {
    it("finds an unquoted claim once its 24h is over, and not before", async () => {
      const joinedAt = new Date(Date.now() - CLAIM_HOLD_MS - 1000);
      await join(lawyerIds[0]!, joinedAt);

      const due = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      expect(due).to.have.length(1);
      expect(due[0]!.request).to.deep.equal({ caseId, clientId });
      expect((await ClientRequestClaimRepo.findLapsed(joinedAt)).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("leaves a quoted claim alone: it waits for the client", async () => {
      const a = await join(lawyerIds[0]!, new Date(Date.now() - CLAIM_HOLD_MS + 60_000));
      await ClientRequestClaimRepo.quote(a, QUOTE);
      await prisma.clientRequestClaim.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("ends the claim and frees the place, without that lawyer", async () => {
      await join(lawyerIds[0]!, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      await join(lawyerIds[1]!);
      const [due] = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      const now = new Date();

      expect(await ClientRequestClaimRepo.lapse(due!, now)).to.equal(true);

      const claim = await claimRow(due!.id);
      expect(claim.outcome).to.equal("LAPSED");
      expect(claim.endedAt!.getTime()).to.equal(now.getTime());
      expect(await request()).to.deep.include({ status: "ROUTED", excludedLawyerIds: [lawyerIds[0]!] });
      expect(await prisma.clientRequestClaim.count({ where: { requestId, outcome: null } })).to.equal(1);
    });

    it("does nothing when the request moved on in the meantime", async () => {
      await join(lawyerIds[0]!, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      const [due] = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "WITHDRAWN" } });

      expect(await ClientRequestClaimRepo.lapse(due!, new Date())).to.equal(false);
      expect((await claimRow(due!.id)).outcome).to.equal(null);
    });
  });

  describe("OrganizationChargeRepo.confirm: the client picks one quote", () => {
    it("confirms that lawyer, records their fee, and ends the others as not chosen", async () => {
      const a = await join(lawyerIds[0]!);
      const b = await join(lawyerIds[1]!);
      const c = await join(lawyerIds[2]!);
      await ClientRequestClaimRepo.quote(a, QUOTE);
      await ClientRequestClaimRepo.quote(b, QUOTE);

      const confirmed = await OrganizationChargeRepo.confirm(requestId, b.id, { amountMinor: 5000, currency: "GBP" });

      expect(confirmed!.claim.id).to.equal(b.id);
      expect(confirmed!.notChosen.sort()).to.deep.equal([lawyerIds[0]!, lawyerIds[2]!].sort());
      expect(confirmed!.charge).to.deep.include({ lawyerId: lawyerIds[1], status: "PENDING", feeRequestId: requestId });
      expect((await request()).status).to.equal("CONFIRMED");
      expect((await claimRow(a.id)).outcome).to.equal("NOT_CHOSEN");
      expect((await claimRow(b.id)).outcome).to.equal(null);
      expect((await claimRow(c.id)).outcome).to.equal("NOT_CHOSEN");
      // So it never reaches them again, even if it's routed afresh after an unpaid fee.
      expect((await request()).excludedLawyerIds.sort()).to.deep.equal([lawyerIds[0]!, lawyerIds[2]!].sort());
    });

    it("refuses a quote that isn't open, and a second confirm", async () => {
      const a = await join(lawyerIds[0]!);
      const b = await join(lawyerIds[1]!);
      await ClientRequestClaimRepo.quote(a, QUOTE);

      expect(await OrganizationChargeRepo.confirm(requestId, b.id, { amountMinor: 5000, currency: "GBP" })).to.equal(null);
      expect((await request()).status).to.equal("ROUTED");
      expect(await OrganizationChargeRepo.confirm(requestId, a.id, { amountMinor: 5000, currency: "GBP" })).to.not.equal(null);
      expect(await OrganizationChargeRepo.confirm(requestId, a.id, { amountMinor: 5000, currency: "GBP" })).to.equal(null);
    });
  });

  describe("findUnpaid / lapseUnpaid (#933)", () => {
    /** The client confirmed `hoursAgo`, and the lawyer's per-case fee is `status`. */
    async function confirmedWithFee(hoursAgo: number, status: "FAILED" | "PENDING" = "FAILED") {
      const claim = await join(lawyerIds[0]!);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CONFIRMED" } });
      const fee = await prisma.organizationCharge.create({
        data: {
          organizationId: orgId,
          kind: "PER_CASE_FEE",
          status,
          amountMinor: 5000,
          currency: "GBP",
          requestId,
          feeRequestId: requestId,
          lawyerId: lawyerIds[0]!,
          failureReason: "Your card was declined.",
          createdAt: new Date(Date.now() - hoursAgo * HOUR_MS),
        },
      });
      return { claim, fee };
    }
    const dueFor = async () => (await ClientRequestClaimRepo.findUnpaid(new Date())).filter((u) => u.requestId === requestId);

    it("finds a confirmed request whose fee has failed for 48h, and not before", async () => {
      await confirmedWithFee(47);
      expect(await dueFor()).to.have.length(0);
      await prisma.organizationCharge.updateMany({ where: { requestId }, data: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } });
      const [due] = await dueFor();
      expect(due).to.deep.include({ requestId, caseId, clientId });
      expect(due!.claim.lawyerId).to.equal(lawyerIds[0]);
    });

    it("leaves a fee that's being retried alone", async () => {
      await confirmedWithFee(49, "PENDING");
      expect(await dueFor()).to.have.length(0);
    });

    it("ends the claim, puts the request back without that lawyer, and frees the request's fee slot", async () => {
      const { fee } = await confirmedWithFee(49);
      const [due] = await dueFor();
      const now = new Date();

      expect(await ClientRequestClaimRepo.lapseUnpaid(due!, now)).to.equal(true);

      expect((await claimRow(due!.claim.id)).outcome).to.equal("LAPSED");
      const r = await request();
      expect(r).to.deep.include({ status: "ROUTED", excludedLawyerIds: [lawyerIds[0]!], announcedAt: null, pickByAt: null });
      expect(r.routingExpiresAt!.getTime()).to.equal(now.getTime() + 48 * HOUR_MS);
      // The failed fee stays in the history, but the next lawyer's confirmation can record its own.
      expect(await prisma.organizationCharge.findUniqueOrThrow({ where: { id: fee.id } })).to.deep.include({ status: "FAILED", feeRequestId: null, requestId });
      await join(lawyerIds[1]!);
    });

    it("does nothing when a retry started in the meantime", async () => {
      await confirmedWithFee(49);
      const [due] = await dueFor();
      await prisma.organizationCharge.updateMany({ where: { requestId }, data: { status: "PENDING" } });

      expect(await ClientRequestClaimRepo.lapseUnpaid(due!, new Date())).to.equal(false);
      expect((await request()).status).to.equal("CONFIRMED");
      expect((await claimRow(due!.claim.id)).outcome).to.equal(null);
    });
  });

  describe("the #510 guards: nothing is sent twice", () => {
    const withBrief = () => prisma.clientRequest.update({ where: { id: requestId }, data: { brief: { summary: "x" }, briefGeneratedAt: new Date() } });

    it("claims a routed request's announcement once, and only once it has a brief", async () => {
      expect(await ClientRequestRepo.claimAnnouncement(requestId, new Date())).to.equal(false);
      await withBrief();
      expect((await ClientRequestRepo.findUnannounced(new Date())).map((r) => r.id)).to.include(requestId);

      const [first, second] = await Promise.all([ClientRequestRepo.claimAnnouncement(requestId, new Date()), ClientRequestRepo.claimAnnouncement(requestId, new Date())]);
      expect([first, second].filter(Boolean)).to.have.length(1);
      expect((await ClientRequestRepo.findUnannounced(new Date())).map((r) => r.id)).to.not.include(requestId);
    });

    it("expires a routed request once its 48h is over with nobody on it, and only then", async () => {
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(null);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });

      const due = (await ClientRequestRepo.findExpired(new Date())).find((r) => r.id === requestId);
      expect(due).to.deep.include({ caseId, clientId, pickByAt: null });
      expect(due!.client.email).to.equal(`claim-race-${clientId}@example.com`);
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.deep.equal([]);
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(null);
      expect((await request()).status).to.equal("EXPIRED");
    });

    it("doesn't expire a request with a lawyer on it when the 48h end", async () => {
      await join(lawyerIds[0]!);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(null);
    });

    it("expires a request the client didn't pick a quote on in time, ending the open claims as not chosen", async () => {
      const a = await join(lawyerIds[0]!);
      await ClientRequestClaimRepo.quote(a, QUOTE);
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(null);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { pickByAt: new Date(Date.now() - 1000) } });

      expect((await ClientRequestRepo.findExpired(new Date())).map((r) => r.id)).to.include(requestId);
      // The lawyers whose claims it ended, so they can be told.
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.deep.equal([lawyerIds[0]]);
      expect((await claimRow(a.id)).outcome).to.equal("NOT_CHOSEN");
    });

    it("finds an unquoted claim within 2h of ending, and marks its reminder sent once", async () => {
      const now = new Date();
      // Joined 22h30m ago: 1h30m left.
      await join(lawyerIds[0]!, new Date(now.getTime() - CLAIM_HOLD_MS + 90 * 60 * 1000));

      const due = (await ClientRequestClaimRepo.findDueReminders(now)).filter((c) => c.requestId === requestId);
      expect(due).to.have.length(1);
      expect(due[0]!.lawyer.email).to.equal(`claim-race-${lawyerIds[0]}@example.com`);
      expect(await ClientRequestClaimRepo.markReminderSent(due[0]!.id, now)).to.equal(true);
      expect(await ClientRequestClaimRepo.markReminderSent(due[0]!.id, now)).to.equal(false);
      expect((await ClientRequestClaimRepo.findDueReminders(now)).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("doesn't remind for a claim with more than 2h left", async () => {
      await join(lawyerIds[0]!);
      expect((await ClientRequestClaimRepo.findDueReminders(new Date())).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });
  });

  it("ends every open claim when the client withdraws the request", async () => {
    const a = await join(lawyerIds[0]!);
    const b = await join(lawyerIds[1]!);
    const now = new Date();

    const result = await ClientRequestRepo.withdraw(requestId, ["ROUTED"], now);
    expect(result.moved).to.equal(true);
    expect(result.heldBy.sort()).to.deep.equal([lawyerIds[0]!, lawyerIds[1]!].sort());

    expect((await claimRow(a.id)).outcome).to.equal("WITHDRAWN");
    expect((await claimRow(b.id)).outcome).to.equal("WITHDRAWN");
    expect((await request()).status).to.equal("WITHDRAWN");
    expect(await ClientRequestRepo.withdraw(requestId, ["ROUTED"], now)).to.deep.equal({ moved: false, heldBy: [] });
  });
});
