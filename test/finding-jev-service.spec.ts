/** FindingJevSvc.verifyParsed: applying the per-category Jev checks to a generated batch before it's
 * saved. No live Postgres or Jev — repos, prisma.party and the TypeSafe client are monkeypatched,
 * same idiom as contradiction-triage.spec.ts. Each fake Jev reply is keyed by the row's label. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import prisma from "../src/lib/prisma";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseClaimRepo from "../src/repositories/case-claim.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import WitnessRepo from "../src/repositories/witness.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import * as embedding from "../src/utils/embedding";
import FindingJevSvc from "../src/services/finding-jev.service";
import type { ParsedCaseFinding } from "../src/utils/case-finding-parse";

const issueAnswers = (contested = "CONTESTED") => ({
  answers: {
    raised: { choice: "RAISED", confidence: 0.9 },
    contested: { choice: contested, confidence: 0.9 },
    burden: { choice: "RESPONDENT", confidence: 0.9 },
  },
});

const weaknessAnswers = (severity: number, surfacing: number, support = "SUPPORTED") => ({
  answers: {
    support: { choice: support, confidence: 0.9 },
    severity: { score: severity, confidence: 0.9 },
    surfacing: { score: surfacing, confidence: 0.9 },
    curable: { choice: "BY_EVIDENCE", confidence: 0.9 },
  },
});

const strengthAnswers = (weight: number, support = "SUPPORTED") => ({
  answers: {
    support: { choice: support, confidence: 0.9 },
    weight: { score: weight, confidence: 0.9 },
    rebuttal: { choice: "UNREBUTTED", confidence: 0.9 },
  },
});

const parsed = (label: string, category: ParsedCaseFinding["category"] = "LEGAL_ISSUE"): ParsedCaseFinding => ({
  category,
  label,
  sourceLabel: null,
  detail: null,
  tag: category === "LEGAL_ISSUE" ? "OPEN" : category === "WEAKNESS" ? "MINOR" : category === "STRENGTH" ? "MODERATE" : null,
  burden: category === "LEGAL_ISSUE" ? "RESPONDENT" : null,
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
    documentList: DocumentRepo.listAllByCase,
    relevantChunks: DocumentChunkRepo.findRelevantByDocument,
    chunkTexts: DocumentChunkRepo.findTextsByIds,
    embedText: embedding.embedText,
    issuesFlag: process.env.USE_JEV_LEGAL_ISSUES,
    weaknessesFlag: process.env.USE_JEV_WEAKNESSES,
    strengthsFlag: process.env.USE_JEV_STRENGTHS,
  };
  let replies: Record<string, unknown>;
  let sent: Record<string, any>;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    process.env.USE_JEV_LEGAL_ISSUES = "false";
    process.env.USE_JEV_WEAKNESSES = "false";
    process.env.USE_JEV_STRENGTHS = "false";
    replies = {};
    sent = {};
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: any }) => {
      const label = req.state.issue?.question ?? req.state.weakness?.point ?? req.state.strength?.point;
      sent[label] = req.state;
      const reply = replies[label];
      if (reply instanceof Error) throw reply;
      return reply;
    };
    (prisma.party as any).findMany = async () => [];
    (CaseFindingRepo as any).list = async () => [];
    (CaseClaimRepo as any).list = async () => [];
    (CaseTimelineRepo as any).list = async () => [];
    (EvidenceRepo as any).listContradictions = async () => [];
    (WitnessRepo as any).list = async () => [];
    (DocumentRepo as any).listAllByCase = async () => [
      { id: "doc-payroll", name: "Payroll register", ragStatus: "READY" },
      { id: "doc-draft", name: "Unindexed draft", ragStatus: "PENDING" },
    ];
    (DocumentChunkRepo as any).findRelevantByDocument = async (documentId: string) => (documentId === "doc-payroll" ? ["c1"] : []);
    (DocumentChunkRepo as any).findTextsByIds = async (ids: string[]) =>
      ids.map((id) => ({ id, caseDocumentId: "doc-payroll", chunkText: "Present 4–8 August", chunkIndex: 0, pageNumber: 2 }));
    (embedding as any).embedText = async () => [0.1, 0.2];
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originals.systemOne;
    (prisma.party as any).findMany = originals.partyFindMany;
    (CaseFindingRepo as any).list = originals.findingList;
    (CaseClaimRepo as any).list = originals.claimList;
    (CaseTimelineRepo as any).list = originals.timelineList;
    (EvidenceRepo as any).listContradictions = originals.contradictions;
    (WitnessRepo as any).list = originals.witnessList;
    (DocumentRepo as any).listAllByCase = originals.documentList;
    (DocumentChunkRepo as any).findRelevantByDocument = originals.relevantChunks;
    (DocumentChunkRepo as any).findTextsByIds = originals.chunkTexts;
    (embedding as any).embedText = originals.embedText;
    for (const [name, value] of [
      ["USE_JEV_LEGAL_ISSUES", originals.issuesFlag],
      ["USE_JEV_WEAKNESSES", originals.weaknessesFlag],
      ["USE_JEV_STRENGTHS", originals.strengthsFlag],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("with the flags off, keeps the model's tags and numbers positions per category", async () => {
    const rows = await FindingJevSvc.verifyParsed("case-1", [parsed("A"), parsed("W", "WEAKNESS"), parsed("B")]);
    expect(rows.map((r) => [r.label, r.position, r.tag])).to.deep.equal([
      ["A", 0, "OPEN"],
      ["W", 0, "MINOR"],
      ["B", 1, "OPEN"],
    ]);
    expect(rows.every((r) => r.jev === undefined)).to.equal(true);
  });

  it("replaces a legal issue's tag with Jev's and keeps the model's as modelTag", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "true";
    replies.A = issueAnswers("CONTESTED");
    const [row] = await FindingJevSvc.verifyParsed("case-1", [parsed("A")]);
    expect(row).to.include({ tag: "CONTESTED", modelTag: "OPEN" });
    expect((row.jev as any).modelBurden).to.equal("RESPONDENT");
    expect(row.jevCheckedAt).to.be.instanceOf(Date);
  });

  it("doesn't count the row being judged as its own evidence", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "true";
    replies.A = issueAnswers();
    replies.B = issueAnswers();
    await FindingJevSvc.verifyParsed("case-1", [parsed("A"), parsed("B")]);
    expect(sent.A.caseData.legalIssues).to.deep.equal(["B"]);
    expect(sent.B.caseData.legalIssues).to.deep.equal(["A"]);
  });

  it("leaves a row on the model's rating when its Jev call fails, and skips categories whose flag is off", async () => {
    process.env.USE_JEV_LEGAL_ISSUES = "true";
    replies.A = new Error("Jev down");
    const rows = await FindingJevSvc.verifyParsed("case-1", [parsed("A"), parsed("W", "WEAKNESS")]);
    expect(rows[0]).to.include({ tag: "OPEN" });
    expect(rows[0].jev).to.equal(undefined);
    expect(rows[1].jev).to.equal(undefined);
  });

  it("rates weaknesses, sets impact, and orders them soonest-to-surface first with unchecked ones last", async () => {
    process.env.USE_JEV_WEAKNESSES = "true";
    replies.late = weaknessAnswers(3, 0);
    replies.soon = weaknessAnswers(2, 3);
    replies.unborne = weaknessAnswers(3, 2, "UNSUPPORTED");
    replies.failed = new Error("Jev down");
    const rows = await FindingJevSvc.verifyParsed("case-1", [
      parsed("failed", "WEAKNESS"),
      parsed("late", "WEAKNESS"),
      parsed("soon", "WEAKNESS"),
      parsed("unborne", "WEAKNESS"),
    ]);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(rows.sort((a, b) => a.position! - b.position!).map((r) => r.label)).to.deep.equal(["soon", "unborne", "late", "failed"]);
    expect(byLabel.late).to.include({ tag: "MATERIAL", impact: 10, modelTag: "MINOR" });
    expect(byLabel.soon).to.include({ tag: "MATERIAL", impact: 7 });
    expect(byLabel.unborne).to.include({ tag: "MINOR", impact: 0 });
    expect(byLabel.failed).to.include({ tag: "MINOR" });
    expect(byLabel.failed.impact).to.equal(undefined);
  });

  it("reads the cited document's passages for strengths and orders them by the work they do", async () => {
    process.env.USE_JEV_STRENGTHS = "true";
    replies.light = strengthAnswers(1);
    replies.heavy = strengthAnswers(3);
    replies.unindexed = strengthAnswers(3);
    const rows = await FindingJevSvc.verifyParsed("case-1", [
      { ...parsed("light", "STRENGTH"), sourceLabel: "Payroll register" },
      { ...parsed("heavy", "STRENGTH"), sourceLabel: "Payroll register" },
      { ...parsed("unindexed", "STRENGTH"), sourceLabel: "Unindexed draft" },
    ]);
    expect(sent.heavy.sourcePassages).to.deep.equal(["[p. 2] Present 4–8 August"]);
    expect(sent.unindexed.sourcePassages).to.deep.equal([]);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel.heavy).to.include({ tag: "STRONG", impact: 10, modelTag: "MODERATE" });
    expect((byLabel.heavy.jev as any).sourceRead).to.equal(true);
    expect((byLabel.unindexed.jev as any).sourceRead).to.equal(false);
    expect(rows.sort((a, b) => a.position! - b.position!).map((r) => r.label)).to.deep.equal(["heavy", "unindexed", "light"]);
  });
});
