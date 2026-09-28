/** Attack Strategies' Jev check (USE_JEV_ATTACK_STRATEGY): the readiness verdict. No live Jev —
 * the TypeSafe client is monkeypatched, same idiom as weakness-jev.spec.ts. FindingJevSvc applying
 * it to a batch is in finding-jev-service.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkAttackStrategyWithJev, tagFromCheck } from "../src/utils/attack-strategy-jev";

const context = {
  opponent: null,
  legalIssues: ["Was the abandonment claim substantiated?"],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-08-04 — Abandonment alleged to begin"],
  witnesses: [],
  parties: [],
};

describe("tagFromCheck (attack strategy)", () => {
  it("passes the readiness verdict straight through", () => {
    expect(tagFromCheck({ readiness: "READY" })).to.equal("READY");
    expect(tagFromCheck({ readiness: "DRAFTING" })).to.equal("DRAFTING");
    expect(tagFromCheck({ readiness: "BLOCKED" })).to.equal("BLOCKED");
  });
});

describe("checkAttackStrategyWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async () => reply;
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const answers = (readiness: string, confidence: number) => ({
    answers: { readiness: { choice: readiness, confidence } },
  });
  const move = { label: "File a motion to compel", detail: "Interrogatories were never answered", sourceLabel: null };

  it("reads a confident verdict straight through", async () => {
    reply = answers("READY", 0.9);
    const check = await checkAttackStrategyWithJev(move, context);
    expect(check).to.deep.equal({ readiness: "READY", readinessConfidence: 0.9, uncertain: false });
  });

  it("marks a low-confidence verdict as uncertain", async () => {
    reply = answers("BLOCKED", 0.4);
    const check = await checkAttackStrategyWithJev(move, context);
    expect(check.uncertain).to.equal(true);
  });

  it("falls back to DRAFTING on an unknown choice", async () => {
    reply = answers("SOMEHOW", 0.9);
    const check = await checkAttackStrategyWithJev(move, context);
    expect(check.readiness).to.equal("DRAFTING");
  });
});
