/** #407: jevAsk, the one way every Jev check calls TypeSafe. No live Jev — the client is
 * monkeypatched on its prototype, the same idiom as the other *-jev specs, so this also proves
 * those specs' fakes still reach the checks through the wrapper. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import { JevUnavailableError, JevUsageEntry, jevAsk, setJevUsageRecorder } from "../src/utils/typesafeClient";

const question = { relevant: noul("Is `text` about billing?") };
const reply = {
  model: "jev-1.13",
  answers: { relevant: { probability: 0.9 } },
  usage: { input_tokens: 120, output_tokens: 3 },
};

describe("jevAsk", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let recorded: JevUsageEntry[];
  let seenOptions: any;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    recorded = [];
    seenOptions = undefined;
    setJevUsageRecorder((entry) => {
      recorded.push(entry);
    });
  });

  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    setJevUsageRecorder(null);
  });

  it("returns Jev's answer and records the model and tokens it used", async () => {
    (TypeSafeClient.prototype as any).systemOne = async (_req: unknown, options: unknown) => {
      seenOptions = options;
      return reply;
    };

    const result = await jevAsk("billing-check", { state: { text: "charged twice" }, questions: question });

    expect(result.answers.relevant).to.deep.equal({ probability: 0.9 });
    expect(seenOptions.signal).to.be.instanceOf(AbortSignal);
    expect(recorded).to.have.length(1);
    expect(recorded[0]).to.include({ feature: "billing-check", model: "jev-1.13", inputTokens: 120, outputTokens: 3, success: true });
  });

  it("works with a reply that carries no model or usage, as the specs' fakes do", async () => {
    (TypeSafeClient.prototype as any).systemOne = async () => ({ answers: { relevant: { probability: 0.2 } } });

    const result = await jevAsk("billing-check", { state: "x", questions: question });

    expect(result.answers.relevant).to.deep.equal({ probability: 0.2 });
    expect(recorded[0]).to.include({ model: null, inputTokens: 0, outputTokens: 0, success: true });
  });

  it("turns any SDK failure into JevUnavailableError, keeping the original as its cause", async () => {
    const boom = new Error("503 from TypeSafe");
    (TypeSafeClient.prototype as any).systemOne = async () => {
      throw boom;
    };

    let caught: unknown;
    try {
      await jevAsk("billing-check", { state: "x", questions: question });
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(JevUnavailableError);
    expect(caught).to.include({ feature: "billing-check", reason: "error", cause: boom });
    expect(recorded[0]).to.include({ success: false, inputTokens: 0 });
  });

  it("gives up after the time limit and aborts the request so its retries stop", async () => {
    let signal: AbortSignal | undefined;
    (TypeSafeClient.prototype as any).systemOne = (_req: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => {});
    };

    const started = Date.now();
    let caught: unknown;
    try {
      await jevAsk("billing-check", { state: "x", questions: question }, { timeoutMs: 50 });
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(JevUnavailableError);
    expect((caught as JevUnavailableError).reason).to.equal("timeout");
    expect(signal?.aborted).to.equal(true);
    expect(Date.now() - started).to.be.lessThan(1000);
    expect(recorded[0]).to.include({ success: false });
  });

  it("never lets a failing usage recorder affect the answer", async () => {
    (TypeSafeClient.prototype as any).systemOne = async () => reply;
    setJevUsageRecorder(() => {
      throw new Error("ledger down");
    });
    const sync = await jevAsk("billing-check", { state: "x", questions: question });
    expect(sync.answers.relevant).to.deep.equal({ probability: 0.9 });

    setJevUsageRecorder(async () => {
      throw new Error("ledger down");
    });
    const async_ = await jevAsk("billing-check", { state: "x", questions: question });
    expect(async_.answers.relevant).to.deep.equal({ probability: 0.9 });
  });
});
