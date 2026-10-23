/** The engagement's AI budget meter and the block on further AI work once it's spent (#515):
 * GET /client-requests/:id/ai-budget, and the 403 ENGAGEMENT_AI_BUDGET_SPENT a write that would
 * start AI work gets once the lawyer's workspace copy has used it all. Through the real routes
 * against the real database, reusing the engage-then-copy flow #514's tests already cover. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import CaseCopyQueue from "../src/queues/case-copy.queue";
import { caseSpendLimit } from "../src/middleware/case-spend-limit.middleware";
import EngagementAiBudgetSvc from "../src/services/engagement-ai-budget.service";
import { ENGAGEMENT_AI_BUDGET_GBP_PER_USD, ENGAGEMENT_AI_BUDGET_INCLUDED_USD } from "../src/config";
import { setOrganizationCardProvider, type CardChargeRequest, type CardChargeResult, type HostedOrganizationCardProvider } from "../src/payments/organization-card-provider";

const INCLUDED_MINOR = Math.round(ENGAGEMENT_AI_BUDGET_INCLUDED_USD * ENGAGEMENT_AI_BUDGET_GBP_PER_USD * 100);

describe("engagement AI budget", () => {
  const lawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;
  let copyCaseId: string;

  const fakeStripe: HostedOrganizationCardProvider = {
    name: "STRIPE",
    mode: "hosted",
    async startSetup() {
      throw new Error("not used");
    },
    async completedSetup() {
      return null;
    },
    async makeDefault() {},
    async charge(req: CardChargeRequest): Promise<CardChargeResult> {
      return { status: "SUCCEEDED", paymentIntentId: `pi_${req.attempt}`, receiptUrl: "https://pay.stripe.com/receipts/x", failureReason: null };
    },
    async chargeStatus() {
      return { status: "PENDING", paymentIntentId: null, receiptUrl: null, failureReason: null };
    },
    async refund() {
      throw new Error("not used");
    },
  };

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = { ...auth(lawyerId), "X-Organization-Id": orgId };
  const confirm = () => request(app).post(`/api/client/lawyer-requests/${requestId}/confirm`).set(auth(clientId)).send({ disclosureAcknowledged: true });
  const copy = () => request(app).post(`/api/client-requests/${requestId}/copy`).set(asLawyer);
  const aiBudget = () => request(app).get(`/api/client-requests/${requestId}/ai-budget`).set(asLawyer);
  const uploadToCopy = () => request(app).post(`/api/my-cases/${copyCaseId}/documents`).set(asLawyer).send({ key: "k1", name: "doc.pdf" });

  const spend = async (caseIdToSpend: string, usd: number) =>
    prisma.llmUsage.create({
      data: { provider: "OPENAI", feature: "chat", source: "ESTIMATED", inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: usd, caseId: caseIdToSpend },
    });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [
        { id: lawyerId, email: `budget-lawyer-${lawyerId}@example.com`, username: `budget-lawyer-${lawyerId}`, name: "Lena Lawyer", role: "LAWYER", tenantId: tenant.id },
        { id: clientId, email: `budget-client-${clientId}@example.com`, username: `budget-client-${clientId}`, name: "Clara Client", role: "USER", tenantId: tenant.id },
      ],
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Lena Law LLP", slug: `budget-${orgId}`, tenantId: tenant.id, createdById: lawyerId, members: { create: { userId: lawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.lawyerClientProfile.create({
      data: { userId: lawyerId, practiceAreas: ["EMPLOYMENT"], acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date() },
    });
    await prisma.lawyerUkRegistration.create({ data: { userId: lawyerId, regulator: "SRA", registrationNumber: "999", qualifiedJurisdictions: ["England and Wales"] } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Budget test case", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" } });
    await prisma.organizationBilling.create({ data: { organizationId: orgId, provider: "STRIPE", customerId: "cus_budget", paymentMethodId: "stripe_pm_budget", brand: "visa", last4: "4242" } });
  });

  after(async () => {
    await prisma.llmUsage.deleteMany({ where: { OR: [{ caseId }, { caseId: copyCaseId }] } });
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { OR: [{ id: caseId }, { copiedFromCaseId: caseId }] } });
    await prisma.organizationBilling.deleteMany({ where: { organizationId: orgId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: lawyerId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { OR: [{ id: orgId }, { createdById: clientId }] } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, clientId] } } });
  });

  beforeEach(async () => {
    setOrganizationCardProvider(fakeStripe);
    await prisma.llmUsage.deleteMany({ where: { OR: [{ caseId }, { caseId: copyCaseId ?? "none" }] } });
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });

    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "QUOTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * 3_600_000) },
    });
    requestId = row.id;
    await prisma.clientRequestClaim.create({
      data: { requestId, openRequestId: requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 86_400_000), quoteType: "FIXED_FEE", quoteAmountMinor: 75000, quoteCurrency: "GBP", quoteMessage: "Fixed fee.", quotedAt: now },
    });
    await confirm().expect(200);
    const { body } = await copy().expect(202);
    await CaseCopyQueue.tick();
    copyCaseId = (await prisma.caseCopy.findUniqueOrThrow({ where: { id: body.caseCopyId } })).copyCaseId!;
  });

  describe("GET /client-requests/:id/ai-budget", () => {
    it("starts OK, fully included, before any AI use", async () => {
      const { body } = await aiBudget().expect(200);
      expect(body.included).to.deep.equal({ amountMinor: INCLUDED_MINOR, currency: "GBP" });
      expect(body.used).to.deep.equal({ amountMinor: 0, currency: "GBP" });
      expect(body.remaining).to.deep.equal({ amountMinor: INCLUDED_MINOR, currency: "GBP" });
      expect(body.state).to.equal("OK");
    });

    it("attributes usage on the workspace copy, not the client's own case", async () => {
      await spend(caseId, 100); // on the client's case, never AI'd on; shouldn't count
      await spend(copyCaseId, ENGAGEMENT_AI_BUDGET_INCLUDED_USD * 0.5);

      const { body } = await aiBudget().expect(200);
      expect(body.used.amountMinor).to.equal(Math.round(ENGAGEMENT_AI_BUDGET_INCLUDED_USD * 0.5 * ENGAGEMENT_AI_BUDGET_GBP_PER_USD * 100));
      expect(body.state).to.equal("OK");
    });

    it("shows WARNING at 80% and EXHAUSTED at 100%", async () => {
      await spend(copyCaseId, ENGAGEMENT_AI_BUDGET_INCLUDED_USD * 0.8);
      expect((await aiBudget().expect(200)).body.state).to.equal("WARNING");

      await spend(copyCaseId, ENGAGEMENT_AI_BUDGET_INCLUDED_USD * 0.2);
      expect((await aiBudget().expect(200)).body.state).to.equal("EXHAUSTED");
    });

    it("refuses anyone but the engaged lawyer", async () => {
      await request(app).get(`/api/client-requests/${requestId}/ai-budget`).expect(401);
    });
  });

  // The route-level block (caseSpendLimit, mounted on /my-cases) is exercised directly here, the
  // same way CaseLimitsSvc's own block is tested in case-limits.spec.ts — a real document upload
  // would also exercise S3 and extraction, neither of which this is about.
  describe("the route-level block on further AI work", () => {
    let restore: () => void;
    afterEach(() => restore?.());

    const next = () => new Promise<unknown>((resolve) => {
      const req = { path: `/${copyCaseId}/documents`, method: "POST" } as any;
      caseSpendLimit(req, {} as any, resolve);
    });

    it("lets a write through while there's budget left", async () => {
      const stash = EngagementAiBudgetSvc.assertHasBudget;
      restore = () => (EngagementAiBudgetSvc.assertHasBudget = stash);
      EngagementAiBudgetSvc.assertHasBudget = async () => {};
      expect(await next()).to.equal(undefined);
    });

    it("passes the 403 ENGAGEMENT_AI_BUDGET_SPENT refusal on to next()", async () => {
      const stash = EngagementAiBudgetSvc.assertHasBudget;
      restore = () => (EngagementAiBudgetSvc.assertHasBudget = stash);
      const refusal = Object.assign(new Error("spent"), { statusCode: 403, code: "ENGAGEMENT_AI_BUDGET_SPENT" });
      EngagementAiBudgetSvc.assertHasBudget = async () => {
        throw refusal;
      };
      expect(await next()).to.equal(refusal);
    });
  });
});
