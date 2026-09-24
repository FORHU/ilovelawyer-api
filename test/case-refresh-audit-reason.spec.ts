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
  };

  let audits: any[];

  beforeEach(() => {
    audits = [];
    (CaseRepo as any).exists = async () => true;
    (DocumentRepo as any).listAllByCase = async () => [];
    (EvidenceIntelligenceSvc as any).scanContradictions = async () => [];
    (CaseStrategySvc as any).generateFromDocuments = async () => ({});
    (CaseFindingAiSvc as any).generateFromDocuments = async () => ({});
    (CaseOutlookAiSvc as any).generateFromDocuments = async () => null;
    (ChatRepo as any).listConsultationIdsByCase = async () => [];
    (CaseRepo as any).markRefreshed = async () => ({ count: 1 });
    (OrganizationRepo as any).writeAudit = async (data: any) => {
      audits.push(data);
    };
    (AiGenerationLockSvc as any).finishWith = async (_caseId: string, _kind: string, fn: () => Promise<unknown>) => fn();
    (CaseSnapshotSvc as any).get = async () => ({});
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

  it("runs the outlook after findings, since its prompt reads them", async () => {
    const order: string[] = [];
    (CaseFindingAiSvc as any).generateFromDocuments = async () => void order.push("findings");
    (CaseOutlookAiSvc as any).generateFromDocuments = async () => void order.push("outlook");
    await CaseRefreshSvc.runQueued("case-1", "user-1");
    expect(order).to.deep.equal(["findings", "outlook"]);
  });
});
