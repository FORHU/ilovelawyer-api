/** The conflict check, release and quote on a claimed client request (#512), through the real routes
 * against the real database: GET /client-requests/:id/parties, POST .../release, POST .../quote, and
 * the client app reading the quote and the lawyer (GET /client/lawyer-requests/:id). Makes its own
 * UK organization, lawyers, client, case and request, and removes them. Security audit rows are
 * captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import ClaimRepo, { CLAIM_HOLD_MS } from "../src/repositories/client-request-claim.repository";
import RequestRepo from "../src/repositories/client-request.repository";
import { CLIENT_REQUEST_REFERRAL_DISCLOSURE } from "../src/constants/client-request.constants";

const HOUR_MS = 60 * 60 * 1000;

describe("client request conflict check, release and quote", () => {
  const lawyerId = crypto.randomUUID();
  const otherLawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;
  let auditRows: any[];
  let savedAuditCreate: unknown;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = (id: string, org: string) => ({ ...auth(id), "X-Organization-Id": org });
  const claim = (id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/claim`).set(asLawyer(id, org));
  const parties = (id = lawyerId, org = orgId) => request(app).get(`/api/client-requests/${requestId}/parties`).set(asLawyer(id, org));
  const release = (body: object, id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/release`).set(asLawyer(id, org)).send(body);
  const quote = (body: object, id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/quote`).set(asLawyer(id, org)).send(body);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));

  const FIXED_FEE = { type: "FIXED_FEE", amount: { amountMinor: 75000, currency: "GBP" }, message: "  I can take this on for a fixed fee.  " };

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [
        { id: lawyerId, email: `quote-lawyer-${lawyerId}@example.com`, username: `quote-lawyer-${lawyerId}`, name: "Lena Lawyer", role: "LAWYER", tenantId: tenant.id },
        { id: otherLawyerId, email: `quote-other-${otherLawyerId}@example.com`, username: `quote-other-${otherLawyerId}`, name: "Omar Other", role: "LAWYER", tenantId: tenant.id },
        { id: clientId, email: `quote-client-${clientId}@example.com`, username: `quote-client-${clientId}`, name: "Clara Client", role: "USER", tenantId: tenant.id },
      ],
    });
    for (const [id, owner, name] of [
      [orgId, lawyerId, "Lena Law LLP"],
      [otherOrgId, otherLawyerId, "Other Firm"],
    ] as const) {
      await prisma.organization.create({
        data: { id, name, slug: `quote-${id}`, tenantId: tenant.id, createdById: owner, members: { create: { userId: owner, role: "OWNER", status: "ACCEPTED" } } },
      });
    }
    const profile = {
      practiceAreas: ["EMPLOYMENT"],
      languages: ["English"],
      acceptingRequests: true,
      verificationStatus: "VERIFIED" as const,
      verifiedAt: new Date("2026-10-01T00:00:00Z"),
    };
    await prisma.lawyerClientProfile.createMany({
      data: [
        { ...profile, userId: lawyerId, bio: "Employment law for 12 years.", firstConsultationFeeMinor: 15000 },
        { ...profile, userId: otherLawyerId },
      ],
    });
    const registration = { regulator: "SRA", qualifiedJurisdictions: ["England and Wales"] };
    await prisma.lawyerUkRegistration.createMany({
      data: [
        { ...registration, userId: lawyerId, registrationNumber: "123456" },
        { ...registration, userId: otherLawyerId, registrationNumber: "654321" },
      ],
    });
    await prisma.case.create({
      data: {
        id: caseId,
        userId: clientId,
        caseName: "Unfair dismissal",
        practiceArea: "EMPLOYMENT",
        ukJurisdiction: "England and Wales",
        parties: { create: [{ name: "Acme Widgets Ltd", designation: "Employer" }, { name: "Dan Manager", designation: "Witness" }] },
      },
    });
    // A quote needs a card on file for the fee confirming will charge (#933).
    for (const id of [orgId, otherOrgId]) {
      await prisma.organizationBilling.create({ data: { organizationId: id, provider: "DUMMY", customerId: `cus_${id}`, paymentMethodId: `pm_${id}`, brand: "visa", last4: "4242" } });
    }
  });

  after(async () => {
    await prisma.organizationBilling.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { OR: [{ id: { in: [orgId, otherOrgId] } }, { createdById: clientId }] } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, otherLawyerId, clientId] } } });
  });

  beforeEach(async () => {
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    const row = await prisma.clientRequest.create({
      data: {
        caseId,
        clientId,
        consentVersion: "test",
        consentAcceptedAt: new Date(),
        status: "ROUTED",
        routedAt: new Date(),
        routingExpiresAt: new Date(Date.now() + 48 * HOUR_MS),
        brief: { summary: "Dismissed after raising a grievance.", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales", urgency: "SOON" },
        briefGeneratedAt: new Date(),
      },
    });
    requestId = row.id;
    // Both lawyers here are in a firm, so client requests for firms must be on (#558).
    process.env.CLIENT_REQUESTS_FOR_FIRMS = "true";
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
  });

  afterEach(() => {
    (SecurityAuditRepo as any).create = savedAuditCreate;
    delete process.env.CLIENT_REQUESTS_FOR_FIRMS;
  });

  describe("party names for the conflict check", () => {
    it("are for the lawyer holding the claim, with the client first, and every read is audited", async () => {
      await claim().expect(200);
      const { body } = await parties().expect(200);
      expect(body.parties[0]).to.deep.equal({ name: "Clara Client", role: "Client" });
      expect(body.parties.slice(1)).to.have.deep.members([
        { name: "Acme Widgets Ltd", role: "Employer" },
        { name: "Dan Manager", role: "Witness" },
      ]);
      const viewed = auditRows.filter((r) => r.action === "client_request.parties_viewed");
      expect(viewed).to.have.length(1);
      expect(viewed[0]).to.deep.include({ actorId: lawyerId, organizationId: orgId, targetType: "case", targetId: caseId, caseId });
      expect(viewed[0].payload).to.deep.include({ requestId, parties: 3 });
    });

    it("are hidden from a lawyer who doesn't hold it, before any claim and after", async () => {
      await parties().expect(404);
      await claim().expect(200);
      await parties(otherLawyerId, otherOrgId).expect(404);
      expect(auditRows.filter((r) => r.action === "client_request.parties_viewed")).to.have.length(0);
    });

    it("stop once the 24h hold is over, even before the sweep lapses it", async () => {
      await claim().expect(200);
      await prisma.clientRequestClaim.updateMany({ where: { requestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await parties().expect(409);
      expect(res.body.code).to.equal("CLAIM_EXPIRED");
    });

    it("stay readable while QUOTED, and stop once the lawyer has released it", async () => {
      await claim().expect(200);
      await quote(FIXED_FEE).expect(200);
      await parties().expect(200);
      await release({ reason: "CONFLICT" }).expect(200);
      const res = await parties().expect(409);
      expect(res.body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("release", () => {
    it("ends the claim RELEASED, routes the request again without this lawyer, and audits it", async () => {
      await claim().expect(200);
      const before = Date.now();
      const { body } = await release({ reason: "CONFLICT", note: "  Acts for Acme already.  " }).expect(200);
      expect(body.status).to.equal("ROUTED");

      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true } });
      expect(row.status).to.equal("ROUTED");
      expect(row.excludedLawyerIds).to.include(lawyerId);
      expect(row.announcedAt).to.equal(null);
      expect(row.routingExpiresAt!.getTime()).to.be.at.least(before + 48 * HOUR_MS - 5000);
      expect(row.claims[0]).to.deep.include({ outcome: "RELEASED", releaseReason: "CONFLICT", releaseNote: "Acts for Acme already.", openRequestId: null });

      const released = auditRows.filter((r) => r.action === "client_request.released");
      expect(released).to.have.length(1);
      expect(released[0].payload).to.deep.equal({ requestId, claimId: row.claims[0]!.id, reason: "CONFLICT" });
      // The note may name the conflict, so it stays out of the audit log and the case feed.
      const feed = await prisma.auditEvent.findMany({ where: { caseId, action: "client_request.released" } });
      expect(JSON.stringify([released, feed])).to.not.contain("Acme already");
    });

    it("lets another lawyer claim it next, but not the one who released it", async () => {
      await claim().expect(200);
      await release({ reason: "CAPACITY" }).expect(200);
      expect((await claim().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
      await claim(otherLawyerId, otherOrgId).expect(200);
    });

    it("works from QUOTED too, and the client no longer sees the quote", async () => {
      await claim().expect(200);
      await quote(FIXED_FEE).expect(200);
      await release({ reason: "OUT_OF_SCOPE" }).expect(200);
      const { body } = await clientView().expect(200);
      expect(body).to.deep.include({ status: "ROUTED", lawyer: null, quote: null, referralDisclosure: null });
    });

    it("needs a known reason", async () => {
      await claim().expect(200);
      await release({}).expect(400);
      await release({ reason: "BORED" }).expect(400);
    });

    it("refuses a lawyer who doesn't hold it, and a second release", async () => {
      await claim().expect(200);
      await release({ reason: "OTHER" }, otherLawyerId, otherOrgId).expect(404);
      await release({ reason: "OTHER" }).expect(200);
      expect((await release({ reason: "OTHER" }).expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("quote", () => {
    it("moves the request to QUOTED and shows the lawyer their quote", async () => {
      await claim().expect(200);
      const { body } = await quote(FIXED_FEE).expect(200);
      expect(body.status).to.equal("QUOTED");
      expect(body.quote).to.deep.include({ type: "FIXED_FEE", amount: { amountMinor: 75000, currency: "GBP" }, message: "I can take this on for a fixed fee." });
      expect(body.quote.sentAt).to.be.a("string");
      const feed = await prisma.auditEvent.findMany({ where: { caseId, action: "client_request.quoted", payload: { path: ["requestId"], equals: requestId } } });
      expect(feed).to.have.length(1);
    });

    it("lets the client read the quote, the lawyer's public profile and the referral disclosure", async () => {
      expect((await clientView().expect(200)).body).to.deep.include({ lawyer: null, quote: null, referralDisclosure: null });
      await claim().expect(200);
      // Claimed but not quoted: the client still sees nobody.
      expect((await clientView().expect(200)).body).to.deep.include({ status: "CLAIMED", lawyer: null, quote: null });
      await quote({ type: "FIRST_CONSULTATION", amount: { amountMinor: 0, currency: "GBP" }, message: "Free first call this week." }).expect(200);

      const { body } = await clientView().expect(200);
      expect(body.status).to.equal("QUOTED");
      expect(body.quote).to.deep.include({ type: "FIRST_CONSULTATION", amount: { amountMinor: 0, currency: "GBP" }, message: "Free first call this week." });
      expect(body.referralDisclosure).to.equal(CLIENT_REQUEST_REFERRAL_DISCLOSURE);
      expect(body.lawyer).to.deep.equal({
        id: lawyerId,
        name: "Lena Lawyer",
        avatarUrl: null,
        firmName: "Lena Law LLP",
        regulator: "SRA",
        registrationNumber: "123456",
        practiceAreas: ["EMPLOYMENT"],
        qualifiedJurisdictions: ["England and Wales"],
        languages: ["English"],
        bio: "Employment law for 12 years.",
        firstConsultationFee: { amountMinor: 15000, currency: "GBP" },
        verifiedAt: "2026-10-01T00:00:00.000Z",
      });
      // The client's list shows the same.
      const list = await request(app).get(`/api/client/lawyer-requests?caseId=${caseId}`).set(auth(clientId)).expect(200);
      expect(list.body.data[0].lawyer.id).to.equal(lawyerId);
    });

    it("doesn't name a solo practitioner's personal workspace as a firm", async () => {
      await prisma.organization.update({ where: { id: orgId }, data: { isPersonal: true } });
      try {
        await claim().expect(200);
        await quote(FIXED_FEE).expect(200);
        expect((await clientView().expect(200)).body.lawyer.firmName).to.equal(null);
      } finally {
        await prisma.organization.update({ where: { id: orgId }, data: { isPersonal: false } });
      }
    });

    it("is sent once: a second quote is refused", async () => {
      await claim().expect(200);
      await quote(FIXED_FEE).expect(200);
      expect((await quote(FIXED_FEE).expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("refuses once the 24h hold is over, and changes nothing", async () => {
      await claim().expect(200);
      await prisma.clientRequestClaim.updateMany({ where: { requestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await quote(FIXED_FEE).expect(409)).body.code).to.equal("CLAIM_EXPIRED");
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true } });
      expect(row.status).to.equal("CLAIMED");
      expect(row.claims[0]!.quotedAt).to.equal(null);
    });

    it("refuses a lawyer who doesn't hold it", async () => {
      await claim().expect(200);
      await quote(FIXED_FEE, otherLawyerId, otherOrgId).expect(404);
    });

    // #933: the client only ever sees a quote whose introduction fee can be charged.
    it("needs a card on file: accepting doesn't, sending the quote does (402 CARD_REQUIRED)", async () => {
      await prisma.organizationBilling.update({ where: { organizationId: orgId }, data: { paymentMethodId: null } });
      try {
        await claim().expect(200);
        const { body } = await quote(FIXED_FEE).expect(402);
        expect(body.code).to.equal("CARD_REQUIRED");
        const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true } });
        expect(row.status).to.equal("CLAIMED");
        expect(row.claims[0]!.quotedAt).to.equal(null);
      } finally {
        await prisma.organizationBilling.update({ where: { organizationId: orgId }, data: { paymentMethodId: `pm_${orgId}` } });
      }
      await quote(FIXED_FEE).expect(200);
    });

    it("checks the quote: type, GBP, a message, and an amount for a fixed fee", async () => {
      await claim().expect(200);
      await quote({ ...FIXED_FEE, type: "HOURLY" }).expect(400);
      await quote({ ...FIXED_FEE, amount: { amountMinor: 75000, currency: "USD" } }).expect(400);
      await quote({ ...FIXED_FEE, amount: { amountMinor: 12.5, currency: "GBP" } }).expect(400);
      await quote({ ...FIXED_FEE, message: "   " }).expect(400);
      await quote({ ...FIXED_FEE, amount: { amountMinor: 0, currency: "GBP" } }).expect(400);
      expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal("CLAIMED");
    });
  });

  describe("racing other changes to the same request", () => {
    const ROUNDS = 15;

    /** A fresh routed request with an open claim by `lawyerId`, made straight in the database. */
    async function freshClaim() {
      await prisma.clientRequest.deleteMany({ where: { caseId } });
      const row = await prisma.clientRequest.create({
        data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED", routingExpiresAt: new Date(Date.now() + 48 * HOUR_MS) },
      });
      const open = (await ClaimRepo.claim(row.id, lawyerId, orgId))!;
      return { requestId: row.id, claimId: open.id };
    }

    it("never both quotes and lapses the same claim, and never deadlocks", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await freshClaim();
        const [quoted, lapsed] = await Promise.all([
          ClaimRepo.quote({ id: r.claimId, requestId: r.requestId }, { type: "FIXED_FEE", amountMinor: 100, currency: "GBP", message: "x" }),
          ClaimRepo.lapse({ id: r.claimId, requestId: r.requestId, lawyerId }),
        ]);
        expect([quoted, lapsed].filter(Boolean), `round ${round}`).to.have.length(1);
        const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { claims: true } });
        expect(row.status).to.equal(quoted ? "QUOTED" : "ROUTED");
        expect(row.claims[0]!.outcome).to.equal(quoted ? null : "LAPSED");
      }
      expect(CLAIM_HOLD_MS).to.equal(24 * HOUR_MS);
    });

    it("never both releases and withdraws the same request, and never deadlocks", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await freshClaim();
        const [released, withdrawn] = await Promise.all([
          ClaimRepo.release({ id: r.claimId, requestId: r.requestId, lawyerId }, { reason: "CAPACITY", note: null }),
          RequestRepo.withdraw(r.requestId, ["CLAIMED", "QUOTED"]),
        ]);
        expect([released, withdrawn.moved].filter(Boolean), `round ${round}`).to.have.length(1);
        const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { claims: true } });
        expect(row.status).to.equal(released ? "ROUTED" : "WITHDRAWN");
        expect(row.claims[0]!.outcome).to.equal(released ? "RELEASED" : "WITHDRAWN");
      }
    });
  });
});
