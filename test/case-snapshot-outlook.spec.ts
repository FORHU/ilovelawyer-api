/** The outlook-related parts of CaseSnapshotSvc.get's response shape, with every repository
 * monkeypatched (no live Postgres). */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseSnapshotSvc from "../src/services/case-snapshot.service";
import CaseAccess from "../src/utils/case-access";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import CaseRiskRepo from "../src/repositories/case-risk.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import CitationCheckRepo from "../src/repositories/citation-check.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import WitnessRepo from "../src/repositories/witness.repository";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import CaseReconstructionRepo from "../src/repositories/case-reconstruction.repository";
import RedTeamRepo from "../src/repositories/red-team.repository";
import DecisionRecordRepo from "../src/repositories/decision-record.repository";
import CaseTheoryRepo from "../src/repositories/case-theory.repository";
import AnnotationRepo from "../src/repositories/annotation.repository";
import CaseGraphRepo from "../src/repositories/case-graph.repository";
import ChatRepo from "../src/repositories/chat.repository";
import MindMapRepo from "../src/repositories/mind-map.repository";
import { fingerprintReadyDocuments } from "../src/utils/ready-set-fingerprint";
import LawRepo from "../src/repositories/law.repository";
import CaseOutlookRepo from "../src/repositories/case-outlook.repository";
import prisma from "../src/lib/prisma";
import { CASE_TREND_WEEKS, OUTLOOK_DISCLAIMER, OUTLOOK_HISTORY_LIMIT } from "../src/constants";

type Patch = [object, string, unknown];
const empty = async () => [];
const none = async () => null;

describe("CaseSnapshotSvc.get — outlook fields", () => {
  let restore: (() => void)[];
  let latest: unknown;
  let historyLimit: number | undefined;

  function patch(patches: Patch[]) {
    for (const [target, key, value] of patches) {
      const original = (target as any)[key];
      (target as any)[key] = value;
      restore.push(() => ((target as any)[key] = original));
    }
  }

  beforeEach(() => {
    restore = [];
    latest = null;
    historyLimit = undefined;
    patch([
      [CaseAccess, "loadAccessibleCase", async () => ({
        id: "case-1",
        lastRefreshedAt: null,
        parties: [{ id: "p1", name: "Acme", designation: "Petitioner / Plaintiff", descriptor: "Rep. by Hollis & Marr" }],
      })],
      [CaseAccess, "requiredConfirmations", empty],
      [DocumentRepo, "listAllByCase", async () => [{ id: "doc-1", name: "Contract", ragStatus: "READY", createdAt: new Date() }]],
      [CaseTimelineRepo, "list", empty],
      [CaseRiskRepo, "list", async () => [{ id: "r1", title: "Late notice", severity: "MAJOR", status: "OPEN", confidence: "MEDIUM", createdAt: new Date() }]],
      [prisma.event, "findMany", empty],
      [EvidenceRepo, "listMatrix", empty],
      [EvidenceRepo, "listContradictions", empty],
      [CitationCheckRepo, "list", empty],
      [ProceduralDeadlineRepo, "list", empty],
      [ProceduralDeadlineRepo, "listProcedureItems", empty],
      [OrganizationRepo, "listCaseAccess", empty],
      [OrganizationRepo, "listAudit", empty],
      [CaseFindingRepo, "list", empty],
      [WitnessRepo, "list", empty],
      [DamageClaimRepo, "list", empty],
      [CaseReconstructionRepo, "get", none],
      [RedTeamRepo, "get", none],
      [DecisionRecordRepo, "list", empty],
      [CaseTheoryRepo, "list", empty],
      [AnnotationRepo, "list", empty],
      [CaseGraphRepo, "listStaleForCase", empty],
      [ChatRepo, "findLatestMindMapCreatedAtForCase", none],
      [MindMapRepo, "findCaseMapMeta", none],
      [ChatRepo, "findManyByIds", empty],
      [LawRepo, "findManyByIds", empty],
      [CaseOutlookRepo, "latest", async () => latest],
      [CaseOutlookRepo, "history", async (_caseId: string, limit: number) => {
        historyLimit = limit;
        return [{ id: "o1", band: "UNCERTAIN", confidence: "LOW", createdAt: new Date("2026-09-20") }];
      }],
    ]);
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("returns outlook: null when the case has never had one", async () => {
    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
    expect(snapshot.outlook).to.equal(null);
  });

  it("returns the latest outlook as band + confidence with the disclaimer, and no numeric field", async () => {
    latest = {
      id: "o2",
      caseId: "case-1",
      band: "LEANS_FAVORABLE",
      confidence: "MEDIUM",
      rationale: "Paper trail is strong.",
      drivers: [{ label: "Signed", direction: "HELPS", sourceDocId: "doc-1" }],
      createdAt: new Date("2026-09-24"),
    };
    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
    expect(snapshot.outlook).to.deep.equal({
      id: "o2",
      band: "LEANS_FAVORABLE",
      confidence: "MEDIUM",
      rationale: "Paper trail is strong.",
      drivers: [{ label: "Signed", direction: "HELPS", sourceDocId: "doc-1" }],
      createdAt: new Date("2026-09-24"),
      disclaimer: OUTLOOK_DISCLAIMER,
    });
    const numeric = Object.entries(snapshot.outlook!).filter(([, value]) => typeof value === "number");
    expect(numeric).to.deep.equal([]);
  });

  it("returns outlookHistory from the repository, capped at the history limit", async () => {
    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
    expect(historyLimit).to.equal(OUTLOOK_HISTORY_LIMIT);
    expect(snapshot.outlookHistory).to.have.length(1);
    expect(snapshot.outlookHistory[0]).to.have.all.keys("id", "band", "confidence", "createdAt");
  });

  it("passes risks[].confidence and case.parties[].descriptor through", async () => {
    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
    expect(snapshot.risks[0]).to.include({ confidence: "MEDIUM" });
    expect((snapshot.case.parties[0] as any).descriptor).to.equal("Rep. by Hollis & Marr");
  });

  it("returns weekly trends for open issues and evidence", async () => {
    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
    expect(snapshot.trends.openIssues).to.have.length(CASE_TREND_WEEKS);
    expect(snapshot.trends.evidence).to.have.length(CASE_TREND_WEEKS);
    expect(snapshot.trends.openIssues[CASE_TREND_WEEKS - 1].total).to.equal(1);
    expect(snapshot.trends.evidence[CASE_TREND_WEEKS - 1].total).to.equal(1);
  });

  it("reports the case mind map, stale only when the READY documents changed since its build", async () => {
    expect((await CaseSnapshotSvc.get("case-1", "user-1")).caseMindMap).to.equal(null);

    const meta = { id: "cmm1", version: 3, generatedAt: new Date("2026-09-24"), documentCount: 1 };
    const original = MindMapRepo.findCaseMapMeta;
    try {
      MindMapRepo.findCaseMapMeta = (async () => ({
        ...meta,
        readySetFingerprint: fingerprintReadyDocuments([{ id: "doc-1", ragStatus: "READY" }]),
      })) as any;
      expect((await CaseSnapshotSvc.get("case-1", "user-1")).caseMindMap).to.deep.include({ version: 3, documentCount: 1, isStale: false });

      MindMapRepo.findCaseMapMeta = (async () => ({ ...meta, readySetFingerprint: "built-from-other-documents" })) as any;
      expect((await CaseSnapshotSvc.get("case-1", "user-1")).caseMindMap?.isStale).to.equal(true);
    } finally {
      MindMapRepo.findCaseMapMeta = original;
    }
  });
});
