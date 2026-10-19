/** The free AI credit every new account gets (User.freeCreditUsd): measured against the account's
 * OpenAI usage through Chat Wonder, and once spent, no new work while reads stay open. No live
 * Postgres: AuthRepo and LlmUsageRepo are monkeypatched on their classes, as in trial-guest.spec. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import AuthRepo from "../src/repositories/auth.repository";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import LlmUsageSvc from "../src/services/llm-usage.service";
import { freeCreditLimit } from "../src/middleware/free-credit.middleware";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function run(req: any): Promise<any> {
  return new Promise((resolve) => {
    void freeCreditLimit(req, {} as any, (err?: any) => resolve(err ?? null));
  });
}

describe("Free AI credit", () => {
  let saved: { findFreeCredit: unknown; chatWonderSpend: unknown };
  let credit: number | null;
  let spend: { pricedUsd: number; unpriced: { inputTokens: number; cachedInputTokens: number; outputTokens: number } };
  const headers = () => ({ authorization: `Bearer ${jwt.sign({ userId: "u1" }, ACCESS_TOKEN_SECRET)}` });
  const req = (method: string, path: string, h: object = headers()) => ({ method, baseUrl: "/api", path, headers: h });

  beforeEach(() => {
    saved = { findFreeCredit: AuthRepo.findFreeCredit, chatWonderSpend: LlmUsageRepo.chatWonderSpend };
    credit = 20;
    spend = { pricedUsd: 0, unpriced: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
    (AuthRepo as any).findFreeCredit = async () => credit;
    (LlmUsageRepo as any).chatWonderSpend = async () => spend;
  });
  afterEach(() => {
    (AuthRepo as any).findFreeCredit = saved.findFreeCredit;
    (LlmUsageRepo as any).chatWonderSpend = saved.chatWonderSpend;
  });

  it("lets an account with credit left do anything", async () => {
    spend.pricedUsd = 19.99;
    for (const [method, path] of [
      ["POST", "/chat/consultations/c1/messages"],
      ["POST", "/my-cases"],
      ["POST", "/my-cases/c1/refresh"],
      ["GET", "/my-cases/c1/export"],
    ]) {
      expect(await run(req(method, path)), `${method} ${path}`).to.equal(null);
    }
  });

  it("refuses all new work with 403 FREE_CREDIT_SPENT once the credit is spent, but reads still pass", async () => {
    spend.pricedUsd = 20;
    for (const [method, path] of [
      ["POST", "/chat/consultations/c1/messages"],
      ["POST", "/my-cases"],
      ["POST", "/my-cases/c1/mind-map/generate"],
      ["PATCH", "/organizations/o1"],
      ["GET", "/my-cases/c1/export"],
    ]) {
      const err = await run(req(method, path));
      expect(err?.statusCode, `${method} ${path}`).to.equal(403);
      expect(err.code).to.equal("FREE_CREDIT_SPENT");
    }
    expect(await run(req("GET", "/my-cases/c1"))).to.equal(null);
  });

  it("keeps signing in and out and the account itself open after the credit is spent", async () => {
    spend.pricedUsd = 50;
    for (const path of ["/auth/logout", "/auth/refresh", "/users/me/change-password", "/users/me/export", "/consents/AI_PROCESSING"]) {
      expect(await run(req("POST", path)), path).to.equal(null);
    }
  });

  it("never limits an account with no credit (one created before it existed)", async () => {
    credit = null;
    spend.pricedUsd = 1000;
    expect(await run(req("POST", "/chat/consultations/c1/messages"))).to.equal(null);
  });

  it("leaves requests without a valid token to the router", async () => {
    spend.pricedUsd = 1000;
    expect(await run(req("POST", "/trial/start", {}))).to.equal(null);
  });

  it("counts unpriced Chat Wonder rows at the chat model's rate", async () => {
    // 1M output tokens of gpt-5.6-terra is $12; with $10 priced, that crosses $20.
    spend = { pricedUsd: 10, unpriced: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 } };
    expect(await LlmUsageSvc.chatWonderSpendUsd("u1")).to.equal(22);
    expect((await run(req("POST", "/chat/consultations/c1/messages")))?.code).to.equal("FREE_CREDIT_SPENT");
  });
});
