/** CaseRefreshSvc.runQueued's audit row must distinguish a lawyer's manual "Refresh analysis"
 * click from the automatic post-extraction trigger (issue #74: "audit as case.refresh with
 * payload.reason: post-extraction") — both paths converge on the same pipeline, but the audit
 * trail needs to say which one caused a given run.
 *
 * No live Postgres/Chat Wonder: every sub-service CaseRefreshSvc.refreshInner calls is
 * monkeypatched on its CommonJS module object, same idiom as the rest of this suite.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseRefreshSvc from "../src/services/case-refresh.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import CaseStrategySvc from "../src/services/case-strategy.service";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";
import CaseOutlookAiSvc from "../src/services/case-outlook-ai.service";
import ChatRepo from "../src/repositories/chat.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseSnapshotSvc from "../src/services/case-snapshot.service";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import DamagesExtractSvc from "../src/services/damages-extract.service";
import RedTeamSvc from "../src/services/red-team.service";
import AudioOverviewSvc from "../src/services/audio-overview.service";
import WitnessExtractSvc from "../src/services/witness-extract.service";
import WitnessScoringSvc from "../src/services/witness-scoring.service";
import CaseTheorySvc from "../src/services/case-theory.service";
import CaseReconstructionSvc from "../src/services/case-reconstruction.service";
import HttpError from "../src/utils/http-error";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseReconstructionRepo from "../src/repositories/case-reconstruction.repository";
import CaseOutlookRepo from "../src/repositories/case-outlook.repository";
import RedTeamRepo from "../src/repositories/red-team.repository";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import CaseChangeReads from "../src/services/case-change-reads";

describe("CaseRefreshSvc.runQueued — audit reason", () => {
  const originals = {
    exists: CaseRepo.exists,
    listAllByCase: DocumentRepo.listAllByCase,
    scanContradictions: EvidenceIntelligenceSvc.scanContradictions,
    generateStrategy: CaseStrategySvc.generateFromDocuments,
    generateFindings: CaseFindingAiSvc.generateFromDocuments,
    generateOutlook: CaseOutlookAiSvc.generateFromDocuments,
    listConsultationIdsByCase: ChatRepo.listConsultationIdsByCase,
    markRefreshed: CaseRepo.markRefreshed,
    writeAudit: OrganizationRepo.writeAudit,
    lockFinishWith: AiGenerationLockSvc.finishWith,
    snapshotGet: CaseSnapshotSvc.get,
    mapGenerate: CaseMindMapSvc.generateFromDocuments,
    damagesRefresh: DamagesExtractSvc.refreshStep,
    damagesExtractAll: DamagesExtractSvc.extractAllPending,
    outlookGenerate: CaseOutlookAiSvc.generateFromDocuments,
    redTeamGenerate: RedTeamSvc.generateFromDocuments,
    audioOverviewGenerate: AudioOverviewSvc.generateForCase,
    witnessExtractAll: WitnessExtractSvc.extractAllPending,
    witnessScore: WitnessScoringSvc.scoreFromDocuments,
    theoryRefresh: CaseTheorySvc.refreshAiDraft,
    reconstructionAuto: CaseReconstructionSvc.autoRegenerate,
    findingsList: CaseFindingRepo.list,
    reconstructionGet: CaseReconstructionRepo.get,
    outlookLatest: CaseOutlookRepo.latest,
    redTeamGet: RedTeamRepo.get,
    summaryLatest: CaseChangeSummaryRepo.latestRefresh,
    summaryCreate: CaseChangeSummaryRepo.create,
    lastRefreshedAt: CaseRepo.getLastRefreshedAt,
    reads: { ...CaseChangeReads },
  };
  let steps: string[];
  let mapReasons: (string | undefined)[];

  let audits: any[];

  beforeEach(() => {
    audits = [];
    (CaseRepo as any).exists = async () => true;
    (DocumentRepo as any).listAllByCase = async () => [];
    (EvidenceIntelligenceSvc as any).scanContradictions = async () => ({ rows: [], delta: { status: "unchanged", addedCount: 0, droppedCount: 0 } });
    (CaseStrategySvc as any).generateFromDocuments = async () => ({});
    (CaseFindingAiSvc as any).generateFromDocuments = async () => ({});
    steps = [];
    (CaseOutlookAiSvc as any).generateFromDocuments = async () => {
      steps.push("outlook");
      return null;
    };
    (DamagesExtractSvc as any).refreshStep = async () => {
      steps.push("damages");
      return { heads: 0, rated: 0 };
    };
    (ChatRepo as any).listConsultationIdsByCase = async () => [];
    (CaseRepo as any).markRefreshed = async () => ({ count: 1 });
    (OrganizationRepo as any).writeAudit = async (data: any) => {
      audits.push(data);
    };
    (AiGenerationLockSvc as any).finishWith = async (_caseId: string, _kind: string, fn: () => Promise<unknown>) => fn();
    (CaseSnapshotSvc as any).get = async () => ({});
    mapReasons = [];
    (CaseMindMapSvc as any).generateFromDocuments = async (_c: string, _u: string, reason?: string) => {
      mapReasons.push(reason);
      return { skipped: null, map: null };
    };
    // The downstream panes' steps — covered by analysis-refresh-downstream-panes.spec.ts.
    (WitnessExtractSvc as any).extractAllPending = async () => ({ batches: 0 });
    (DamagesExtractSvc as any).extractAllPending = async () => ({ batches: 0 });
    (WitnessScoringSvc as any).scoreFromDocuments = async () => ({ skipped: true });
    (RedTeamSvc as any).generateFromDocuments = async () => ({ skipped: true });
    (AudioOverviewSvc as any).generateForCase = async () => ({ skipped: true });
    (CaseTheorySvc as any).refreshAiDraft = async () => ({ skipped: true });
    (CaseReconstructionSvc as any).autoRegenerate = async () => "skipped-edited";
    // The change summary's reads and its own row — covered by analysis-refresh-downstream-panes.spec.ts.
    (CaseFindingRepo as any).list = async () => [];
    (CaseReconstructionRepo as any).get = async () => null;
    (CaseOutlookRepo as any).latest = async () => null;
    (RedTeamRepo as any).get = async () => null;
    (CaseChangeSummaryRepo as any).latestRefresh = async () => null;
    (CaseChangeSummaryRepo as any).create = async (data: any) => data;
    (CaseRepo as any).getLastRefreshedAt = async () => null;
    Object.assign(CaseChangeReads, {
      strategy: async () => ({ items: [], dates: [] }),
      witnesses: async () => [],
      damages: async () => [],
      theory: async () => null,
      mindMap: async () => null,
    });
  });

  afterEach(() => {
    (CaseRepo as any).exists = originals.exists;
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (EvidenceIntelligenceSvc as any).scanContradictions = originals.scanContradictions;
    (CaseStrategySvc as any).generateFromDocuments = originals.generateStrategy;
    (CaseFindingAiSvc as any).generateFromDocuments = originals.generateFindings;
    (CaseOutlookAiSvc as any).generateFromDocuments = originals.generateOutlook;
    (ChatRepo as any).listConsultationIdsByCase = originals.listConsultationIdsByCase;
    (CaseRepo as any).markRefreshed = originals.markRefreshed;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (AiGenerationLockSvc as any).finishWith = originals.lockFinishWith;
    (CaseSnapshotSvc as any).get = originals.snapshotGet;
    (CaseMindMapSvc as any).generateFromDocuments = originals.mapGenerate;
    (DamagesExtractSvc as any).refreshStep = originals.damagesRefresh;
    (DamagesExtractSvc as any).extractAllPending = originals.damagesExtractAll;
    (WitnessExtractSvc as any).extractAllPending = originals.witnessExtractAll;
    (WitnessScoringSvc as any).scoreFromDocuments = originals.witnessScore;
    (RedTeamSvc as any).generateFromDocuments = originals.redTeamGenerate;
    (AudioOverviewSvc as any).generateForCase = originals.audioOverviewGenerate;
    (CaseTheorySvc as any).refreshAiDraft = originals.theoryRefresh;
    (CaseReconstructionSvc as any).autoRegenerate = originals.reconstructionAuto;
    (CaseFindingRepo as any).list = originals.findingsList;
    (CaseReconstructionRepo as any).get = originals.reconstructionGet;
    (CaseOutlookRepo as any).latest = originals.outlookLatest;
    (RedTeamRepo as any).get = originals.redTeamGet;
    (CaseChangeSummaryRepo as any).latestRefresh = originals.summaryLatest;
    (CaseChangeSummaryRepo as any).create = originals.summaryCreate;
    (CaseRepo as any).getLastRefreshedAt = originals.lastRefreshedAt;
    Object.assign(CaseChangeReads, originals.reads);
  });

  it("re-rates damages after the findings, since Jev's awardability reads the fresh findings", async () => {
    (CaseFindingAiSvc as any).generateFromDocuments = async () => void steps.push("findings");
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(steps.indexOf("damages")).to.be.greaterThan(steps.indexOf("findings"));
  });

  it("still completes the refresh when the damages step throws", async () => {
    (DamagesExtractSvc as any).refreshStep = async () => {
      throw new Error("jev down");
    };
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(audits).to.have.length(1);
    expect(audits[0]).to.include({ action: "case.refresh" });
  });

  it('"Refresh analysis" re-reads every document for damages; the automatic run reads only new ones', async () => {
    const opts: unknown[] = [];
    (DamagesExtractSvc as any).extractAllPending = async (_c: string, _u: string, o?: unknown) => (opts.push(o), { batches: 0 });
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(opts).to.deep.equal([{ rereadAll: true }, { rereadAll: false }]);
  });

  it('"Refresh analysis" rebuilds the case mind map ("refresh"); the automatic run only when documents changed ("auto")', async () => {
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(mapReasons).to.deep.equal(["refresh", "auto"]);
  });

  it("defaults to reason: manual when the caller doesn't specify one (the controller's queued path)", async () => {
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(audits).to.have.length(1);
    expect(audits[0]).to.include({ caseId: "case-1", actorId: "user-1", action: "case.refresh" });
    expect(audits[0].payload).to.include({ reason: "manual" });
  });

  it("records reason: post-extraction when the automatic trigger passes it explicitly", async () => {
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(audits).to.have.length(1);
    expect(audits[0].payload).to.include({ reason: "post-extraction" });
  });

  it("still completes the refresh when the outlook step throws", async () => {
    (CaseOutlookAiSvc as any).generateFromDocuments = async () => {
      throw new Error("chat-wonder timeout");
    };
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(audits).to.have.length(1);
    expect(audits[0]).to.include({ action: "case.refresh" });
  });

  it("queues a map retry when another map build holds the lock, and still completes the refresh", async () => {
    const scheduled: string[] = [];
    const originalSchedule = CaseMindMapSvc.scheduleResync;
    (CaseMindMapSvc as any).scheduleResync = async (caseId: string) => {
      scheduled.push(caseId);
      return true;
    };
    (CaseMindMapSvc as any).generateFromDocuments = async () => {
      throw new HttpError("caseMindMap generation is already in progress", 409);
    };
    try {
      await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    } finally {
      (CaseMindMapSvc as any).scheduleResync = originalSchedule;
    }
    expect(scheduled).to.deep.equal(["case-1"]);
    expect(audits).to.have.length(1);
  });

  it("doesn't queue a map retry for a build that failed for another reason", async () => {
    const scheduled: string[] = [];
    const originalSchedule = CaseMindMapSvc.scheduleResync;
    (CaseMindMapSvc as any).scheduleResync = async (caseId: string) => void scheduled.push(caseId);
    (CaseMindMapSvc as any).generateFromDocuments = async () => {
      throw new Error("chat-wonder timeout");
    };
    try {
      await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    } finally {
      (CaseMindMapSvc as any).scheduleResync = originalSchedule;
    }
    expect(scheduled).to.deep.equal([]);
  });

  it("runs the outlook after findings, since its prompt reads them", async () => {
    const order: string[] = [];
    (CaseFindingAiSvc as any).generateFromDocuments = async () => void order.push("findings");
    (CaseOutlookAiSvc as any).generateFromDocuments = async () => void order.push("outlook");
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(order).to.deep.equal(["findings", "outlook"]);
  });
});
