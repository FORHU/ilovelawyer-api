/** ClientRequestClaimRepo.claim — the race-safe first claim (#511). Runs against the real database,
 * like test/audit-event-repository.spec.ts: the race can only be shown against Postgres. It makes
 * its own users, organization, case and request, and removes them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import prisma from "../src/lib/prisma";
import ClientRequestClaimRepo, { CLAIM_HOLD_MS } from "../src/repositories/client-request-claim.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";

const HOUR_MS = 60 * 60 * 1000;
const LAWYERS = 8;

describe("ClientRequestClaimRepo.claim", () => {
  const clientId = crypto.randomUUID();
  const lawyerIds = Array.from({ length: LAWYERS }, () => crypto.randomUUID());
  const orgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [clientId, ...lawyerIds].map((id) => ({ id, email: `claim-race-${id}@example.com`, username: `claim-race-${id}` })),
    });
    await prisma.organization.create({ data: { id: orgId, name: "Claim Race Org", slug: `claim-race-${orgId}`, createdById: lawyerIds[0]!, tenantId: tenant.id } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: orgId, caseName: "Claim Race Case" } });
  });

  beforeEach(async () => {
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    const request = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED", routingExpiresAt: new Date(Date.now() + 48 * HOUR_MS) },
    });
    requestId = request.id;
  });

  after(async () => {
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.delete({ where: { id: caseId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: [clientId, ...lawyerIds] } } });
  });

  it("lets exactly one of many simultaneous claims win", async () => {
    const results = await Promise.all(lawyerIds.map((lawyerId) => ClientRequestClaimRepo.claim(requestId, lawyerId, orgId)));

    const won = results.filter((r) => r !== null);
    expect(won).to.have.length(1);
    const claims = await prisma.clientRequestClaim.findMany({ where: { requestId } });
    expect(claims).to.have.length(1);
    expect(claims[0]!.lawyerId).to.equal(won[0]!.lawyerId);
    expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal("CLAIMED");
  });

  it("holds the request for 24h from the claim", async () => {
    const now = new Date();
    const claim = await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, now);

    expect(claim!.claimedAt.getTime()).to.equal(now.getTime());
    expect(claim!.expiresAt.getTime()).to.equal(now.getTime() + 24 * HOUR_MS);
    expect(CLAIM_HOLD_MS).to.equal(24 * HOUR_MS);
    expect(claim!.outcome).to.equal(null);
  });

  it("refuses once the 48h routing window is over, even before the sweep has expired it", async () => {
    await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });

    expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.equal(null);
    expect(await prisma.clientRequestClaim.count({ where: { requestId } })).to.equal(0);
  });

  it("refuses a lawyer who passed on the request or held it before", async () => {
    await prisma.clientRequest.update({ where: { id: requestId }, data: { excludedLawyerIds: [lawyerIds[0]!] } });

    expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.equal(null);
    expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[1]!, orgId)).to.not.equal(null);
  });

  describe("findLapsed / lapse", () => {
    it("finds a CLAIMED request's hold once it's over, and not before", async () => {
      const claimedAt = new Date(Date.now() - CLAIM_HOLD_MS - 1000);
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, claimedAt);

      const due = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      expect(due).to.have.length(1);
      expect(due[0]!.request).to.deep.equal({ caseId, clientId });
      expect((await ClientRequestClaimRepo.findLapsed(claimedAt)).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("leaves a QUOTED request's hold alone (whether QUOTED lapses is still open, #512)", async () => {
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "QUOTED" } });

      expect((await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("ends the claim and puts the request back in the pool for 48h, without that lawyer", async () => {
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      await prisma.clientRequest.update({ where: { id: requestId }, data: { announcedAt: new Date() } });
      const [due] = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      const now = new Date();

      expect(await ClientRequestClaimRepo.lapse(due!, now)).to.equal(true);

      const claim = await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: due!.id } });
      expect(claim).to.deep.include({ outcome: "LAPSED", openRequestId: null });
      expect(claim.endedAt!.getTime()).to.equal(now.getTime());
      const request = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(request).to.deep.include({ status: "ROUTED", excludedLawyerIds: [lawyerIds[0]!], announcedAt: null });
      expect(request.routedAt!.getTime()).to.equal(now.getTime());
      expect(request.routingExpiresAt!.getTime()).to.equal(now.getTime() + 48 * HOUR_MS);
      // Back in the pool: another lawyer can win it now; the one who lapsed can't.
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId)).to.equal(null);
      expect(await ClientRequestClaimRepo.claim(requestId, lawyerIds[1]!, orgId)).to.not.equal(null);
    });

    it("does nothing when the request moved on in the meantime", async () => {
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, new Date(Date.now() - CLAIM_HOLD_MS - 1000));
      const [due] = (await ClientRequestClaimRepo.findLapsed(new Date())).filter((c) => c.requestId === requestId);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "QUOTED" } });

      expect(await ClientRequestClaimRepo.lapse(due!, new Date())).to.equal(false);
      expect((await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: due!.id } })).outcome).to.equal(null);
      expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal("QUOTED");
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

    it("doesn't announce a request someone already claimed", async () => {
      await withBrief();
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId);
      expect(await ClientRequestRepo.claimAnnouncement(requestId, new Date())).to.equal(false);
    });

    it("expires a routed request once its 48h is over, and only then", async () => {
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(false);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });

      const due = (await ClientRequestRepo.findExpired(new Date())).find((r) => r.id === requestId);
      expect(due).to.deep.include({ caseId, clientId });
      expect(due!.client.email).to.equal(`claim-race-${clientId}@example.com`);
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(true);
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(false);
      expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal("EXPIRED");
    });

    it("never expires a claimed request, even past its routing window", async () => {
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId);
      await prisma.clientRequest.update({ where: { id: requestId }, data: { routingExpiresAt: new Date(Date.now() - 1000) } });
      expect(await ClientRequestRepo.expire(requestId, new Date())).to.equal(false);
    });

    it("finds a hold within 2h of ending, and marks its reminder sent once", async () => {
      const now = new Date();
      // Claimed 22h30m ago: 1h30m left.
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId, new Date(now.getTime() - CLAIM_HOLD_MS + 90 * 60 * 1000));

      const due = (await ClientRequestClaimRepo.findDueReminders(now)).filter((c) => c.requestId === requestId);
      expect(due).to.have.length(1);
      expect(due[0]!.lawyer.email).to.equal(`claim-race-${lawyerIds[0]}@example.com`);
      expect(await ClientRequestClaimRepo.markReminderSent(due[0]!.id, now)).to.equal(true);
      expect(await ClientRequestClaimRepo.markReminderSent(due[0]!.id, now)).to.equal(false);
      expect((await ClientRequestClaimRepo.findDueReminders(now)).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });

    it("doesn't remind for a hold with more than 2h left", async () => {
      await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId);
      expect((await ClientRequestClaimRepo.findDueReminders(new Date())).filter((c) => c.requestId === requestId)).to.deep.equal([]);
    });
  });

  it("ends the open claim when the client withdraws the request", async () => {
    const claim = await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId);
    const now = new Date();

    expect(await ClientRequestRepo.withdraw(requestId, ["ROUTED", "CLAIMED"], now)).to.deep.equal({ moved: true, heldBy: lawyerIds[0] });

    expect(await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: claim!.id } })).to.deep.include({ outcome: "WITHDRAWN", openRequestId: null });
    expect(await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).to.deep.include({ status: "WITHDRAWN" });
    expect(await ClientRequestRepo.withdraw(requestId, ["ROUTED", "CLAIMED"], now)).to.deep.equal({ moved: false, heldBy: null });
  });

  it("refuses a second open claim on the same request at the database", async () => {
    await ClientRequestClaimRepo.claim(requestId, lawyerIds[0]!, orgId);
    // Straight past the guarded update, as a bug elsewhere might: the unique open-claim key stops it.
    const sneak = prisma.clientRequestClaim.create({
      data: { requestId, openRequestId: requestId, lawyerId: lawyerIds[1]!, organizationId: orgId, expiresAt: new Date(Date.now() + CLAIM_HOLD_MS) },
    });

    let error: any;
    await sneak.catch((err) => (error = err));
    expect(error?.code).to.equal("P2002");
  });
});
