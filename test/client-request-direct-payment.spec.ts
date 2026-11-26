/** On the KR site the client pays the hired lawyer directly (FORHU/ilovelawyer-api#695): accepting a
 * quote engages the lawyer at once, nothing is paid through ilovelawyer (no QuotationPayment, no
 * earning), POST .../payment is refused, and both views say so. The UK's pay-to-engage flow is in
 * client-request-confirm-route.spec.ts. Through the real routes against the real database, with its
 * own KR firm, lawyer, client, case and request. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import { givePracticeArea } from "./support/practice-area-fixture";
import { sentQuotation, cleanQuotationMoney } from "./support/quotation-fixture";
import { paysLawyerDirectly } from "../src/constants/client-request.constants";

const HOUR_MS = 60 * 60 * 1000;

describe("KR: the client pays the lawyer directly", () => {
  const lawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const clientOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;
  let quotationId: string;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const confirm = () => request(app).post(`/api/client/lawyer-requests/${requestId}/confirm`).set(auth(clientId)).send({ disclosureAcknowledged: true });
  const pay = () => request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/payment`).set(auth(clientId)).send({});
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set({ ...auth(lawyerId), "X-Organization-Id": orgId });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "KR" }, update: {}, create: { code: "KR", name: "South Korea" } });
    const user = (id: string, name: string, role: "LAWYER" | "USER") => ({ id, email: `direct-${id}@example.com`, username: `direct-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({ data: [user(lawyerId, "김변호사", "LAWYER"), user(clientId, "이의뢰인", "USER")] });
    await prisma.organization.create({
      data: { id: orgId, name: "김 법률사무소", slug: `direct-${orgId}`, tenantId: tenant.id, createdById: lawyerId, members: { create: { userId: lawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.organization.create({
      data: { id: clientOrgId, name: "이의뢰인", slug: `direct-${clientOrgId}`, tenantId: tenant.id, createdById: clientId, isPersonal: true, members: { create: { userId: clientId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.lawyerClientProfile.create({ data: { userId: lawyerId, acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date(), country: "KR" } });
    await givePracticeArea([lawyerId]);
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: clientOrgId, caseName: "임대차 분쟁", caseAreas: ["TAX"] } });
  });

  after(async () => {
    await cleanQuotationMoney({ organizationIds: [orgId] }, [clientId]);
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: lawyerId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, clientOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, clientId] } } });
  });

  beforeEach(async () => {
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: lawyerId } });
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: {
        caseId,
        clientId,
        consentVersion: "test",
        consentAcceptedAt: now,
        status: "ROUTED",
        routedAt: now,
        routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS),
        pickByAt: new Date(now.getTime() + 7 * 24 * HOUR_MS),
      },
    });
    requestId = row.id;
    const claim = await prisma.clientRequestClaim.create({
      data: {
        requestId,
        lawyerId,
        organizationId: orgId,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + 24 * HOUR_MS),
        quoteType: "FIXED_FEE",
        quoteAmountMinor: 300_000,
        quoteCurrency: "KRW",
        quoteMessage: "정액 보수.",
        quotedAt: now,
      },
    });
    quotationId = (await sentQuotation(claim, 300_000)).id;
  });

  it("is KR only", () => {
    expect(paysLawyerDirectly("KR")).to.equal(true);
    for (const site of ["UK", "PH", null, undefined]) expect(paysLawyerDirectly(site)).to.equal(false);
  });

  it("engages the lawyer as soon as the client accepts, with nothing paid through ilovelawyer", async () => {
    const { body } = await confirm().expect(200);
    expect(body).to.deep.include({ status: "ENGAGED", awaitingPayment: false, paysLawyerDirectly: true });
    expect(body.referralDisclosure).to.include("직접");

    const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true } });
    expect(row.status).to.equal("ENGAGED");
    expect(row.claims[0]).to.deep.include({ outcome: "ENGAGED" });
    const quotation = await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    // The agreed amount stays on record; the client pays it to the lawyer, not to ilovelawyer.
    expect(quotation).to.deep.include({ status: "PAID", acceptedAmountMinor: 300_000 });
    expect(await prisma.quotationPayment.count({ where: { quotationId } })).to.equal(0);
    expect(await prisma.earning.count({ where: { quotationId } })).to.equal(0);
  });

  it("tells the lawyer they're engaged and to arrange their fee directly, never to wait for a payment", async () => {
    await confirm().expect(200);
    const notes = await prisma.notification.findMany({ where: { userId: lawyerId }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => n.title)).to.deep.equal(["의뢰인 요청이 수임되었습니다"]);
    expect(notes[0]!.message).to.include("직접");
  });

  it("refuses to take a payment for the lawyer's fee", async () => {
    await confirm().expect(200);
    const { body } = await pay().expect(409);
    expect(body.code).to.equal("LAWYER_FEES_DIRECT");
    expect(await prisma.quotationPayment.count({ where: { quotationId } })).to.equal(0);
  });

  it("says so in both views", async () => {
    expect((await clientView().expect(200)).body.paysLawyerDirectly).to.equal(true);
    expect((await lawyerView().expect(200)).body.paysLawyerDirectly).to.equal(true);
  });

  it("shows the lawyer no platform fee and no introduction fee (#694)", async () => {
    const { body } = await lawyerView().expect(200);
    expect(body.quoteTerms).to.deep.equal({ platformFeeBps: 0, minPlatformFee: { amountMinor: 0, currency: "KRW" } });
    expect(body.perCaseFee.amountMinor).to.equal(0);
  });
});
