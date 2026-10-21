/** Paying for the client app (ClientBillingSvc): the price and promos, the dummy payment, a case
 * payment used once, top-ups, and one credit per AI message. No live Postgres: the repository is
 * monkeypatched on its CommonJS module object, same idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientBillingSvc from "../src/services/client-billing.service";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import CaseSvc from "../src/services/case.service";
import ChatSvc from "../src/services/chat.service";
import { dummyClientPaymentProvider, setClientPaymentProvider } from "../src/payments/client-payment-provider";
import { CLIENT_CASE_CREDITS, CLIENT_CASE_PRICE_MINOR } from "../src/constants/client-pricing.constants";

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
  let paidBefore: boolean;
  let credits: Record<string, number>;

  beforeEach(() => {
    restore = stash(ClientPaymentRepo, ["create", "hasPaidForCase", "addCredits", "spendCredit", "claimCasePayment", "releaseCasePayment", "attachToCase"]);
    payments = [];
    paidBefore = false;
    credits = { "case-1": 3 };
    (ClientPaymentRepo as any).create = async (data: any) => {
      const row = { id: `pay-${payments.length + 1}`, ...data };
      payments.push(row);
      return row;
    };
    (ClientPaymentRepo as any).hasPaidForCase = async () => paidBefore;
    (ClientPaymentRepo as any).addCredits = async (caseId: string, n: number) => (credits[caseId] = (credits[caseId] ?? 0) + n);
    (ClientPaymentRepo as any).spendCredit = async (caseId: string) => {
      if (!credits[caseId]) return false;
      credits[caseId]--;
      return true;
    };
  });
  afterEach(() => {
    restore();
    setClientPaymentProvider(dummyClientPaymentProvider);
  });

  describe("quoteCase", () => {
    it("charges the full price with no code", async () => {
      const q = await ClientBillingSvc.quoteCase("u1");
      expect(q.total.amountMinor).to.equal(CLIENT_CASE_PRICE_MINOR);
      expect(q.promo).to.equal(null);
    });

    it("takes WELCOME5 off a first case, whatever the case of the code", async () => {
      const q = await ClientBillingSvc.quoteCase("u1", " welcome5 ");
      expect(q.promo).to.include({ code: "WELCOME5", applied: true });
      expect(q.total.amountMinor).to.equal(CLIENT_CASE_PRICE_MINOR - 500);
    });

    it("doesn't apply a first-case code once the client has paid for a case", async () => {
      paidBefore = true;
      const q = await ClientBillingSvc.quoteCase("u1", "WELCOME5");
      expect(q.promo).to.include({ applied: false });
      expect(q.total.amountMinor).to.equal(CLIENT_CASE_PRICE_MINOR);
    });

    it("says so for a code that doesn't exist", async () => {
      expect((await ClientBillingSvc.quoteCase("u1", "FREE")).promo).to.deep.equal({ code: "FREE", applied: false, message: "That code isn't valid." });
    });
  });

  describe("payForCase", () => {
    it("records a dummy payment with the case's credits, ready to create one case", async () => {
      const paid = await ClientBillingSvc.payForCase("u1", { promoCode: "WELCOME5" });
      expect(paid).to.deep.equal({ paymentId: "pay-1", amount: { amountMinor: CLIENT_CASE_PRICE_MINOR - 500, currency: "USD" }, credits: CLIENT_CASE_CREDITS });
      expect(payments[0]).to.include({ kind: "CASE", provider: "DUMMY", status: "SUCCEEDED", caseId: null, promoCode: "WELCOME5" });
    });

    it("records a decline and answers 402, so nothing can be created with it", async () => {
      expect(await errorOf(ClientBillingSvc.payForCase("u1", { testOutcome: "decline" }))).to.deep.equal({ status: 402, code: "PAYMENT_DECLINED" });
      expect(payments[0]).to.include({ status: "FAILED", externalId: null });
    });

    it("refuses a code that doesn't apply rather than charging the full price", async () => {
      paidBefore = true;
      expect(await errorOf(ClientBillingSvc.payForCase("u1", { promoCode: "WELCOME5" }))).to.deep.equal({ status: 400, code: "PROMO_NOT_APPLIED" });
      expect(payments).to.deep.equal([]);
    });

    it("stores the provider's name, so a dummy payment is never taken for a real one", async () => {
      setClientPaymentProvider({ name: "STRIPE", charge: async () => ({ ok: true, externalId: "pi_1" }) });
      await ClientBillingSvc.payForCase("u1", {});
      expect(payments[0]).to.include({ provider: "STRIPE", externalId: "pi_1" });
    });
  });

  describe("credits", () => {
    it("adds a pack's credits to the case", async () => {
      expect(await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" })).to.deep.equal({ credits: 28, added: 25, amount: { amountMinor: 499, currency: "USD" } });
      expect(payments[0]).to.include({ kind: "TOP_UP", caseId: "case-1", credits: 25 });
    });

    it("adds nothing when the top-up is declined", async () => {
      expect(await errorOf(ClientBillingSvc.topUp("u1", "case-1", { packId: "p25", testOutcome: "decline" }))).to.deep.include({ status: 402 });
      expect(credits["case-1"]).to.equal(3);
    });

    it("refuses an unknown pack", async () => {
      expect(await errorOf(ClientBillingSvc.topUp("u1", "case-1", { packId: "huge" }))).to.deep.include({ status: 400 });
    });

    it("answers 402 OUT_OF_CREDITS once a case has none left", async () => {
      credits["case-1"] = 1;
      await ClientBillingSvc.spendCredit("case-1");
      expect(await errorOf(ClientBillingSvc.spendCredit("case-1"))).to.deep.equal({ status: 402, code: "OUT_OF_CREDITS" });
    });
  });

  describe("creating and chatting in a paid case", () => {
    const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };
    const input = { title: "Deposit not returned", area: "PROPERTY" as const, ukJurisdiction: "Scotland" };
    let restoreMore: () => void;
    let claimable: boolean;
    let calls: string[];

    beforeEach(() => {
      const fns = [stash(CaseSvc, ["create"]), stash(ChatSvc, ["createConsultation", "enqueueChatGeneration"]), stash(ClientCaseRepo, ["findById"])];
      restoreMore = () => fns.forEach((f) => f());
      claimable = true;
      calls = [];
      (ClientPaymentRepo as any).claimCasePayment = async () => {
        calls.push("claim");
        if (!claimable) return null;
        claimable = false;
        return 50;
      };
      (ClientPaymentRepo as any).releaseCasePayment = async () => {
        calls.push("release");
        claimable = true;
      };
      (ClientPaymentRepo as any).attachToCase = async (_p: string, caseId: string, n: number) => {
        calls.push(`attach ${caseId} ${n}`);
      };
      (CaseSvc as any).create = async () => {
        calls.push("create");
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
        practiceArea: "PROPERTY",
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

    it("uses the payment once: the case gets its credits, and a second try is refused", async () => {
      await ClientCaseSvc.create(workspace, "u1", { ...input, paymentId: "pay-1" });
      expect(calls).to.deep.equal(["claim", "create", "attach case-1 50"]);
      expect(await errorOf(ClientCaseSvc.create(workspace, "u1", { ...input, paymentId: "pay-1" }))).to.deep.equal({ status: 402, code: "PAYMENT_REQUIRED" });
    });

    it("gives the payment back when the case can't be created, so the client can retry", async () => {
      (CaseSvc as any).create = async () => {
        throw new Error("db down");
      };
      expect(await errorOf(ClientCaseSvc.create(workspace, "u1", { ...input, paymentId: "pay-1" }))).to.not.equal(undefined);
      expect(calls).to.deep.equal(["claim", "release"]);
      expect(claimable).to.equal(true);
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
