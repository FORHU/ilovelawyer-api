/** A law firm's card on file (ilovelawyer-api#505): GET /organizations/:id/billing/card and POST
 * .../billing/card/setup-session, plus the shared Stripe webhook saving the card. Runs the real routes
 * against the real database with its own users and organizations, removed afterwards. Stripe is
 * replaced with a fake provider; the security audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import ClientBillingSvc from "../src/services/client-billing.service";
import { allowedReturnUrl, withQuery } from "../src/services/organization-card.service";
import {
  dummyOrganizationCardProvider,
  setOrganizationCardProvider,
  type CardSetupRequest,
  type CompletedCardSetup,
  type HostedOrganizationCardProvider,
} from "../src/payments/organization-card-provider";
import { CLIENT_URL } from "../src/config";

const APP_ORIGIN = "http://localhost:3002";

describe("organization card on file", () => {
  const ownerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const otherOwnerId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const webhookEvents: string[] = [];
  const savedClientUrl = [...CLIENT_URL];

  const asUser = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const getCard = (as: string, query = "", org = orgId) => request(app).get(`/api/organizations/${org}/billing/card${query}`).set(asUser(as));
  const startSetup = (as: string, body: object = { returnUrl: `${APP_ORIGIN}/settings/billing` }, org = orgId) =>
    request(app).post(`/api/organizations/${org}/billing/card/setup-session`).set(asUser(as)).send(body);

  let setupRequests: CardSetupRequest[];
  let completed: Map<string, CompletedCardSetup>;
  let defaults: { customerId: string; paymentMethodId: string; replaced: string | null }[];
  let startFails: boolean;
  let auditRows: any[];
  let savedAuditCreate: unknown;
  let customerCount: number;

  const fakeStripe: HostedOrganizationCardProvider = {
    name: "STRIPE",
    mode: "hosted",
    async startSetup(req) {
      setupRequests.push(req);
      if (startFails) throw new Error("Stripe is down");
      const customerId = req.customerId ?? `cus_test_${++customerCount}`;
      return { url: `https://checkout.stripe.com/c/pay/cs_test_${setupRequests.length}`, customerId, sessionId: `cs_test_${setupRequests.length}` };
    },
    async completedSetup(sessionId) {
      return completed.get(sessionId) ?? null;
    },
    async makeDefault(customerId, paymentMethodId, replaced) {
      defaults.push({ customerId, paymentMethodId, replaced });
    },
    // Charging the card is OrganizationChargeSvc's (#513), tested in client-request-confirm-route.spec.ts.
    async charge() {
      throw new Error("not used here");
    },
    async chargeStatus() {
      throw new Error("not used here");
    },
    async refund() {
      throw new Error("not used here");
    },
  };

  const completeSession = (sessionId: string, over: Partial<CompletedCardSetup["card"]> & { organizationId?: string; customerId?: string } = {}) => {
    completed.set(sessionId, {
      sessionId,
      organizationId: over.organizationId ?? orgId,
      userId: adminId,
      card: {
        customerId: over.customerId ?? "cus_test_1",
        paymentMethodId: over.paymentMethodId ?? `pm_${sessionId}`,
        brand: over.brand ?? "mastercard",
        last4: over.last4 ?? "4444",
        expMonth: 8,
        expYear: 2030,
      },
    });
  };

  const webhook = async (sessionId: string, type = "checkout.session.completed") => {
    const id = `evt_${crypto.randomUUID()}`;
    webhookEvents.push(id);
    return ClientBillingSvc.handleStripeEvent({ id, type, data: { object: { id: sessionId, mode: "setup", metadata: {} } } } as unknown as Stripe.Event);
  };

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [ownerId, adminId, memberId, otherOwnerId].map((id) => ({ id, email: `card-${id}@example.com`, username: `card-${id}` })),
    });
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Card Spec LLP",
        slug: `card-spec-${orgId}`,
        tenantId: tenant.id,
        createdById: ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER", status: "ACCEPTED" },
            { userId: adminId, role: "ADMIN", status: "ACCEPTED" },
            { userId: memberId, role: "MEMBER", status: "ACCEPTED" },
          ],
        },
      },
    });
    await prisma.organization.create({
      data: {
        id: otherOrgId,
        name: "Other Firm",
        slug: `card-spec-other-${otherOrgId}`,
        tenantId: tenant.id,
        createdById: otherOwnerId,
        members: { create: { userId: otherOwnerId, role: "OWNER", status: "ACCEPTED" } },
      },
    });
    if (!CLIENT_URL.includes(APP_ORIGIN)) CLIENT_URL.push(APP_ORIGIN);
  });

  after(async () => {
    await prisma.organizationBilling.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, memberId, otherOwnerId] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
    CLIENT_URL.splice(0, CLIENT_URL.length, ...savedClientUrl);
  });

  beforeEach(async () => {
    setupRequests = [];
    completed = new Map();
    defaults = [];
    startFails = false;
    customerCount = 0;
    setOrganizationCardProvider(fakeStripe);
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
    await prisma.organizationBilling.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
  });

  afterEach(() => {
    setOrganizationCardProvider(null);
    (SecurityAuditRepo as any).create = savedAuditCreate;
  });

  describe("access", () => {
    it("is for the organization's OWNER and ADMIN only", async () => {
      await request(app).get(`/api/organizations/${orgId}/billing/card`).expect(401);
      await getCard(memberId).expect(403);
      await startSetup(memberId).expect(403);
      await getCard(otherOwnerId).expect(403);
      await startSetup(otherOwnerId).expect(403);
      await getCard(ownerId).expect(200);
      await getCard(adminId).expect(200);
      expect(setupRequests).to.have.length(0);
    });
  });

  describe("with Stripe", () => {
    it("has no card at first", async () => {
      const { body } = await getCard(ownerId).expect(200);
      expect(body).to.equal(null);
    });

    it("starts Stripe's hosted setup, makes the customer once, and comes back with the session id", async () => {
      const { body } = await startSetup(adminId).expect(200);
      expect(body.url).to.match(/^https:\/\/checkout\.stripe\.com\//);
      expect(setupRequests[0]).to.deep.include({ organizationId: orgId, organizationName: "Card Spec LLP", customerId: null, userId: adminId });
      expect(setupRequests[0].email).to.equal(`card-${adminId}@example.com`);
      expect(setupRequests[0].successUrl).to.equal(`${APP_ORIGIN}/settings/billing?cardSetup=done&setupSessionId={CHECKOUT_SESSION_ID}`);
      expect(setupRequests[0].cancelUrl).to.equal(`${APP_ORIGIN}/settings/billing?cardSetup=cancelled`);
      const row = await prisma.organizationBilling.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(row).to.deep.include({ customerId: "cus_test_1", paymentMethodId: null });

      await startSetup(ownerId).expect(200);
      expect(setupRequests[1].customerId).to.equal("cus_test_1");
      expect((await getCard(ownerId).expect(200)).body).to.equal(null);
      // Starting a setup changes no card, so nothing is audited yet.
      expect(auditRows).to.have.length(0);
    });

    it("saves the card from the webhook, once, makes it the default and audits it", async () => {
      await startSetup(adminId).expect(200);
      completeSession("cs_test_1");
      await webhook("cs_test_1");
      await webhook("cs_test_1");
      const { body } = await getCard(ownerId).expect(200);
      expect(body).to.deep.include({ brand: "mastercard", last4: "4444", expMonth: 8, expYear: 2030, provider: "STRIPE" });
      expect(defaults).to.deep.equal([{ customerId: "cus_test_1", paymentMethodId: "pm_cs_test_1", replaced: null }]);
      expect(auditRows).to.have.length(1);
      expect(auditRows[0]).to.deep.include({ action: "org.payment_card_updated", actorId: adminId, organizationId: orgId, targetType: "organization", targetId: orgId });
      expect(auditRows[0].payload).to.deep.equal({ provider: "STRIPE", brand: "mastercard", last4: "4444", replaced: false });
    });

    it("saves it when the app comes back, before any webhook, and the late webhook changes nothing", async () => {
      await startSetup(adminId).expect(200);
      completeSession("cs_test_1");
      const { body } = await getCard(adminId, "?setupSessionId=cs_test_1").expect(200);
      expect(body).to.deep.include({ last4: "4444" });
      await webhook("cs_test_1");
      expect(auditRows).to.have.length(1);
      expect(defaults).to.have.length(1);
    });

    it("applies a session the app and the webhook deliver at the same moment only once", async () => {
      await startSetup(adminId).expect(200);
      completeSession("cs_test_1");
      await Promise.all([getCard(adminId, "?setupSessionId=cs_test_1"), webhook("cs_test_1"), getCard(ownerId, "?setupSessionId=cs_test_1")]);
      expect(auditRows).to.have.length(1);
    });

    it("replaces the card, and removes the old one at Stripe", async () => {
      await startSetup(adminId).expect(200);
      completeSession("cs_test_1");
      await webhook("cs_test_1");
      await startSetup(ownerId).expect(200);
      completeSession("cs_test_2", { paymentMethodId: "pm_new", brand: "visa", last4: "1881" });
      await webhook("cs_test_2");
      expect((await getCard(ownerId).expect(200)).body).to.deep.include({ brand: "visa", last4: "1881" });
      expect(defaults[1]).to.deep.equal({ customerId: "cus_test_1", paymentMethodId: "pm_new", replaced: "pm_cs_test_1" });
      expect(auditRows[1].payload).to.deep.include({ replaced: true });
    });

    it("ignores a session the app names for another organization", async () => {
      await startSetup(adminId).expect(200);
      await startSetup(otherOwnerId, undefined, otherOrgId).expect(200);
      completeSession("cs_test_2", { organizationId: otherOrgId, customerId: "cus_test_2" });
      const { body } = await getCard(adminId, "?setupSessionId=cs_test_2").expect(200);
      expect(body).to.equal(null);
      expect(auditRows).to.have.length(0);
    });

    it("ignores a session for a customer this organization doesn't have (another environment)", async () => {
      await startSetup(adminId).expect(200);
      completeSession("cs_test_1", { customerId: "cus_someone_else" });
      await webhook("cs_test_1");
      expect((await getCard(ownerId).expect(200)).body).to.equal(null);
    });

    it("leaves the card alone for a setup that hasn't completed or was abandoned", async () => {
      await startSetup(adminId).expect(200);
      await getCard(adminId, "?setupSessionId=cs_test_1").expect(200);
      await webhook("cs_test_1", "checkout.session.expired");
      expect((await getCard(ownerId).expect(200)).body).to.equal(null);
      expect(auditRows).to.have.length(0);
    });

    it("refuses a returnUrl off the app's own origins", async () => {
      for (const returnUrl of ["https://evil.example.com/billing", "javascript:alert(1)", "not a url"]) {
        const res = await startSetup(adminId, { returnUrl }).expect(400);
        expect(JSON.stringify(res.body)).to.contain("RETURN_URL_NOT_ALLOWED");
      }
      await startSetup(adminId, {}).expect(400);
      expect(setupRequests).to.have.length(0);
    });

    it("answers 502 when Stripe can't start the setup", async () => {
      startFails = true;
      const res = await startSetup(adminId).expect(502);
      expect(JSON.stringify(res.body)).to.contain("PAYMENT_PROVIDER_ERROR");
    });
  });

  describe("with the dummy provider", () => {
    beforeEach(() => setOrganizationCardProvider(dummyOrganizationCardProvider));

    it("saves a test card at once and sends the app straight back", async () => {
      const { body } = await startSetup(ownerId).expect(200);
      expect(body.url).to.equal(`${APP_ORIGIN}/settings/billing?cardSetup=done`);
      const card = (await getCard(ownerId).expect(200)).body;
      expect(card).to.deep.include({ brand: "visa", last4: "4242", provider: "DUMMY" });
      expect(auditRows[0]).to.deep.include({ action: "org.payment_card_updated", actorId: ownerId });
    });
  });
});

describe("organization card URLs", () => {
  it("adds the query ahead of a fragment, keeping Stripe's placeholder as is", () => {
    expect(withQuery("https://a.test/x", "a=1&s={CHECKOUT_SESSION_ID}")).to.equal("https://a.test/x?a=1&s={CHECKOUT_SESSION_ID}");
    expect(withQuery("https://a.test/x?tab=2#card", "a=1")).to.equal("https://a.test/x?tab=2&a=1#card");
  });

  it("accepts only the app's own origins", () => {
    const saved = [...CLIENT_URL];
    CLIENT_URL.splice(0, CLIENT_URL.length, "https://app.ilovelawyer.com/");
    try {
      expect(allowedReturnUrl("https://app.ilovelawyer.com/settings")).to.equal("https://app.ilovelawyer.com/settings");
      expect(() => allowedReturnUrl("https://app.ilovelawyer.com.evil.test/settings")).to.throw();
      expect(() => allowedReturnUrl("http://app.ilovelawyer.com/settings")).to.throw();
    } finally {
      CLIENT_URL.splice(0, CLIENT_URL.length, ...saved);
    }
  });
});
