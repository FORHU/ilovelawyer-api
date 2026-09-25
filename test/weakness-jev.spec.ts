/** Weaknesses' Jev check (USE_JEV_WEAKNESSES): the tag, impact and order rules and the
 * CONTRADICTED floor. No live Jev — the TypeSafe client is monkeypatched, same idiom as
 * contradiction-triage.spec.ts. FindingJevSvc applying it to a batch is in finding-jev-service.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkWeaknessWithJev, compareBySurfacing, impactFromCheck, tagFromCheck } from "../src/utils/weakness-jev";

const context = {
  opponent: null,
  legalIssues: ["Was the abandonment claim substantiated?"],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-08-04 — Abandonment alleged to begin"],
  witnesses: [],
  parties: [],
};

describe("tagFromCheck (weaknesses)", () => {
  it("is MATERIAL only for a supported weakness at two-thirds severity or more", () => {
    expect(tagFromCheck({ support: "SUPPORTED", severity: 2 / 3 })).to.equal("MATERIAL");
    expect(tagFromCheck({ support: "SUPPORTED", severity: 1 / 3 })).to.equal("MINOR");
    expect(tagFromCheck({ support: "UNSUPPORTED", severity: 1 })).to.equal("MINOR");
  });
});

describe("impactFromCheck", () => {
  it("is severity on a 0..10 scale, and 0 when the case data doesn't bear it out", () => {
    expect(impactFromCheck({ support: "SUPPORTED", severity: 1 })).to.equal(10);
    expect(impactFromCheck({ support: "SUPPORTED", severity: 1 / 3 })).to.equal(3);
    expect(impactFromCheck({ support: "CONTRADICTED", severity: 1 })).to.equal(0);
  });
});

describe("compareBySurfacing", () => {
  it("puts the soonest to surface first, then the most severe", () => {
    const rows = [
      { id: "late", surfacing: 0, severity: 1 },
      { id: "soon-mild", surfacing: 1, severity: 1 / 3 },
      { id: "soon-severe", surfacing: 1, severity: 1 },
    ];
    expect(rows.sort(compareBySurfacing).map((r) => r.id)).to.deep.equal(["soon-severe", "soon-mild", "late"]);
  });
});

describe("checkWeaknessWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async () => reply;
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const answers = (support: string, supportConf: number, severity = 3, surfacing = 2, curable = "BY_EVIDENCE", conf = 0.9) => ({
    answers: {
      support: { choice: support, confidence: supportConf },
      severity: { score: severity, confidence: conf },
      surfacing: { score: surfacing, confidence: conf },
      curable: { choice: curable, confidence: 0.8 },
    },
  });
  const weakness = { label: "No written protest between 4 and 11 August", detail: null, sourceLabel: null };

  it("normalizes the Scores and keeps a supported weakness unflagged", async () => {
    reply = answers("SUPPORTED", 0.9, 3, 2);
    const check = await checkWeaknessWithJev(weakness, context);
    expect(check).to.include({ support: "SUPPORTED", severity: 1, uncertain: false });
    expect(check.surfacing).to.be.closeTo(2 / 3, 1e-9);
    expect(check.flags).to.deep.equal([]);
  });

  it("downgrades an unsure CONTRADICTED to UNSUPPORTED and flags it either way", async () => {
    reply = answers("CONTRADICTED", 0.6);
    const unsure = await checkWeaknessWithJev(weakness, context);
    expect(unsure.support).to.equal("UNSUPPORTED");
    expect(unsure.flags).to.deep.equal(["NOT_BORNE_OUT"]);

    reply = answers("CONTRADICTED", 0.8);
    expect((await checkWeaknessWithJev(weakness, context)).support).to.equal("CONTRADICTED");
  });

  it("marks spread Scores as uncertain and falls back on unknown choices", async () => {
    reply = answers("SUPPORTED", 0.9, 1, 1, "SOMEHOW", 0.4);
    const check = await checkWeaknessWithJev(weakness, context);
    expect(check.uncertain).to.equal(true);
    expect(check.curable).to.equal("BY_EVIDENCE");
  });
});
