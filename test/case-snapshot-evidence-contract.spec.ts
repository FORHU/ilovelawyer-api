/** The documents[] and timeline[] fields of CaseSnapshotSvc.get that the Legal Terminal's
 * Evidence & Timeline panel reads — file-type icon (mimeType, name), page/sheet count
 * (pageCount), ingest pill (ragStatus) and each timeline dot's source document (documentId).
 * Locked here so a future `select` or mapping change can't silently drop one. Every repository
 * is monkeypatched (no live Postgres), same idiom as case-snapshot-outlook.spec.ts. */
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
import LawRepo from "../src/repositories/law.repository";
import CaseOutlookRepo from "../src/repositories/case-outlook.repository";
import prisma from "../src/lib/prisma";
import { CASE_TREND_WEEKS } from "../src/constants";

type Patch = [object, string, unknown];
const empty = async () => [];
const none = async () => null;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function documentRow(overrides: Record<string, unknown>) {
  return {
    id: "doc-1",
    name: "Contract.pdf",
    ragStatus: "READY",
    status: "ACTIVE",
    documentType: null,
    category: null,
    mimeType: "application/pdf",
    pageCount: 4,
    extractionMethod: "text",
    language: "en",
    isExhibit: false,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("CaseSnapshotSvc.get — Evidence & Timeline contract", () => {
  let restore: (() => void)[];
  let documents: Record<string, unknown>[];
  let timeline: Record<string, unknown>[];

  function patch(patches: Patch[]) {
    for (const [target, key, value] of patches) {
      const original = (target as any)[key];
      (target as any)[key] = value;
      restore.push(() => ((target as any)[key] = original));
    }
  }

  beforeEach(() => {
    restore = [];
    documents = [];
    timeline = [];
    patch([
      [CaseAccess, "loadAccessibleCase", async () => ({ id: "case-1", lastRefreshedAt: null, parties: [] })],
      [CaseAccess, "requiredConfirmations", empty],
      [DocumentRepo, "listAllByCase", async () => documents],
      [CaseTimelineRepo, "list", async () => timeline],
      [CaseRiskRepo, "list", empty],
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
      [CaseOutlookRepo, "latest", none],
      [CaseOutlookRepo, "history", empty],
    ]);
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("returns every documents[] field the panel reads", async () => {
    const createdAt = new Date("2026-09-01");
    documents = [documentRow({ id: "doc-1", name: "Ledger.xlsx", mimeType: XLSX_MIME, pageCount: 1, ragStatus: "PENDING", createdAt })];

    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");

    expect(snapshot.documents).to.have.length(1);
    expect(snapshot.documents[0]).to.include({
      id: "doc-1",
      name: "Ledger.xlsx",
      ragStatus: "PENDING",
      mimeType: XLSX_MIME,
      pageCount: 1,
      createdAt,
    });
  });

  it("passes FAILED documents through (the panel shows them inline with a red pill)", async () => {
    documents = [documentRow({ id: "doc-1", ragStatus: "FAILED", pageCount: null })];

    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");

    expect(snapshot.documents.map((d) => [d.id, d.ragStatus, d.pageCount])).to.deep.equal([["doc-1", "FAILED", null]]);
  });

  it("returns timeline[] with documentId, occurredOn and title — null documentId included", async () => {
    const occurredOn = new Date("2026-03-15");
    timeline = [
      { id: "t1", caseId: "case-1", title: "Contract signed", occurredOn, documentId: "doc-1", source: "AI" },
      { id: "t2", caseId: "case-1", title: "Call with client", occurredOn: null, documentId: null, source: "AI" },
    ];

    const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");

    expect(snapshot.timeline.map((t) => ({ title: t.title, occurredOn: t.occurredOn, documentId: t.documentId }))).to.deep.equal([
      { title: "Contract signed", occurredOn, documentId: "doc-1" },
      { title: "Call with client", occurredOn: null, documentId: null },
    ]);
  });

  describe("archived documents", () => {
    beforeEach(() => {
      documents = [
        documentRow({ id: "doc-active", ragStatus: "READY", status: "ACTIVE" }),
        documentRow({ id: "doc-archived", ragStatus: "FAILED", status: "ARCHIVED" }),
      ];
    });

    it("are left out of documents[] so they don't inflate the panel's count", async () => {
      const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
      expect(snapshot.documents.map((d) => d.id)).to.deep.equal(["doc-active"]);
    });

    it("are left out of the evidence trend", async () => {
      const snapshot = await CaseSnapshotSvc.get("case-1", "user-1");
      expect(snapshot.trends.evidence[CASE_TREND_WEEKS - 1].total).to.equal(1);
    });
  });
});
