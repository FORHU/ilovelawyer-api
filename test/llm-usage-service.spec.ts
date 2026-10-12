/** LlmUsageSvc.record (#401, epic #399) — how a row is filled in, that recording never throws or
 * waits on the write, the token estimator and the price table. No live Postgres: LlmUsageRepo is
 * monkeypatched on its CommonJS module object, same idiom as test/security-audit-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import LlmUsageSvc from "../src/services/llm-usage.service";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import { runWithRequestContext, RequestContext } from "../src/lib/request-context";
import { estimateTokens } from "../src/utils/token-estimate";
import { estimateCostUsd, LLM_PRICES, ModelPrice } from "../src/constants/llm-pricing.constants";
import logger from "../src/utils/logger";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

function context(userId: string | null, organizationId: string | null): RequestContext {
  return { requestId: "req-1", ip: null, userAgent: null, userId: () => userId, organizationId: () => organizationId, tenantCode: () => null };
}

const base = { provider: "OPENAI", feature: "chat", source: "ESTIMATED", inputTokens: 100, outputTokens: 20 } as const;

describe("LlmUsageSvc.record", () => {
  let restore: (() => void)[];
  let rows: any[];
  let warnings: unknown[][];

  beforeEach(() => {
    rows = [];
    warnings = [];
    restore = [stash(LlmUsageRepo as any, ["create"]), stash(logger as any, ["warn"])];
    (LlmUsageRepo as any).create = async (data: object) => {
      rows.push(data);
      return data;
    };
    (logger as any).warn = (...args: unknown[]) => warnings.push(args);
  });

  afterEach(() => restore.forEach((fn) => fn()));

  it("writes the row it was given, with the total and defaults filled in", () => {
    LlmUsageSvc.record({ ...base, via: "chat-wonder", caseId: "case-1", durationMs: 1234 });
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({
      provider: "OPENAI",
      via: "chat-wonder",
      model: null,
      feature: "chat",
      source: "ESTIMATED",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: null,
      totalTokens: 120,
      passCount: null,
      estimatedCostUsd: null,
      userId: null,
      organizationId: null,
      caseId: "case-1",
      consultationId: null,
      durationMs: 1234,
      success: true,
    });
  });

  it("does not add cached tokens to the total — they are part of the input", () => {
    LlmUsageSvc.record({ ...base, source: "REPORTED", cachedInputTokens: 60, passCount: 4 });
    expect(rows[0]).to.include({ cachedInputTokens: 60, totalTokens: 120, passCount: 4 });
  });

  it("fills userId and organizationId from the request context", () => {
    runWithRequestContext(context("user-1", "org-1"), () => LlmUsageSvc.record(base));
    expect(rows[0]).to.include({ userId: "user-1", organizationId: "org-1" });
  });

  it("lets an explicit id, or an explicit null, override the request context", () => {
    runWithRequestContext(context("user-1", "org-1"), () => {
      LlmUsageSvc.record({ ...base, userId: "user-2", organizationId: null });
    });
    expect(rows[0]).to.include({ userId: "user-2", organizationId: null });
  });

  it("writes the cost of a priced model, and null for one nobody has priced", () => {
    LlmUsageSvc.record({ ...base, source: "REPORTED", model: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    LlmUsageSvc.record({ ...base, source: "REPORTED", model: "some-new-model", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(rows[0].estimatedCostUsd).to.be.closeTo(1.4, 1e-9);
    expect(rows[1].estimatedCostUsd).to.equal(null);
  });

  it("records a failed call", () => {
    LlmUsageSvc.record({ ...base, success: false, inputTokens: 0, outputTokens: 0 });
    expect(rows[0]).to.include({ success: false, totalTokens: 0 });
  });

  it("does not throw, and logs, when the write is rejected", async () => {
    (LlmUsageRepo as any).create = () => Promise.reject(new Error("db down"));
    expect(() => LlmUsageSvc.record(base)).to.not.throw();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).to.have.length(1);
    expect(String(warnings[0][0])).to.contain("failed to write");
  });

  it("does not throw, and logs, when the repo throws synchronously", () => {
    (LlmUsageRepo as any).create = () => {
      throw new Error("boom");
    };
    expect(() => LlmUsageSvc.record(base)).to.not.throw();
    expect(warnings).to.have.length(1);
  });

  it("does not throw on an entry it cannot read", () => {
    expect(() => LlmUsageSvc.record(undefined as any)).to.not.throw();
    expect(rows).to.have.length(0);
    expect(warnings).to.have.length(1);
  });

  it("returns before the write finishes", () => {
    let finished = false;
    (LlmUsageRepo as any).create = () => new Promise((resolve) => setTimeout(() => ((finished = true), resolve(undefined)), 20));
    LlmUsageSvc.record(base);
    expect(finished).to.equal(false);
  });
});

describe("estimateTokens", () => {
  it("is characters / 4, rounded up", () => {
    expect(estimateTokens("abcd")).to.equal(1);
    expect(estimateTokens("abcde")).to.equal(2);
    expect(estimateTokens("x".repeat(400))).to.equal(100);
  });

  it("is 0 for empty, null and undefined", () => {
    expect(estimateTokens("")).to.equal(0);
    expect(estimateTokens(null)).to.equal(0);
    expect(estimateTokens(undefined)).to.equal(0);
  });
});

describe("estimateCostUsd", () => {
  const prices: Record<string, ModelPrice> = {
    "model-a": { input: 2, cachedInput: 0.5, output: 8 },
    "model-b": { input: 1, output: 4 },
  };

  it("is null for an unknown or missing model, never 0", () => {
    expect(estimateCostUsd("nope", { inputTokens: 1000, outputTokens: 1000 }, prices)).to.equal(null);
    expect(estimateCostUsd(null, { inputTokens: 1000, outputTokens: 1000 }, prices)).to.equal(null);
    expect(estimateCostUsd(undefined, { inputTokens: 1000, outputTokens: 1000 }, prices)).to.equal(null);
  });

  it("prices input and output per million tokens", () => {
    expect(estimateCostUsd("model-b", { inputTokens: 1_000_000, outputTokens: 500_000 }, prices)).to.equal(3);
  });

  it("bills cached input at the cached rate and the rest at the input rate", () => {
    // 400k uncached at 2 + 600k cached at 0.5 + 100k output at 8 = 0.8 + 0.3 + 0.8
    const cost = estimateCostUsd("model-a", { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000 }, prices);
    expect(cost).to.be.closeTo(1.9, 1e-9);
  });

  it("bills cached input at the input rate when the model has no cached price", () => {
    const cost = estimateCostUsd("model-b", { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 0 }, prices);
    expect(cost).to.equal(1);
  });

  it("never bills more cached tokens than there are input tokens", () => {
    const cost = estimateCostUsd("model-a", { inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 0 }, prices);
    expect(cost).to.equal(0.5);
  });

  describe("the shipped price table", () => {
    it("prices gpt-5.6-terra at $2 in / $0.20 cached / $12 out per million", () => {
      // 400k uncached at 2 + 600k cached at 0.2 + 100k output at 12 = 0.8 + 0.12 + 1.2
      expect(estimateCostUsd("gpt-5.6-terra", { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000 })).to.be.closeTo(2.12, 1e-9);
    });

    it("prices gpt-5.6-luna at $0.20 in / $1.20 out per million", () => {
      expect(estimateCostUsd("gpt-5.6-luna", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).to.be.closeTo(1.4, 1e-9);
    });

    it("prices a dated snapshot of a known model like the model itself, whatever the case", () => {
      const tokens = { inputTokens: 1_000_000, outputTokens: 0 };
      expect(estimateCostUsd("gpt-5.6-luna-2026-09-01", tokens)).to.equal(estimateCostUsd("gpt-5.6-luna", tokens));
      expect(estimateCostUsd("GPT-5.6-Luna", tokens)).to.equal(estimateCostUsd("gpt-5.6-luna", tokens));
    });

    it("prices every Jev model version at $0.042 per million input, output free", () => {
      expect(estimateCostUsd("jev-1", { inputTokens: 1_000_000, outputTokens: 5_000 })).to.be.closeTo(0.042, 1e-12);
      expect(estimateCostUsd("Jev 1.13".replace(" ", "-"), { inputTokens: 1_000_000, outputTokens: 0 })).to.be.closeTo(0.042, 1e-12);
    });

    it("prices gpt-4o, gpt-4o-mini and the embedding model from OpenAI's model pages", () => {
      expect(estimateCostUsd("gpt-4o", { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 })).to.be.closeTo(0.6 * 2.5 + 0.4 * 1.25 + 0.1 * 10, 1e-9);
      expect(estimateCostUsd("gpt-4o-mini", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 })).to.be.closeTo(0.075 + 0.6, 1e-9);
      expect(estimateCostUsd("text-embedding-3-small", { inputTokens: 1_000_000, outputTokens: 0 })).to.be.closeTo(0.02, 1e-12);
    });

    it("still gives a model nobody has priced a null cost, not zero", () => {
      for (const model of ["gpt-5.6-lunar", "gpt-4o-audio-preview", "some-new-model"]) {
        expect(estimateCostUsd(model, { inputTokens: 1000, outputTokens: 1000 }), model).to.equal(null);
      }
    });
  });

  it("ships with no unverified prices: every price in the table is complete", () => {
    for (const [model, price] of Object.entries(LLM_PRICES)) {
      expect(price.input, model).to.be.a("number");
      expect(price.output, model).to.be.a("number");
    }
  });
});
