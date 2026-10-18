/** The landing-page trial guest: the chat-only trial's AI-answer cap and write block, the full
 * trial's spend limit, and what TrialSvc refuses. No live Postgres: AuthRepo and LlmUsageRepo are
 * monkeypatched on their classes, same idiom as test/account-restore-on-login.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import AuthRepo from "../src/repositories/auth.repository";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import LlmUsageSvc from "../src/services/llm-usage.service";
import TrialSvc from "../src/services/trial.service";
import { blockTrialWrites, trialMessageLimit } from "../src/middleware/trial.middleware";
import * as config from "../src/config";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function run(mw: (req: any, res: any, next: (err?: any) => void) => Promise<void>, req: any): Promise<any> {
  return new Promise((resolve) => {
    void mw(req, {}, (err?: any) => resolve(err ?? null));
  });
}

const cfg = config as unknown as Record<string, unknown>;

describe("Trial guest", () => {
  let saved: Record<string, any>;
  let savedBudget: unknown;
  let trial: { kind: "CHAT" | "FULL"; expiresAt: Date | null; messagesUsed: number } | null;
  let left: number;
  let spend: { pricedUsd: number; unpriced: { inputTokens: number; cachedInputTokens: number; outputTokens: number } };

  beforeEach(() => {
    saved = {
      findTrialState: AuthRepo.findTrialState,
      spendTrialMessage: AuthRepo.spendTrialMessage,
      spendTrialFeature: AuthRepo.spendTrialFeature,
      chatWonderSpend: LlmUsageRepo.chatWonderSpend,
    };
    savedBudget = cfg.TRIAL_BUDGET_USD;
    cfg.TRIAL_BUDGET_USD = 20;
    trial = { kind: "CHAT", expiresAt: new Date(Date.now() + 60_000), messagesUsed: 0 };
    left = 1;
    spend = { pricedUsd: 0, unpriced: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    (AuthRepo as any).findTrialState = async () => trial;
    (AuthRepo as any).spendTrialMessage = async () => left-- > 0;
    (AuthRepo as any).spendTrialFeature = async () => {
      throw new Error("a full-trial guest never spends feature uses");
    };
    (LlmUsageRepo as any).chatWonderSpend = async () => spend;
  });
  afterEach(() => {
    const { chatWonderSpend, ...auth } = saved;
    Object.assign(AuthRepo, auth);
    (LlmUsageRepo as any).chatWonderSpend = chatWonderSpend;
    cfg.TRIAL_BUDGET_USD = savedBudget;
  });

  const headers = () => ({ authorization: `Bearer ${jwt.sign({ userId: "u1" }, ACCESS_TOKEN_SECRET)}` });

  describe("chat-only trial", () => {
    it("lets a guest send until the cap, then answers 403 TRIAL_LIMIT_REACHED", async () => {
      const req = { user: { userId: "u1" } };
      expect(await run(trialMessageLimit, req)).to.equal(null);
      const err = await run(trialMessageLimit, req);
      expect(err.statusCode).to.equal(403);
      expect(err.code).to.equal("TRIAL_LIMIT_REACHED");
    });

    it("does not count or limit a real account", async () => {
      trial = null;
      expect(await run(trialMessageLimit, { user: { userId: "u1" } })).to.equal(null);
      expect(left).to.equal(1);
    });

    it("blocks a guest's writes but not their reads or anyone else's writes", async () => {
      const blocked = await run(blockTrialWrites, { method: "POST", headers: headers() });
      expect(blocked.code).to.equal("TRIAL_RESTRICTED");
      expect(await run(blockTrialWrites, { method: "GET", headers: headers() })).to.equal(null);
      expect(await run(blockTrialWrites, { method: "POST", headers: {} })).to.equal(null);
      trial = null;
      expect(await run(blockTrialWrites, { method: "POST", headers: headers() })).to.equal(null);
    });
  });

  describe("full trial", () => {
    beforeEach(() => {
      trial = { kind: "FULL", expiresAt: null, messagesUsed: 0 };
    });

    it("blocks nothing while the budget lasts, and spends no answers or feature uses", async () => {
      spend.pricedUsd = 19.99;
      expect(await run(trialMessageLimit, { user: { userId: "u1" } })).to.equal(null);
      expect(left).to.equal(1);
      for (const [method, baseUrl, path] of [
        ["POST", "/api/organizations", "/"],
        ["POST", "/api/my-cases", "/c1/access"],
        ["POST", "/api/my-cases", "/c1/mind-map/generate"],
        ["GET", "/api/my-cases", "/c1/export"],
      ]) {
        expect(await run(blockTrialWrites, { method, baseUrl, path, headers: headers() }), `${method} ${baseUrl}${path}`).to.equal(null);
      }
    });

    it("refuses new work with 403 TRIAL_BUDGET_SPENT once the budget is reached, but reads still pass", async () => {
      spend.pricedUsd = 20;
      const chat = await run(trialMessageLimit, { user: { userId: "u1" } });
      expect(chat.statusCode).to.equal(403);
      expect(chat.code).to.equal("TRIAL_BUDGET_SPENT");
      const write = await run(blockTrialWrites, { method: "POST", baseUrl: "/api/my-cases", path: "/c1/mind-map/generate", headers: headers() });
      expect(write.code).to.equal("TRIAL_BUDGET_SPENT");
      const brief = await run(blockTrialWrites, { method: "GET", baseUrl: "/api/my-cases", path: "/c1/export", headers: headers() });
      expect(brief.code).to.equal("TRIAL_BUDGET_SPENT");
      expect(await run(blockTrialWrites, { method: "GET", baseUrl: "/api/my-cases", path: "/c1", headers: headers() })).to.equal(null);
    });

    it("counts unpriced Chat Wonder rows at the chat model's rate", async () => {
      // 1M output tokens of gpt-5.6-terra is $12; with $10 priced, that crosses $20.
      spend = { pricedUsd: 10, unpriced: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 } };
      expect(await LlmUsageSvc.chatWonderSpendUsd("u1")).to.equal(22);
      expect((await run(trialMessageLimit, { user: { userId: "u1" } })).code).to.equal("TRIAL_BUDGET_SPENT");
    });

    it("treats a guest as spent when no budget is configured", async () => {
      cfg.TRIAL_BUDGET_USD = null;
      expect((await run(trialMessageLimit, { user: { userId: "u1" } })).code).to.equal("TRIAL_BUDGET_SPENT");
    });

    it("is not offered when no budget is configured", async () => {
      cfg.TRIAL_BUDGET_USD = null;
      try {
        await TrialSvc.start("UK", "FULL");
        expect.fail("should have refused");
      } catch (err: any) {
        expect(err.statusCode).to.equal(404);
      }
    });
  });

  it("only starts a trial on the UK tenant", async () => {
    for (const code of [null, "PH"] as const) {
      for (const kind of ["CHAT", "FULL"] as const) {
        try {
          await TrialSvc.start(code, kind);
          expect.fail("should have refused");
        } catch (err: any) {
          expect(err.statusCode).to.equal(404);
        }
      }
    }
  });
});
