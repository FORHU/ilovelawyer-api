/** Defense Strategies' Jev check (USE_JEV_DEFENSE_STRATEGY): the answer-completeness verdict. No
 * live Jev — the TypeSafe client is monkeypatched, same idiom as weakness-jev.spec.ts.
 * FindingJevSvc applying it to a batch is in finding-jev-service.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkDefenseStrategyWithJev, tagFromCheck } from "../src/utils/defense-strategy-jev";

const context = {
  opponent: null,
  legalIssues: ["Was the abandonment claim substantiated?"],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-08-04 — Abandonment alleged to begin"],
  witnesses: [],
  parties: [],
};

describe("tagFromCheck (defense strategy)", () => {
  it("passes the defense-status verdict straight through", () => {
    expect(tagFromCheck({ defenseStatus: "ANSWERED" })).to.equal("ANSWERED");
    expect(tagFromCheck({ defenseStatus: "PARTIAL" })).to.equal("PARTIAL");
    expect(tagFromCheck({ defenseStatus: "UNANSWERED" })).to.equal("UNANSWERED");
  });
});

describe("checkDefenseStrategyWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async () => reply;
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const answers = (defenseStatus: string, confidence: number) => ({
    answers: { defenseStatus: { choice: defenseStatus, confidence } },
  });
  const defense = {
    label: "Statute of limitations",
    detail: "Filed within the 4-year period per the complaint's own dates",
    sourceLabel: null,
  };

  it("reads a confident verdict straight through", async () => {
    reply = answers("ANSWERED", 0.9);
    const check = await checkDefenseStrategyWithJev(defense, context);
    expect(check).to.deep.equal({ defenseStatus: "ANSWERED", defenseStatusConfidence: 0.9, uncertain: false });
  });

  it("marks a low-confidence verdict as uncertain", async () => {
    reply = answers("PARTIAL", 0.4);
    const check = await checkDefenseStrategyWithJev(defense, context);
    expect(check.uncertain).to.equal(true);
  });

  it("falls back to UNANSWERED on an unknown choice", async () => {
    reply = answers("SOMEHOW", 0.9);
    const check = await checkDefenseStrategyWithJev(defense, context);
    expect(check.defenseStatus).to.equal("UNANSWERED");
  });
});
