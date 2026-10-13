/** The REPORTED LlmUsage rows for direct provider calls (#403, epic #399): OpenAI embeddings and
 * TypeSafe Jev (through jevAsk's usage hook, #407). The SDK methods are stubbed on their prototypes, so there is no network;
 * LlmUsageRepo.create is captured.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import OpenAI from "openai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import { embedTexts } from "../src/utils/embedding";
import LlmUsageSvc from "../src/services/llm-usage.service";
import { JevUnavailableError, jevAsk, setJevUsageRecorder } from "../src/utils/typesafeClient";

describe("direct provider LlmUsage rows", () => {
  let rows: any[];
  let restore: (() => void)[];

  beforeEach(() => {
    rows = [];
    restore = [];
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    const create = LlmUsageRepo.create;
    (LlmUsageRepo as any).create = async (data: object) => {
      rows.push(data);
      return data;
    };
    restore.push(() => ((LlmUsageRepo as any).create = create));
  });

  afterEach(() => restore.forEach((fn) => fn()));

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  describe("embedTexts", () => {
    it("records the provider's own total_tokens as one REPORTED row", async () => {
      patch((OpenAI as any).Embeddings.prototype, "create", async () => ({ data: [{ embedding: [0.1] }, { embedding: [0.2] }], usage: { prompt_tokens: 40, total_tokens: 40 } }));
      const out = await embedTexts(["one", "two"]);
      expect(out).to.deep.equal([[0.1], [0.2]]);
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({
        provider: "OPENAI",
        via: "direct",
        model: "text-embedding-3-small",
        feature: "embedding",
        source: "REPORTED",
        inputTokens: 40,
        outputTokens: 0,
        totalTokens: 40,
        success: true,
      });
    });

    it("records nothing for a rate-limited attempt, and one row for the attempt that succeeds", async () => {
      let calls = 0;
      patch((OpenAI as any).Embeddings.prototype, "create", async () => {
        if (++calls === 1) throw Object.assign(new Error("slow down. try again in 1 ms"), { status: 429 });
        return { data: [{ embedding: [1] }], usage: { total_tokens: 7 } };
      });
      await embedTexts(["x"]);
      expect(calls).to.equal(2);
      expect(rows).to.have.length(1);
      expect(rows[0].inputTokens).to.equal(7);
    });

    it("records 0 tokens, not a crash, when the response has no usage", async () => {
      patch((OpenAI as any).Embeddings.prototype, "create", async () => ({ data: [{ embedding: [1] }] }));
      await embedTexts(["x"]);
      expect(rows[0].inputTokens).to.equal(0);
    });
  });

  describe("jevAsk (via LlmUsageSvc.registerJevRecorder)", () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      LlmUsageSvc.registerJevRecorder();
      restore.push(() => setJevUsageRecorder(null));
    });

    it("records one REPORTED row with the provider's numbers and model, and returns the result untouched", async () => {
      const result = { model: "jev-1", answers: { a: "YES" }, usage: { input_tokens: 120, output_tokens: 3 } };
      patch(TypeSafeClient.prototype, "systemOne", () => Promise.resolve(result));
      const got = await jevAsk("citation-validity", { state: {}, questions: {} } as any);
      await settle();

      expect(got).to.equal(result);
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({
        provider: "TYPESAFE",
        via: "direct",
        model: "jev-1",
        feature: "jev:citation-validity",
        source: "REPORTED",
        inputTokens: 120,
        outputTokens: 3,
        totalTokens: 123,
        success: true,
      });
    });

    it("records a failure with 0 tokens, and jevAsk still throws JevUnavailableError with the original as cause", async () => {
      const boom = new Error("jev down");
      patch(TypeSafeClient.prototype, "systemOne", () => Promise.reject(boom));
      let thrown: any;
      try {
        await jevAsk("message-triage", { state: {}, questions: {} } as any);
      } catch (err) {
        thrown = err;
      }
      await settle();

      expect(thrown).to.be.instanceOf(JevUnavailableError);
      expect(thrown.cause).to.equal(boom);
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ feature: "jev:message-triage", success: false, inputTokens: 0, outputTokens: 0, model: null });
    });

    it("records exactly one row per call (nothing else records Jev)", async () => {
      patch(TypeSafeClient.prototype, "systemOne", () => Promise.resolve({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }));
      await jevAsk("a", { state: {}, questions: {} } as any);
      await jevAsk("b", { state: {}, questions: {} } as any);
      await settle();
      expect(rows.map((r) => r.feature)).to.deep.equal(["jev:a", "jev:b"]);
    });

    it("never affects the answer when the ledger write fails", async () => {
      (LlmUsageRepo as any).create = async () => {
        throw new Error("db down");
      };
      const result = { model: "m", answers: { a: "YES" }, usage: { input_tokens: 1, output_tokens: 1 } };
      patch(TypeSafeClient.prototype, "systemOne", () => Promise.resolve(result));
      const got = await jevAsk("x", { state: {}, questions: {} } as any);
      await settle();
      expect(got).to.equal(result);
    });
  });
});
