/** Legal Issues' Jev check (USE_JEV_LEGAL_ISSUES): the tag and flag rules, the NOT_RAISED floor,
 * and FindingJevSvc.verifyParsed applying it to a generated batch. No live Postgres or Jev — repos,
 * prisma.party and the TypeSafe client are monkeypatched, same idiom as contradiction-triage.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import prisma from "../src/lib/prisma";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseClaimRepo from "../src/repositories/case-claim.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import WitnessRepo from "../src/repositories/witness.repository";
import FindingJevSvc from "../src/services/finding-jev.service";
import { checkLegalIssueWithJev, flagsFor, tagFromCheck } from "../src/utils/legal-issue-jev";
import type { ParsedCaseFinding } from "../src/utils/case-finding-parse";

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

describe("FindingJevSvc.verifyParsed", () => {
  const originals = {
    systemOne: TypeSafeClient.prototype.systemOne,
    partyFindMany: prisma.party.findMany,
    findingList: CaseFindingRepo.list,
    claimList: CaseClaimRepo.list,
    timelineList: CaseTimelineRepo.list,
    contradictions: EvidenceRepo.listContradictions,
    witnessList: WitnessRepo.list,
    flag: process.env.USE_JEV_LEGAL_ISSUES,
  };
  let replies: Record<string, unknown>;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    replies = {};
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { issue: { question: string } } }) => {
      const reply = replies[req.state.issue.question];
      if (reply instanceof Error) throw reply;
      return reply;
    };
    (prisma.party as any).findMany = async () => [];
    (CaseFindingRepo as any).list = async () => [];
    (CaseClaimRepo as any).list = async () => [];
    (CaseTimelineRepo as any).list = async () => [];
    (EvidenceRepo as any).listContradictions = async () => [];
    (WitnessRepo as any).list = async () => [];
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originals.systemOne;
    (prisma.party as any).findMany = originals.partyFindMany;
    (CaseFindingRepo as any).list = originals.findingList;
    (CaseClaimRepo as any).list = originals.claimList;
    (CaseTimelineRepo as any).list = originals.timelineList;
    (EvidenceRepo as any).listContradictions = originals.contradictions;
    (WitnessRepo as any).list = originals.witnessList;
    if (originals.flag === undefined) delete process.env.USE_JEV_LEGAL_ISSUES;
    else process.env.USE_JEV_LEGAL_ISSUES = originals.flag;
  });

  const parsed = (label: string, category: ParsedCaseFinding["category"] = "LEGAL_ISSUE"): ParsedCaseFinding => ({
    category,
    label,
    sourceLabel: null,
    detail: "Employer bears the burden on just cause",
    tag: category === "LEGAL_ISSUE" ? "OPEN" : null,
    burden: category === "LEGAL_ISSUE" ? "RESPONDENT" : null,
  });

  it("with the flag off, keeps the model's tags and numbers positions per category", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "false";
    const rows = await FindingJevSvc.verifyParsed("case-1", [parsed("A"), parsed("W", "WEAKNESS"), parsed("B")]);
    expect(rows.map((r) => [r.label, r.position, r.tag])).to.deep.equal([
      ["A", 0, "OPEN"],
      ["W", 0, null],
      ["B", 1, "OPEN"],
    ]);
    expect(rows.every((r) => r.jev === undefined)).to.equal(true);
  });

  it("with the flag on, replaces the model's tag with Jev's and keeps the model's as modelTag", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "true";
    replies.A = answers(["RAISED", 0.9], ["CONTESTED", 0.9]);
    const [row] = await FindingJevSvc.verifyParsed("case-1", [parsed("A")]);
    expect(row).to.include({ tag: "CONTESTED", modelTag: "OPEN" });
    expect((row.jev as any).modelBurden).to.equal("RESPONDENT");
    expect(row.jevCheckedAt).to.be.instanceOf(Date);
  });

  it("leaves a row on the model's rating when its Jev call fails, and only checks legal issues", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "true";
    replies.A = new Error("Jev down");
    const rows = await FindingJevSvc.verifyParsed("case-1", [parsed("A"), parsed("W", "WEAKNESS")]);
    expect(rows[0]).to.include({ tag: "OPEN" });
    expect(rows[0].jev).to.equal(undefined);
    expect(rows[1].jev).to.equal(undefined);
  });
});
