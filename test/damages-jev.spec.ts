import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildDamageJevState, quotedFigureOf, verifyDamageHeadsWithJev, DamageJevHead, DamageJevContext } from "../src/utils/damages-jev";

const context: DamageJevContext = {
  legalIssues: ["Was the dismissal for just cause?"],
  strengths: ["No notice to explain was served"],
  weaknesses: ["No evidence of bad faith in the manner of dismissal"],
};

const head = (id: string, extra: Partial<DamageJevHead> = {}): DamageJevHead => ({
  id,
  category: "ACTUAL",
  label: "Backwages",
  amount: 486000,
  basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000, months: 18 },
  sourceQuote: "Basic monthly salary: P27,000.00",
  ...extra,
});

describe("buildDamageJevState", () => {
  it("describes the basis in words and only includes a quote when there is one", () => {
    const withQuote = buildDamageJevState(head("a"), context);
    expect(withQuote.head.basis).to.equal("27000 × 18 months");
    expect(withQuote).to.have.property("quote", "Basic monthly salary: P27,000.00");
    // The support check compares the quote with the rate it gave, never the accrued amount.
    expect(withQuote).to.have.property("quotedFigure", "27000 per month");

    const manual = buildDamageJevState(head("m", { category: "MORAL", basis: null, sourceQuote: null, label: null }), context);
    expect(manual).to.not.have.property("quote");
    expect(manual.head).to.include({ label: "MORAL", basis: "a fixed amount" });
  });
});

describe("quotedFigureOf", () => {
  it("is the figure the quote supplied: a rate, a stated amount or a percentage", () => {
    expect(quotedFigureOf({ kind: "RATE_X_PERIOD", monthlyRate: 2900, fromDate: "2026-09-27", untilDate: "asOf" }, 87)).to.equal("2900 per month");
    expect(quotedFigureOf(null, 200000)).to.equal("200000");
    expect(quotedFigureOf({ kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL"] }, 4860)).to.equal("10%");
    expect(quotedFigureOf(null, null)).to.equal(null);
  });
});

describe("verifyDamageHeadsWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let replies: Record<string, unknown>;
  let asked: Record<string, string[]>;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    process.env.USE_JEV_DAMAGES = "true";
    replies = {};
    asked = {};
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { head: { label: string } }; questions: object }) => {
      asked[req.state.head.label] = Object.keys(req.questions);
      const reply = replies[req.state.head.label];
      if (reply instanceof Error) throw reply;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    delete process.env.USE_JEV_DAMAGES;
  });

  it("returns nothing and asks nothing when the flag is off", async () => {
    delete process.env.USE_JEV_DAMAGES;
    const out = await verifyDamageHeadsWithJev([head("a")], context);
    expect(out.size).to.equal(0);
    expect(asked).to.deep.equal({});
  });

  it("asks support only for a head with a quote, and keeps the lower confidence", async () => {
    replies = {
      Backwages: { answers: { support: { choice: "SUPPORTED", confidence: 0.9 }, awardability: { score: 3, confidence: 0.6 } } },
      Moral: { answers: { awardability: { score: 0, confidence: 0.8 } } },
    };
    const out = await verifyDamageHeadsWithJev(
      [head("a"), head("m", { category: "MORAL", label: "Moral", sourceQuote: null })],
      context,
    );
    expect(asked.Backwages).to.deep.equal(["support", "awardability"]);
    expect(asked.Moral).to.deep.equal(["awardability"]);
    expect(out.get("a")).to.deep.equal({ support: "SUPPORTED", awardability: 3, confidence: 0.6 });
    expect(out.get("m")).to.deep.equal({ support: null, awardability: 0, confidence: 0.8 });
  });

  it("downgrades a low-confidence CONTRADICTED to UNSUPPORTED", async () => {
    replies = { Backwages: { answers: { support: { choice: "CONTRADICTED", confidence: 0.55 }, awardability: { score: 2, confidence: 0.9 } } } };
    const out = await verifyDamageHeadsWithJev([head("a")], context);
    expect(out.get("a")!.support).to.equal("UNSUPPORTED");
  });

  it("keeps a confident CONTRADICTED", async () => {
    replies = { Backwages: { answers: { support: { choice: "CONTRADICTED", confidence: 0.85 }, awardability: { score: 2, confidence: 0.9 } } } };
    const out = await verifyDamageHeadsWithJev([head("a")], context);
    expect(out.get("a")!.support).to.equal("CONTRADICTED");
  });

  it("leaves a failed head out without failing the others", async () => {
    replies = {
      Backwages: new Error("boom"),
      Moral: { answers: { awardability: { score: 1, confidence: 0.7 } } },
    };
    const out = await verifyDamageHeadsWithJev(
      [head("a"), head("m", { category: "MORAL", label: "Moral", sourceQuote: null })],
      context,
    );
    expect(out.has("a")).to.equal(false);
    expect(out.get("m")!.awardability).to.equal(1);
  });
});
