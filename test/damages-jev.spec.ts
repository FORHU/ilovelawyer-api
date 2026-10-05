import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkQuotedFigure, isRejected, quotedFigureOf, vetDamageHeads, QuotedHead } from "../src/utils/damages-jev";

const head = (title: string, extra: Partial<QuotedHead> = {}): QuotedHead => ({
  kind: "DAMAGE",
  title,
  amount: 486000,
  quote: "backwages of P486,000.00",
  ...extra,
});

describe("quotedFigureOf", () => {
  it("is the entry's amount, or null for one without", () => {
    expect(quotedFigureOf(200000)).to.equal("200000");
    expect(quotedFigureOf(null)).to.equal(null);
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
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { head: { title: string } } }) => {
      states.push(req.state);
      const reply = replies[req.state.head.title];
      if (reply instanceof Error) throw reply;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    delete process.env.USE_JEV_DAMAGES;
  });

  const support = (choice: string, confidence: number) => ({ answers: { support: { choice, confidence } } });

  it("asks whether the quote states the entry's amount", async () => {
    replies = { Backwages: support("SUPPORTED", 0.9) };
    await checkQuotedFigure(head("Backwages"));
    expect(states[0]).to.deep.equal({
      head: { kind: "DAMAGE", title: "Backwages" },
      quote: "backwages of P486,000.00",
      quotedFigure: "486000",
    });
  });

  it("doesn't ask about an entry with no amount", async () => {
    expect(await checkQuotedFigure(head("Reinstatement", { kind: "REMEDY", amount: null }))).to.equal(null);
    expect(states).to.deep.equal([]);
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
    expect(out.accepted.map((h) => h.title)).to.deep.equal(["Good", "Unsure", "Failed"]);
    expect(out.rejected.map((r) => [r.head.title, r.check.verdict])).to.deep.equal([["Wrong", "UNSUPPORTED"]]);
  });

  it("keeps everything unchecked when the flag is off", async () => {
    delete process.env.USE_JEV_DAMAGES;
    const out = await vetDamageHeads([head("A")]);
    expect(out.accepted).to.have.length(1);
    expect(states).to.deep.equal([]);
  });
});
