/** Paying for the client app (ClientBillingSvc): free cases with the tenant's starting credits,
 * top-ups with their promo codes, the dummy payment, and one credit per AI message. Stripe
 * Checkout is test/client-stripe-checkout.spec.ts. No live Postgres: the repository is
 * monkeypatched on its CommonJS module object, same idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientBillingSvc from "../src/services/client-billing.service";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import CaseSvc from "../src/services/case.service";
import ChatSvc from "../src/services/chat.service";
import CaseAreaRepo from "../src/repositories/case-area.repository";
import { dummyClientPaymentProvider, setClientPaymentProvider } from "../src/payments/client-payment-provider";
import { CASE_CREDITS as CLIENT_CASE_CREDITS, clientPriceRows, installClientPricing, welcomePromo, type ClientPricingState } from "./support/client-pricing-fixture";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

describe("Client app billing", () => {
  let restore: () => void;
  let payments: any[];
  let toppedUpBefore: boolean;
  let credits: Record<string, number>;

  beforeEach(() => {
    restore = stash(ClientPaymentRepo, ["create", "hasPaidTopUp", "addCredits", "creditsOf", "spendCredit"]);
    payments = [];
    toppedUpBefore = false;
    credits = { "case-1": 3 };
    // The real create adds a paid top-up's credits in the same transaction.
    (ClientPaymentRepo as any).create = async (data: any) => {
      const row = { id: `pay-${payments.length + 1}`, ...data };
      payments.push(row);
      if (data.status === "SUCCEEDED" && data.kind === "TOP_UP" && data.caseId) credits[data.caseId] = (credits[data.caseId] ?? 0) + data.credits;
      return row;
    };
    (ClientPaymentRepo as any).hasPaidTopUp = async () => toppedUpBefore;
    (ClientPaymentRepo as any).addCredits = async (caseId: string, n: number) => (credits[caseId] = (credits[caseId] ?? 0) + n);
    (ClientPaymentRepo as any).creditsOf = async (caseId: string) => credits[caseId] ?? 0;
    (ClientPaymentRepo as any).spendCredit = async (caseId: string) => {
      if (!credits[caseId]) return false;
      credits[caseId]--;
      return true;
    };
  });
  let pricing: ClientPricingState;
  let restorePricing: () => void;
  beforeEach(() => {
    pricing = { rows: clientPriceRows(), promos: [welcomePromo()], redemptions: {} };
    restorePricing = installClientPricing(pricing);
  });
  beforeEach(() => setClientPaymentProvider(dummyClientPaymentProvider));
  afterEach(() => {
    restore();
    restorePricing();
    setClientPaymentProvider(null);
  });

  describe("pricing", () => {
    it("tells the client what a new case starts with, and no price for it", async () => {
      const list = await ClientBillingSvc.pricing("u1");
      expect(list.case).to.deep.equal({ credits: CLIENT_CASE_CREDITS });
      expect(list.defaultPackId).to.equal("p100");
    });
  });

  describe("quoteTopUp", () => {
    it("charges the pack's full price with no code", async () => {
      const q = await ClientBillingSvc.quoteTopUp("u1", "p100");
      expect(q).to.deep.include({ packId: "p100", credits: 100, promo: null });
      expect(q.total).to.deep.equal({ amountMinor: 1499, currency: "USD" });
    });

    it("takes WELCOME5 off a first top-up, whatever the case of the code", async () => {
      const q = await ClientBillingSvc.quoteTopUp("u1", "p100", " welcome5 ");
      expect(q.promo).to.include({ code: "WELCOME5", applied: true });
      expect(q.discount.amountMinor).to.equal(500);
      expect(q.total.amountMinor).to.equal(999);
    });

    it("doesn't apply a first-top-up code once the client has bought one", async () => {
      toppedUpBefore = true;
      const q = await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5");
      expect(q.promo).to.include({ applied: false, message: "WELCOME5 only applies to your first top-up." });
      expect(q.total.amountMinor).to.equal(1499);
    });

    it("says so for a code that doesn't exist", async () => {
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "FREE")).promo).to.deep.equal({ code: "FREE", applied: false, message: "That code isn't valid." });
    });

    it("never takes off more than the pack costs: a code bigger than the price makes it free", async () => {
      pricing.promos = [welcomePromo({ discountMinor: 5000 })];
      const q = await ClientBillingSvc.quoteTopUp("u1", "p25", "WELCOME5");
      expect(q.discount.amountMinor).to.equal(499);
      expect(q.total.amountMinor).to.equal(0);
    });

    it("refuses a code that would leave less than Stripe's minimum to pay", async () => {
      pricing.promos = [welcomePromo({ discountMinor: 480 })];
      expect((await ClientBillingSvc.quoteTopUp("u1", "p25", "WELCOME5")).promo).to.include({ applied: false });
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5")).promo).to.include({ applied: true });
    });

    it("uses the price an admin set, in its currency", async () => {
      pricing.rows = pricing.rows.map((r) => (r.code === "p100" ? { ...r, priceMinor: 1999, credits: 80, currency: "GBP" } : r));
      const q = await ClientBillingSvc.quoteTopUp("u1", "p100");
      expect(q.total).to.deep.equal({ amountMinor: 1999, currency: "GBP" });
      expect(q.credits).to.equal(80);
    });

    it("refuses a code that's turned off, expired or in another currency", async () => {
      pricing.promos = [welcomePromo({ isActive: false })];
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5")).promo).to.include({ applied: false, message: "That code isn't valid." });
      pricing.promos = [welcomePromo({ expiresAt: new Date(Date.now() - 1000) })];
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5")).promo).to.include({ applied: false, message: "WELCOME5 has expired." });
      pricing.promos = [welcomePromo({ currency: "EUR" })];
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5")).promo).to.include({ applied: false });
    });

    it("refuses a code the client already used, or that has run out", async () => {
      pricing.promos = [welcomePromo({ firstTopUpOnly: false, oncePerClient: true })];
      pricing.redemptions["WELCOME5:u1"] = 1;
      expect((await ClientBillingSvc.quoteTopUp("u1", "p100", "WELCOME5")).promo).to.include({ applied: false, message: "You've already used WELCOME5." });
      expect((await ClientBillingSvc.quoteTopUp("u2", "p100", "WELCOME5")).promo).to.include({ applied: true });
      pricing.promos = [welcomePromo({ firstTopUpOnly: false, maxRedemptions: 1 })];
      pricing.redemptions.WELCOME5 = 1;
      expect((await ClientBillingSvc.quoteTopUp("u2", "p100", "WELCOME5")).promo).to.include({ applied: false, message: "WELCOME5 has been fully used." });
    });

    it("refuses an unknown pack", async () => {
      expect(await errorOf(ClientBillingSvc.quoteTopUp("u1", "huge"))).to.deep.include({ status: 400 });
    });
  });

  describe("topUp", () => {
    it("adds a pack's credits to the case", async () => {
      expect(await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" })).to.deep.equal({
        paymentId: "pay-1",
        status: "SUCCEEDED",
        credits: 28,
        added: 25,
        amount: { amountMinor: 499, currency: "USD" },
        checkout: null,
      });
      expect(payments[0]).to.include({ kind: "TOP_UP", caseId: "case-1", credits: 25, promoCode: null });
    });

    it("charges the discounted total and names the code on the payment", async () => {
      const paid = await ClientBillingSvc.topUp("u1", "case-1", { packId: "p100", promoCode: "welcome5" });
      expect(paid).to.deep.include({ status: "SUCCEEDED", added: 100, amount: { amountMinor: 999, currency: "USD" } });
      expect(payments[0]).to.include({ kind: "TOP_UP", provider: "DUMMY", amountMinor: 999, promoCode: "WELCOME5" });
    });

    it("refuses a code that doesn't apply rather than charging the full price", async () => {
      toppedUpBefore = true;
      expect(await errorOf(ClientBillingSvc.topUp("u1", "case-1", { packId: "p100", promoCode: "WELCOME5" }))).to.deep.equal({ status: 400, code: "PROMO_NOT_APPLIED" });
      expect(payments).to.deep.equal([]);
      expect(credits["case-1"]).to.equal(3);
    });

    it("adds nothing when the top-up is declined", async () => {
      expect(await errorOf(ClientBillingSvc.topUp("u1", "case-1", { packId: "p25", testOutcome: "decline" }))).to.deep.equal({ status: 402, code: "PAYMENT_DECLINED" });
      expect(payments[0]).to.include({ status: "FAILED", externalId: null });
      expect(credits["case-1"]).to.equal(3);
    });

    it("refuses a pack an admin turned off", async () => {
      pricing.rows = pricing.rows.map((r) => (r.code === "p25" ? { ...r, isActive: false } : r));
      expect(await errorOf(ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" }))).to.deep.include({ status: 400 });
    });

    it("answers 402 OUT_OF_CREDITS once a case has none left", async () => {
      credits["case-1"] = 1;
      await ClientBillingSvc.spendCredit("case-1");
      expect(await errorOf(ClientBillingSvc.spendCredit("case-1"))).to.deep.equal({ status: 402, code: "OUT_OF_CREDITS" });
    });
  });

  describe("creating and chatting in a free case", () => {
    const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };
    const input = { title: "Deposit not returned", areas: ["PROPERTY"], ukJurisdiction: "Scotland" };
    let restoreMore: () => void;
    let calls: string[];

    beforeEach(() => {
      const fns = [stash(CaseSvc, ["create"]), stash(ChatSvc, ["createConsultation", "enqueueChatGeneration"]), stash(ClientCaseRepo, ["findById"]), stash(CaseAreaRepo, ["list"])];
      restoreMore = () => fns.forEach((f) => f());
      (CaseAreaRepo as any).list = async () => [{ id: "a", country: "UK", code: "PROPERTY", name: "Property", description: "", isActive: true, sortOrder: 0 }];
      calls = [];
      (CaseSvc as any).create = async (_scope: unknown, _userId: string, _role: string, data: any) => {
        calls.push("create");
        credits["case-1"] = data.clientCredits;
        return { id: "case-1" };
      };
      (ChatSvc as any).createConsultation = async () => ({ id: "cons-1" });
      (ChatSvc as any).enqueueChatGeneration = async () => {
        calls.push("enqueue");
        return { messageId: "m1" };
      };
      (ClientCaseRepo as any).findById = async () => ({
        id: "case-1",
        caseName: "Deposit not returned",
        caseAreas: ["PROPERTY"],
        ukJurisdiction: "Scotland",
        jurisdiction: null,
        clientSide: null,
        clientCredits: credits["case-1"],
        parties: [],
        documents: [],
        consultations: [{ id: "cons-1" }],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    afterEach(() => restoreMore());

    it("creates the case without a payment, starting with the tenant's credits", async () => {
      const dto = await ClientCaseSvc.create(workspace, "u1", input);
      expect(calls).to.deep.equal(["create"]);
      expect(payments).to.deep.equal([]);
      expect(credits["case-1"]).to.equal(CLIENT_CASE_CREDITS);
      expect(dto.credits).to.equal(CLIENT_CASE_CREDITS);
    });

    it("gives a new case the credits an admin set", async () => {
      pricing.rows = pricing.rows.map((r) => (r.planType === "B2C_CASE" ? { ...r, credits: 10 } : r));
      await ClientCaseSvc.create(workspace, "u1", input);
      expect(credits["case-1"]).to.equal(10);
    });

    it("takes a credit for each message, and gives it back if the AI couldn't be asked", async () => {
      await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Can they keep it?");
      expect(credits["case-1"]).to.equal(2);
      (ChatSvc as any).enqueueChatGeneration = async () => {
        throw Object.assign(new Error("A reply is already generating"), { statusCode: 409 });
      };
      expect(await errorOf(ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "And now?"))).to.deep.include({ status: 409 });
      expect(credits["case-1"]).to.equal(2);
    });

    it("doesn't ask the AI at 0 credits", async () => {
      credits["case-1"] = 0;
      expect(await errorOf(ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Hello?"))).to.deep.equal({ status: 402, code: "OUT_OF_CREDITS" });
      expect(calls).to.not.include("enqueue");
    });
  });
});
