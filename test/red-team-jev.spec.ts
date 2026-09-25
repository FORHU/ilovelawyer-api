import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  impactFromRatings,
  strengthFromLikelihood,
  verifyRedTeamArgumentsWithJev,
  RedTeamJevContext,
} from "../src/utils/red-team-jev";
import type { RedTeamArgument } from "../src/utils/red-team-arguments-parse";

describe("strengthFromLikelihood", () => {
  it("maps the normalized likelihood onto thirds", () => {
    expect(strengthFromLikelihood(1)).to.equal("STRONG");
    expect(strengthFromLikelihood(0.7)).to.equal("STRONG");
    expect(strengthFromLikelihood(0.5)).to.equal("MODERATE");
    expect(strengthFromLikelihood(0.2)).to.equal("WEAK");
  });
});

describe("impactFromRatings", () => {
  it("is +10 for a likely, case-ending argument and -10 for a hopeless one", () => {
    expect(impactFromRatings(1, 1, "SUPPORTED")).to.equal(10);
    expect(impactFromRatings(0, 1, "SUPPORTED")).to.equal(-10);
  });

  it("stays near 0 when the argument barely matters, whichever way it goes", () => {
    expect(impactFromRatings(1, 0, "SUPPORTED")).to.equal(0);
    expect(impactFromRatings(0.5, 1, "SUPPORTED")).to.equal(0);
  });

  it("never rates an unsupported or contradicted argument above 0", () => {
    expect(impactFromRatings(1, 1, "UNSUPPORTED")).to.equal(0);
    expect(impactFromRatings(0, 1, "CONTRADICTED")).to.equal(-10);
  });
});

describe("verifyRedTeamArgumentsWithJev", () => {
  const context: RedTeamJevContext = {
    opponent: "Northbridge",
    legalIssues: [],
    weaknesses: ["No written protest between 4 and 11 August"],
    contradictions: [],
    timeline: [],
    witnesses: [],
    parties: [],
  };
  const arg = (title: string, impact: number): RedTeamArgument => ({
    title,
    gist: null,
    strength: "MODERATE",
    impact,
    reasoning: null,
    source: { kind: "WEAKNESS", label: "No written protest between 4 and 11 August" },
  });

  const original = TypeSafeClient.prototype.systemOne;
  let replies: Record<string, unknown>;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    replies = {};
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { argument: { title: string } } }) => {
      const reply = replies[req.state.argument.title];
      if (reply instanceof Error) throw reply;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });

  const answers = (support: string, supportConf: number, likelihood: number, severity: number, conf = 0.9) => ({
    answers: {
      support: { choice: support, confidence: supportConf },
      likelihood: { score: likelihood, confidence: conf },
      severity: { score: severity, confidence: conf },
    },
  });

  it("replaces the model's rating with Jev's, keeps the original, and re-ranks", async () => {
    replies = { A: answers("SUPPORTED", 0.95, 0.3, 3), B: answers("SUPPORTED", 0.95, 3, 3) };
    const out = await verifyRedTeamArgumentsWithJev(
      { opponent: "Northbridge", riskOfLoss: 25, arguments: [arg("A", 9), arg("B", -4)] },
      context,
    );
    expect(out.arguments.map((a) => a.title)).to.deep.equal(["B", "A"]);
    expect(out.arguments[0]).to.include({ strength: "STRONG", impact: 10, modelStrength: "MODERATE", modelImpact: -4 });
    expect(out.arguments[1].strength).to.equal("WEAK");
    expect(out.arguments[1].impact).to.be.below(0);
  });

  it("downgrades a low-confidence CONTRADICTED to UNSUPPORTED and flags spread Scores as uncertain", async () => {
    replies = { A: answers("CONTRADICTED", 0.55, 2, 2, 0.3) };
    const out = await verifyRedTeamArgumentsWithJev({ opponent: null, riskOfLoss: null, arguments: [arg("A", 5)] }, context);
    expect(out.arguments[0].jev).to.include({ support: "UNSUPPORTED", uncertain: true });
    expect(out.arguments[0].impact).to.be.at.most(0);
  });

  it("keeps the model's rating with jev: null when one call fails", async () => {
    replies = { A: new Error("boom"), B: answers("SUPPORTED", 0.9, 2, 1) };
    const out = await verifyRedTeamArgumentsWithJev(
      { opponent: null, riskOfLoss: null, arguments: [arg("A", 7), arg("B", 1)] },
      context,
    );
    const a = out.arguments.find((x) => x.title === "A")!;
    expect(a.jev).to.equal(null);
    expect(a).to.include({ strength: "MODERATE", impact: 7 });
    expect(a).to.not.have.property("modelStrength");
  });
});
