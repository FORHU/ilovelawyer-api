import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkQuotedFigure, isRejected, quotedFigureOf, vetDamageHeads, QuotedHead } from "../src/utils/damages-jev";

const head = (label: string, extra: Partial<QuotedHead> = {}): QuotedHead => ({
  category: "ACTUAL",
  label,
  basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 },
  amount: null,
  quote: "Basic monthly salary: P27,000.00",
  ...extra,
});

describe("quotedFigureOf", () => {
  it("is the figure the quote supplied: a rate, a stated amount or a percentage", () => {
    expect(quotedFigureOf({ kind: "RATE_X_PERIOD", monthlyRate: 2900, fromDate: "2026-09-27", untilDate: "asOf" }, 87)).to.equal("2900 per month");
    expect(quotedFigureOf(null, 200000)).to.equal("200000");
    expect(quotedFigureOf({ kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL"] }, 4860)).to.equal("10%");
    expect(quotedFigureOf(null, null)).to.equal(null);
  });
});

describe("isRejected", () => {
  it("rejects only a confident UNSUPPORTED or CONTRADICTED", () => {
    expect(isRejected({ verdict: "UNSUPPORTED", confidence: 0.8 })).to.equal(true);
    expect(isRejected({ verdict: "CONTRADICTED", confidence: 0.9 })).to.equal(true);
    expect(isRejected({ verdict: "UNSUPPORTED", confidence: 0.3 })).to.equal(false);
    expect(isRejected({ verdict: "SUPPORTED", confidence: 0.99 })).to.equal(false);
    expect(isRejected(null)).to.equal(false);
  });
});

describe("Jev quote check", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let replies: Record<string, unknown>;
  let states: any[];

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    process.env.USE_JEV_DAMAGES = "true";
    replies = {};
    states = [];
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { head: { label: string } } }) => {
      states.push(req.state);
      const reply = replies[req.state.head.label];
      if (reply instanceof Error) throw reply;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    delete process.env.USE_JEV_DAMAGES;
  });

  const support = (choice: string, confidence: number) => ({ answers: { support: { choice, confidence } } });

  it("asks about the quoted figure only, never an accrued amount", async () => {
    replies = { Backwages: support("SUPPORTED", 0.9) };
    await checkQuotedFigure(head("Backwages", { amount: 87 }));
    expect(states[0]).to.deep.equal({
      head: { category: "ACTUAL", label: "Backwages" },
      quote: "Basic monthly salary: P27,000.00",
      quotedFigure: "27000 per month",
    });
  });

  it("downgrades a low-confidence CONTRADICTED, and reports a failed call as null", async () => {
    replies = { A: support("CONTRADICTED", 0.6), B: new Error("boom") };
    expect(await checkQuotedFigure(head("A"))).to.deep.equal({ verdict: "UNSUPPORTED", confidence: 0.6 });
    expect(await checkQuotedFigure(head("B"))).to.equal(null);
  });

  it("splits proposals into accepted and rejected, keeping what Jev can't judge", async () => {
    replies = {
      Good: support("SUPPORTED", 0.9),
      Wrong: support("UNSUPPORTED", 0.85),
      Unsure: support("UNSUPPORTED", 0.3),
      Failed: new Error("boom"),
    };
    const out = await vetDamageHeads([head("Good"), head("Wrong"), head("Unsure"), head("Failed")]);
    expect(out.accepted.map((h) => h.label)).to.deep.equal(["Good", "Unsure", "Failed"]);
    expect(out.rejected.map((r) => [r.head.label, r.check.verdict])).to.deep.equal([["Wrong", "UNSUPPORTED"]]);
  });

  it("keeps everything unchecked when the flag is off", async () => {
    delete process.env.USE_JEV_DAMAGES;
    const out = await vetDamageHeads([head("A")]);
    expect(out.accepted).to.have.length(1);
    expect(states).to.deep.equal([]);
  });
});
