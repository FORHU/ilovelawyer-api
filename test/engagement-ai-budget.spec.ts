import { expect } from "chai";
import { afterEach, describe, it } from "mocha";
import EngagementAiBudgetSvc from "../src/services/engagement-ai-budget.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import OrganizationChargeRepo from "../src/repositories/organization-charge.repository";
import HttpError from "../src/utils/http-error";
import * as socket from "../src/lib/socket";

// The engagement's own AI budget (ilovelawyer-api#515, ADR 0016): what comes bundled with the
// per-case fee, metered against the lawyer's own seeded Case for the engagement (the engaged claim's
// lawyerCaseId; a legacy workspace copy on an older engagement), separate from the internal case
// allowance (CaseLimitsSvc). Spend is tracked in USD (LlmUsage.estimatedCostUsd); the budget
// shown to the lawyer is GBP, at a placeholder rate (config.ts) until #846.

const stash = {
  findByLawyerCaseId: ClientRequestRepo.findByLawyerCaseId,
  findByCopyCaseId: ClientRequestRepo.findByCopyCaseId,
  sumCostUsd: LlmUsageRepo.sumCostUsd,
  sumTopUpCredit: OrganizationChargeRepo.sumTopUpCredit,
  emitToUser: socket.emitToUser,
};
const restore = () => {
  Object.assign(ClientRequestRepo, { findByLawyerCaseId: stash.findByLawyerCaseId, findByCopyCaseId: stash.findByCopyCaseId });
  Object.assign(LlmUsageRepo, { sumCostUsd: stash.sumCostUsd });
  Object.assign(OrganizationChargeRepo, { sumTopUpCredit: stash.sumTopUpCredit });
  Object.assign(socket, { emitToUser: stash.emitToUser });
};

/** The engagement the lookup finds for a seeded Case (findByLawyerCaseId), with no legacy copy. */
const seeded = (engagement: { id: string; lawyerCaseId: string; lawyerId: string | null } | null) => {
  (ClientRequestRepo as any).findByLawyerCaseId = async () => engagement;
  (ClientRequestRepo as any).findByCopyCaseId = async () => null;
};

describe("EngagementAiBudgetSvc", () => {
  afterEach(restore);

  describe("forRequest", () => {
    it("has no spend when the lawyer has no Case of their own for the engagement", async () => {
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      const budget = await EngagementAiBudgetSvc.forRequest("r1", null);
      expect(budget.used).to.deep.equal({ amountMinor: 0, currency: "GBP" });
      expect(budget.state).to.equal("OK");
    });

    it("converts the metered Case's USD spend to GBP at the configured placeholder rate", async () => {
      (LlmUsageRepo as any).sumCostUsd = async () => 5;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      const budget = await EngagementAiBudgetSvc.forRequest("r1", "copy-case-1");
      expect(budget.used).to.deep.equal({ amountMinor: EngagementAiBudgetSvc.gbpMinorFromUsd(5), currency: "GBP" });
    });

    it("adds any succeeded AI top-ups to the total available", async () => {
      (LlmUsageRepo as any).sumCostUsd = async () => 0;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 2000;
      const budget = await EngagementAiBudgetSvc.forRequest("r1", "copy-case-1");
      expect(budget.toppedUp).to.deep.equal({ amountMinor: 2000, currency: "GBP" });
      expect(budget.remaining.amountMinor).to.equal(budget.included.amountMinor + 2000);
    });

    it("is OK under 80%, WARNING from 80%, and EXHAUSTED at 100%", async () => {
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      const totalUsd = 20; // matches the default ENGAGEMENT_AI_BUDGET_INCLUDED_USD

      (LlmUsageRepo as any).sumCostUsd = async () => totalUsd * 0.5;
      expect((await EngagementAiBudgetSvc.forRequest("r1", "c1")).state).to.equal("OK");

      (LlmUsageRepo as any).sumCostUsd = async () => totalUsd * 0.8;
      expect((await EngagementAiBudgetSvc.forRequest("r1", "c1")).state).to.equal("WARNING");

      (LlmUsageRepo as any).sumCostUsd = async () => totalUsd;
      expect((await EngagementAiBudgetSvc.forRequest("r1", "c1")).state).to.equal("EXHAUSTED");
    });

    it("never shows negative remaining or over 100%, however much was spent", async () => {
      (LlmUsageRepo as any).sumCostUsd = async () => 1_000_000;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      const budget = await EngagementAiBudgetSvc.forRequest("r1", "c1");
      expect(budget.remaining).to.deep.equal({ amountMinor: 0, currency: "GBP" });
      expect(budget.percentUsed).to.equal(100);
    });
  });

  describe("assertHasBudget", () => {
    it("does nothing for a case that isn't an engagement's seeded Case or legacy copy", async () => {
      seeded(null);
      await EngagementAiBudgetSvc.assertHasBudget("not-a-copy");
    });

    it("meters the lawyer's seeded Case: what it spent, looked up by lawyerCaseId", async () => {
      let lookedUp: string | undefined;
      let summed: string | undefined;
      (ClientRequestRepo as any).findByLawyerCaseId = async (caseId: string) => {
        lookedUp = caseId;
        return { id: "r1", lawyerCaseId: caseId, lawyerId: "lawyer-1" };
      };
      (ClientRequestRepo as any).findByCopyCaseId = async () => {
        throw new Error("a seeded Case must not fall back to the legacy copy lookup");
      };
      (LlmUsageRepo as any).sumCostUsd = async (caseId: string) => {
        summed = caseId;
        return 1_000_000;
      };
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      let err: unknown;
      try {
        await EngagementAiBudgetSvc.assertHasBudget("seeded-case-1");
      } catch (e) {
        err = e;
      }
      expect(lookedUp).to.equal("seeded-case-1");
      expect(summed).to.equal("seeded-case-1");
      expect((err as HttpError).code).to.equal("ENGAGEMENT_AI_BUDGET_SPENT");
    });

    it("still meters a legacy workspace copy (copyCaseId) on an engagement from before seeding", async () => {
      (ClientRequestRepo as any).findByLawyerCaseId = async () => null;
      (ClientRequestRepo as any).findByCopyCaseId = async () => ({ id: "r-old", copyCaseId: "old-copy", lawyerId: "lawyer-1" });
      (LlmUsageRepo as any).sumCostUsd = async () => 1_000_000;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      let err: unknown;
      try {
        await EngagementAiBudgetSvc.assertHasBudget("old-copy");
      } catch (e) {
        err = e;
      }
      expect((err as HttpError).code).to.equal("ENGAGEMENT_AI_BUDGET_SPENT");
    });

    it("lets AI work through while there's budget left", async () => {
      seeded({ id: "r1", lawyerCaseId: "c1", lawyerId: "lawyer-1" });
      (LlmUsageRepo as any).sumCostUsd = async () => 1;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      await EngagementAiBudgetSvc.assertHasBudget("c1");
    });

    it("refuses AI work with ENGAGEMENT_AI_BUDGET_SPENT once the budget is exhausted", async () => {
      seeded({ id: "r1", lawyerCaseId: "c1", lawyerId: "lawyer-1" });
      (LlmUsageRepo as any).sumCostUsd = async () => 1_000_000;
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      try {
        await EngagementAiBudgetSvc.assertHasBudget("c1");
        expect.fail("expected a refusal");
      } catch (err) {
        expect(err).to.be.instanceOf(HttpError);
        expect((err as HttpError).statusCode).to.equal(403);
        expect((err as HttpError).code).to.equal("ENGAGEMENT_AI_BUDGET_SPENT");
      }
    });
  });

  describe("checkThresholds", () => {
    it("tells the engaged lawyer when a call crosses from OK to WARNING", async () => {
      seeded({ id: "r1", lawyerCaseId: "c1", lawyerId: "lawyer-1" });
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      // After this call: 80% of the 20 USD included budget. Before it: 79%, still OK.
      (LlmUsageRepo as any).sumCostUsd = async () => 16;
      const emitted: unknown[] = [];
      (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);

      await EngagementAiBudgetSvc.checkThresholds("c1", 0.2);

      expect(emitted).to.deep.equal([["lawyer-1", "engagement:ai-budget", { requestId: "r1", percentUsed: 80, state: "WARNING" }]]);
    });

    it("says nothing when the state didn't change", async () => {
      seeded({ id: "r1", lawyerCaseId: "c1", lawyerId: "lawyer-1" });
      (OrganizationChargeRepo as any).sumTopUpCredit = async () => 0;
      (LlmUsageRepo as any).sumCostUsd = async () => 5;
      const emitted: unknown[] = [];
      (socket as any).emitToUser = (...args: unknown[]) => emitted.push(args);

      await EngagementAiBudgetSvc.checkThresholds("c1", 0.1);

      expect(emitted).to.deep.equal([]);
    });

    it("does nothing for a case that isn't an engagement's seeded Case or legacy copy", async () => {
      seeded(null);
      const emitted: unknown[] = [];
      (socket as any).emitToUser = (...args: unknown[]) => emitted.push(args);

      await EngagementAiBudgetSvc.checkThresholds("not-a-copy", 1);

      expect(emitted).to.deep.equal([]);
    });

    it("never throws, even if the lookup fails", async () => {
      (ClientRequestRepo as any).findByLawyerCaseId = async () => {
        throw new Error("db unreachable");
      };
      await EngagementAiBudgetSvc.checkThresholds("c1", 1);
    });
  });
});
