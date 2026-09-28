/** Legal Issues' Jev check (USE_JEV_LEGAL_ISSUES): the tag and flag rules and the NOT_RAISED floor.
 * No live Jev — the TypeSafe client is monkeypatched, same idiom as contradiction-triage.spec.ts.
 * FindingJevSvc applying it to a batch is in finding-jev-service.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkLegalIssueWithJev, flagsFor, tagFromCheck } from "../src/utils/legal-issue-jev";

const context = {
  opponent: null,
  legalIssues: [],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-08-11 — Termination effective"],
  witnesses: [],
  parties: ["Maria Reyes (Complainant)", "Northbridge Logistics (Respondent)"],
  claims: ["Illegal dismissal"],
};

const answers = (
  raised: [string, number],
  contested: [string, number] = ["CONTESTED", 0.9],
  burden: [string, number] = ["RESPONDENT", 0.9],
) => ({
  answers: {
    raised: { choice: raised[0], confidence: raised[1] },
    contested: { choice: contested[0], confidence: contested[1] },
    burden: { choice: burden[0], confidence: burden[1] },
  },
});

describe("tagFromCheck", () => {
  it("is CONTESTED only when Jev says so", () => {
    expect(tagFromCheck({ contested: "CONTESTED" })).to.equal("CONTESTED");
    expect(tagFromCheck({ contested: "UNCONTESTED" })).to.equal("OPEN");
    expect(tagFromCheck({ contested: "UNCLEAR" })).to.equal("OPEN");
  });
});

describe("flagsFor", () => {
  const base = { raised: "RAISED" as const, burden: "RESPONDENT" as const, burdenConfidence: 0.9, modelBurden: "RESPONDENT" as const };

  it("flags a NOT_RAISED issue", () => {
    expect(flagsFor({ ...base, raised: "NOT_RAISED" })).to.deep.equal(["NOT_RAISED"]);
  });

  it("flags a confident burden that disagrees with the model's", () => {
    expect(flagsFor({ ...base, burden: "CLAIMANT" })).to.deep.equal(["BURDEN_DISPUTED"]);
  });

  it("doesn't flag an unsure, unclear or uncompared burden", () => {
    expect(flagsFor({ ...base, burden: "CLAIMANT", burdenConfidence: 0.6 })).to.deep.equal([]);
    expect(flagsFor({ ...base, burden: "UNCLEAR" })).to.deep.equal([]);
    expect(flagsFor({ ...base, burden: "CLAIMANT", modelBurden: null })).to.deep.equal([]);
  });
});

describe("checkLegalIssueWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  let sentState: any;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: unknown }) => {
      sentState = req.state;
      return reply;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const issue = { label: "Was the abandonment claim substantiated?", detail: null, sourceLabel: null, modelBurden: "RESPONDENT" as const };

  it("reports an unsure NOT_RAISED as RAISED", async () => {
    reply = answers(["NOT_RAISED", 0.69]);
    const check = await checkLegalIssueWithJev(issue, context);
    expect(check.raised).to.equal("RAISED");
    expect(check.flags).to.deep.equal([]);
  });

  it("keeps a confident NOT_RAISED and flags it", async () => {
    reply = answers(["NOT_RAISED", 0.8]);
    const check = await checkLegalIssueWithJev(issue, context);
    expect(check.raised).to.equal("NOT_RAISED");
    expect(check.flags).to.include("NOT_RAISED");
  });

  it("falls back on answers outside the choices and marks low confidence as uncertain", async () => {
    reply = answers(["RAISED", 0.9], ["MAYBE", 0.4], ["NOBODY", 0.9]);
    const check = await checkLegalIssueWithJev(issue, context);
    expect(check.contested).to.equal("UNCLEAR");
    expect(check.burden).to.equal("UNCLEAR");
    expect(check.uncertain).to.equal(true);
  });

  it("sends the case's claims with the case data", async () => {
    reply = answers(["RAISED", 0.9]);
    await checkLegalIssueWithJev(issue, context);
    expect(sentState.caseData.claims).to.deep.equal(["Illegal dismissal"]);
  });
});
