/** Client requests on the KR site: a KR client's request goes to KR's verified lawyers only (and a
 * UK one's to UK lawyers only), with no part of the UK to match, and it's quoted, paid and earned in
 * won. Matching and the currency rules are unit-tested; eligibility stubs the repositories; the
 * payout terms read the real KR tenant. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestMatchingSvc, { type LawyerForMatching } from "../src/services/client-request-matching.service";
import ClientRequestSvc from "../src/services/client-request.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import PayoutSettingsSvc from "../src/services/payout-settings.service";
import { CLIENT_REQUESTS_OPEN_TENANTS, needsUkRegion, requestCurrencyOf } from "../src/constants/client-sites.constants";
import { quoteMaxMinorOf } from "../src/constants/client-request.constants";
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma";
import WalletRepo from "../src/repositories/wallet.repository";
import { moneyText } from "../src/utils/money-text";
import WalletSvc from "../src/services/wallet.service";
import { payoutsAvailableFor, payoutSettingsCacheKey, platformFeeOf } from "../src/constants/payout.constants";
import { redis } from "../src/lib/redis";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const lawyer = (over: Partial<LawyerForMatching> = {}): LawyerForMatching => ({
  userId: "l1",
  country: "KR",
  acceptingRequests: true,
  enabledByOrganization: true,
  pausedUntil: null,
  capacityLimit: null,
  openCount: 0,
  practiceAreas: [{ caseArea: "TAX", isActive: true }],
  qualifiedJurisdictions: [],
  ...over,
});

describe("Client requests on the KR site", () => {
  describe("which sites have them", () => {
    it("opens UK and KR, not PH yet", () => {
      expect([...CLIENT_REQUESTS_OPEN_TENANTS].sort()).to.deep.equal(["KR", "UK"]);
    });

    it("asks for a part of the UK only on the UK", () => {
      expect(needsUkRegion("UK")).to.equal(true);
      expect(needsUkRegion("KR")).to.equal(false);
    });
  });

  describe("matching", () => {
    it("matches a KR lawyer to a KR client's case by its area alone", () => {
      expect(ClientRequestMatchingSvc.matches(lawyer(), { country: "KR", caseAreas: ["TAX"], ukJurisdiction: null })).to.equal(true);
    });

    it("keeps each site's requests to its own lawyers", () => {
      expect(ClientRequestMatchingSvc.matches(lawyer(), { country: "UK", caseAreas: ["TAX"], ukJurisdiction: "England and Wales" })).to.equal(false);
      const ukLawyer = lawyer({ country: "UK", qualifiedJurisdictions: ["England and Wales"] });
      expect(ClientRequestMatchingSvc.matches(ukLawyer, { country: "KR", caseAreas: ["TAX"], ukJurisdiction: null })).to.equal(false);
      expect(ClientRequestMatchingSvc.matches(ukLawyer, { country: "UK", caseAreas: ["TAX"], ukJurisdiction: "England and Wales" })).to.equal(true);
    });

    it("still needs a UK case's part of the UK, and reads a request with no site as the UK", () => {
      const ukLawyer = lawyer({ country: "UK", qualifiedJurisdictions: ["England and Wales"] });
      expect(ClientRequestMatchingSvc.matches(ukLawyer, { country: "UK", caseAreas: ["TAX"], ukJurisdiction: null })).to.equal(false);
      expect(ClientRequestMatchingSvc.matches(ukLawyer, { caseAreas: ["TAX"], ukJurisdiction: "England and Wales" })).to.equal(true);
    });

    it("keeps the other rules on KR: the area, being available, a request asked of one lawyer", () => {
      expect(ClientRequestMatchingSvc.matches(lawyer(), { country: "KR", caseAreas: ["MEDICAL"], ukJurisdiction: null })).to.equal(false);
      expect(ClientRequestMatchingSvc.matches(lawyer({ acceptingRequests: false }), { country: "KR", caseAreas: ["TAX"], ukJurisdiction: null })).to.equal(false);
      expect(ClientRequestMatchingSvc.matches(lawyer(), { country: "KR", caseAreas: ["TAX"], ukJurisdiction: null, onlyLawyerId: "other" })).to.equal(false);
    });
  });

  describe("what a KR client agrees to", () => {
    it("is Korean, about Korean lawyers, with its own versions", () => {
      for (const direct of [false, true]) {
        const kr = ClientRequestSvc.consent(direct, "KR");
        const uk = ClientRequestSvc.consent(direct, "UK");
        expect(kr.version).to.not.equal(uk.version);
        expect(kr.consentText).to.match(/[가-힣]/).and.not.include("UK");
        expect(kr.referralDisclosure).to.match(/[가-힣]/);
        if (!direct) expect(uk.consentText).to.include("UK");
      }
      expect(ClientRequestSvc.consent(false, "KR").consentText).to.include("검증된 한국 변호사");
    });

    it("refuses a KR client's request agreed on the UK's wording", async () => {
      const uk = ClientRequestSvc.consent(false, "UK");
      try {
        await ClientRequestSvc.create({ id: "org-kr", role: "OWNER", tenantCode: "KR" }, "client-1", {
          caseId: "case-1",
          consentAccepted: true,
          consentVersion: uk.version,
        } as any);
        expect.fail("should have refused");
      } catch (e: any) {
        expect(e.code).to.equal("CONSENT_VERSION_STALE");
        expect(e.details.version).to.equal(ClientRequestSvc.consent(false, "KR").version);
      }
    });
  });

  describe("money", () => {
    it("quotes, pays and earns in won on KR and pounds on the UK", () => {
      expect(requestCurrencyOf("KR")).to.equal("KRW");
      expect(requestCurrencyOf("UK")).to.equal("GBP");
    });

    it("catches an extra zero in each currency", () => {
      expect(quoteMaxMinorOf("GBP")).to.equal(10_000_000);
      expect(quoteMaxMinorOf("KRW")).to.equal(200_000_000);
    });

    it("starts KR's payout terms in won", async () => {
      const terms = await PayoutSettingsSvc.forTenantCode("KR");
      expect(terms.currency).to.equal("KRW");
      expect((await PayoutSettingsSvc.quoteTerms("KR")).minPlatformFee.currency).to.equal("KRW");
      expect((await PayoutSettingsSvc.forTenantCode("UK")).currency).to.equal("GBP");
    });
  });

  // KR clients pay the lawyer directly (#695), so there's nothing to take a fee from (#694).
  describe("no platform fee", () => {
    let krTenantId: string;
    let saved: Awaited<ReturnType<typeof prisma.payoutSettings.findUnique>>;
    const forget = () => redis.del(payoutSettingsCacheKey(krTenantId));

    beforeEach(async () => {
      krTenantId = (await prisma.tenant.upsert({ where: { code: "KR" }, update: {}, create: { code: "KR", name: "South Korea" } })).id;
      saved = await prisma.payoutSettings.findUnique({ where: { tenantId: krTenantId } });
      await forget();
    });
    afterEach(async () => {
      // Put back whatever the KR row was before the test.
      await prisma.payoutSettings.deleteMany({ where: { tenantId: krTenantId } });
      if (saved) await prisma.payoutSettings.create({ data: saved });
      await forget();
    });

    it("has none on KR, so a KR quote is priced with no fee, and keeps the UK's", async () => {
      const kr = await PayoutSettingsSvc.forTenantCode("KR");
      expect(kr).to.deep.include({ platformFeeBps: 0, minPlatformFeeMinor: 0 });
      expect(platformFeeOf(300_000, kr.platformFeeBps, kr.minPlatformFeeMinor)).to.equal(0);
      expect(await PayoutSettingsSvc.quoteTerms("KR")).to.deep.equal({ platformFeeBps: 0, minPlatformFee: { amountMinor: 0, currency: "KRW" } });
      expect((await PayoutSettingsSvc.forTenantCode("UK")).platformFeeBps).to.be.greaterThan(0);
    });

    it("ignores a fee left on a KR settings row from before", async () => {
      await prisma.payoutSettings.deleteMany({ where: { tenantId: krTenantId } });
      await prisma.payoutSettings.create({ data: { tenantId: krTenantId, platformFeeBps: 1500, minPlatformFeeMinor: 10_000, earningsHoldDays: 7, minWithdrawalMinor: 20_000, currency: "KRW" } });
      expect(await PayoutSettingsSvc.forTenantCode("KR")).to.deep.include({ platformFeeBps: 0, minPlatformFeeMinor: 0, minWithdrawalMinor: 20_000 });
    });

    it("refuses an admin setting a KR fee, and still takes KR's other terms", async () => {
      for (const patch of [{ platformFeeBps: 1500 }, { minPlatformFeeMinor: 10_000 }]) {
        try {
          await PayoutSettingsSvc.update("KR", patch, randomUUID());
          expect.fail("should have refused");
        } catch (e: any) {
          expect(e.statusCode).to.equal(400);
          expect(e.code).to.equal("PLATFORM_FEE_NOT_ALLOWED");
        }
      }
      const updated = await PayoutSettingsSvc.update("KR", { earningsHoldDays: 3, platformFeeBps: 0 }, randomUUID());
      expect(updated.settings).to.deep.include({ earningsHoldDays: 3, platformFeeBps: 0, minPlatformFeeMinor: 0 });
    });
  });

  describe("a KR lawyer's wallet", () => {
    const made: string[] = [];
    const wallet = async (currency: string) => {
      const w = await prisma.wallet.create({ data: { ownerType: "USER", ownerId: randomUUID(), currency } });
      made.push(w.id);
      return w;
    };
    afterEach(async () => {
      await prisma.walletLedgerEntry.deleteMany({ where: { walletId: { in: made } } });
      await prisma.wallet.deleteMany({ where: { id: { in: made } } });
      made.length = 0;
    });

    it("moves a wallet made in pounds that holds nothing over to won", async () => {
      const w = await wallet("GBP");
      expect((await WalletRepo.realignCurrency(w, "KRW")).currency).to.equal("KRW");
      expect((await prisma.wallet.findUniqueOrThrow({ where: { id: w.id } })).currency).to.equal("KRW");
    });

    it("moves one whose only entries are already in won, and keeps one holding pounds", async () => {
      const won = await wallet("GBP");
      await prisma.walletLedgerEntry.create({ data: { walletId: won.id, bucket: "PENDING", kind: "EARNING", amountMinor: 0, currency: "KRW", idempotencyKey: randomUUID() } });
      expect((await WalletRepo.realignCurrency(won, "KRW")).currency).to.equal("KRW");

      const pounds = await wallet("GBP");
      await prisma.walletLedgerEntry.create({ data: { walletId: pounds.id, bucket: "PENDING", kind: "EARNING", amountMinor: 500, currency: "GBP", idempotencyKey: randomUUID() } });
      expect((await WalletRepo.realignCurrency(pounds, "KRW")).currency).to.equal("GBP");
    });

    it("can't set up payouts or withdraw in won yet, and says so", async () => {
      expect(payoutsAvailableFor("GBP")).to.equal(true);
      expect(payoutsAvailableFor("KRW")).to.equal(false);
      const restore = stash(WalletSvc, ["walletOf"]);
      (WalletSvc as any).walletOf = async () => ({ id: "w-kr", ownerType: "USER", ownerId: "l1", currency: "KRW", provider: null, stripeAccountId: null, payoutsEnabled: false, detailsSubmitted: false });
      try {
        for (const attempt of [() => WalletSvc.startOnboarding({ ownerType: "USER", ownerId: "l1" }, "l1", "http://localhost/back"), () => WalletSvc.withdraw({ ownerType: "USER", ownerId: "l1" }, "l1", 50_000, "key-1")]) {
          try {
            await attempt();
            expect.fail("should have refused");
          } catch (e: any) {
            expect(e.statusCode).to.equal(409);
            expect(e.code).to.equal("PAYOUTS_NOT_AVAILABLE");
            expect(e.message).to.include("Korea");
          }
        }
      } finally {
        restore();
      }
    });

    it("writes amounts in their own currency", () => {
      expect(moneyText(150_000, "KRW")).to.equal("₩150,000");
      expect(moneyText(8000, "GBP")).to.equal("£80.00");
    });
  });

  describe("asking for a lawyer", () => {
    let restore: () => void;
    let row: Record<string, unknown>;

    beforeEach(() => {
      const a = stash(ClientCaseRepo, ["findById"]);
      const b = stash(ClientRequestRepo, ["findOpenForCase"]);
      restore = () => {
        a();
        b();
      };
      row = { id: "case-1", caseAreas: ["TAX"], ukJurisdiction: null, outsideUk: false, lawyerReadiness: { blockedBy: "PERSONAL_INJURY" } };
      (ClientCaseRepo as any).findById = async () => row;
      (ClientRequestRepo as any).findOpenForCase = async () => null;
    });
    afterEach(() => restore());

    it("lets a KR client ask with no part of the UK, and doesn't apply the UK's personal injury rule", async () => {
      const check = await ClientRequestSvc.eligibility({ id: "org-kr", role: "OWNER", tenantCode: "KR" }, "case-1");
      expect(check).to.deep.equal({ eligible: true, reason: null, openRequestId: null });
    });

    it("still asks a UK client which part of the UK", async () => {
      row = { ...row, lawyerReadiness: null };
      const check = await ClientRequestSvc.eligibility({ id: "org-uk", role: "OWNER", tenantCode: "UK" }, "case-1");
      expect(check.reason).to.equal("REGION_UNKNOWN");
    });
  });
});
