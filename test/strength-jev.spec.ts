/** Strengths' Jev check (USE_JEV_STRENGTHS): the tag, impact and order rules, the CONTRADICTED and
 * ALREADY_REBUTTED floors, and reading the cited document's passages. No live Jev — the TypeSafe
 * client is monkeypatched, same idiom as contradiction-triage.spec.ts. FindingJevSvc applying it to
 * a batch is in finding-jev-service.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkStrengthWithJev, compareByWeight, impactFromCheck, tagFromCheck } from "../src/utils/strength-jev";

const context = {
  opponent: null,
  legalIssues: [],
  weaknesses: [],
  contradictions: [],
  timeline: [],
  witnesses: [],
  parties: [],
};

describe("tagFromCheck (strengths)", () => {
  const strong = { support: "SUPPORTED" as const, weight: 2 / 3, rebuttal: "REBUTTABLE" as const };

  it("is STRONG for a supported, weighty strength not already rebutted", () => {
    expect(tagFromCheck(strong)).to.equal("STRONG");
  });

  it("is MODERATE when unsupported, light, or already rebutted", () => {
    expect(tagFromCheck({ ...strong, support: "UNSUPPORTED" })).to.equal("MODERATE");
    expect(tagFromCheck({ ...strong, weight: 1 / 3 })).to.equal("MODERATE");
    expect(tagFromCheck({ ...strong, rebuttal: "ALREADY_REBUTTED" })).to.equal("MODERATE");
  });
});

describe("impactFromCheck / compareByWeight (strengths)", () => {
  it("is weight on a 0..10 scale, and 0 when the source doesn't bear it out", () => {
    expect(impactFromCheck({ support: "SUPPORTED", weight: 1 })).to.equal(10);
    expect(impactFromCheck({ support: "CONTRADICTED", weight: 1 })).to.equal(0);
  });

  it("puts the strengths doing the most work first, unsupported ones after", () => {
    const rows = [
      { id: "unborne", support: "UNSUPPORTED" as const, weight: 1 },
      { id: "light", support: "SUPPORTED" as const, weight: 1 / 3 },
      { id: "heavy", support: "SUPPORTED" as const, weight: 1 },
    ];
    expect(rows.sort(compareByWeight).map((r) => r.id)).to.deep.equal(["heavy", "light", "unborne"]);
  });
});

describe("checkStrengthWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  let sent: any;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async (req: unknown) => {
      sent = req;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const answers = (support: string, supportConf: number, rebuttal = "UNREBUTTED", rebuttalConf = 0.9, weight = 3, weightConf = 0.9) => ({
    answers: {
      support: { choice: support, confidence: supportConf },
      weight: { score: weight, confidence: weightConf },
      rebuttal: { choice: rebuttal, confidence: rebuttalConf },
    },
  });
  const strength = {
    label: "Attendance logged through 8 August",
    detail: "NBL-PR-000015",
    sourceLabel: "Payroll register",
    passages: ["[p. 2] Maria Reyes — present 4, 5, 6, 7, 8 Aug"],
  };

  it("checks against the cited document's passages when there are some", async () => {
    reply = answers("SUPPORTED", 0.9);
    const check = await checkStrengthWithJev(strength, context);
    expect(check).to.include({ support: "SUPPORTED", sourceRead: true, weight: 1, rebuttal: "UNREBUTTED" });
    expect(sent.state.sourcePassages).to.deep.equal(strength.passages);
    expect(JSON.stringify(sent.questions.support)).to.contain("sourcePassages");
  });

  it("says when it had no text of the source to read", async () => {
    reply = answers("SUPPORTED", 0.9);
    const check = await checkStrengthWithJev({ ...strength, passages: [] }, context);
    expect(check.sourceRead).to.equal(false);
    expect(JSON.stringify(sent.questions.support)).to.contain("No text of its source document");
  });

  it("downgrades an unsure CONTRADICTED and an unsure ALREADY_REBUTTED", async () => {
    reply = answers("CONTRADICTED", 0.6, "ALREADY_REBUTTED", 0.6);
    const check = await checkStrengthWithJev(strength, context);
    expect(check).to.include({ support: "UNSUPPORTED", rebuttal: "REBUTTABLE" });
    expect(check.flags).to.deep.equal(["NOT_BORNE_OUT"]);
  });

  it("keeps confident CONTRADICTED and ALREADY_REBUTTED, and marks a spread weight as uncertain", async () => {
    reply = answers("CONTRADICTED", 0.8, "ALREADY_REBUTTED", 0.8, 2, 0.4);
    const check = await checkStrengthWithJev(strength, context);
    expect(check).to.include({ support: "CONTRADICTED", rebuttal: "ALREADY_REBUTTED", uncertain: true });
  });
});
