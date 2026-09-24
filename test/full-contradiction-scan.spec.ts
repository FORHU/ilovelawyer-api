/** Full-bundle contradiction scan: candidates from every chunk, Jev keeps only real conflicts,
 * verdicts are cached, and the result lands in EvidenceContradiction with exhibit locators.
 * No live Postgres, Chat Wonder or Jev — everything is monkeypatched. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import * as chatWonder from "../src/utils/chatWonder";
import FullContradictionScanSvc from "../src/services/full-contradiction-scan.service";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import EvidenceRepo from "../src/repositories/evidence.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import FactPairCheckRepo from "../src/repositories/fact-pair-check.repository";
import CaseAccess from "../src/utils/case-access";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";

const CHUNKS = [
  { id: "k1", caseDocumentId: "bundle", chunkIndex: 1, pageNumber: 31, chunkText: "BUNDLE DOCUMENT 13 OF 21 D13 / p.1" },
  { id: "k2", caseDocumentId: "bundle", chunkIndex: 2, pageNumber: 31, chunkText: "The NVR fault was closed resolved on 3 November 2023 and the cameras were recording." },
  { id: "k3", caseDocumentId: "bundle", chunkIndex: 3, pageNumber: 44, chunkText: "BUNDLE DOCUMENT 18 OF 21 D18 / p.1" },
  { id: "k4", caseDocumentId: "bundle", chunkIndex: 4, pageNumber: 44, chunkText: "Meridian says the cameras were not recording on 14 November 2023 owing to the NVR fault." },
  { id: "k5", caseDocumentId: "bundle", chunkIndex: 5, pageNumber: 44, chunkText: "The NVR fault cameras recording invoice was paid on 20 November 2023." },
];

describe("FullContradictionScanSvc.scan", () => {
  const originals = {
    findIds: DocumentChunkRepo.findIdsByDocument,
    findTexts: DocumentChunkRepo.findTextsByIds,
    similar: DocumentChunkRepo.findSimilarChunkPairs,
    cacheFind: FactPairCheckRepo.findByKeys,
    cacheSave: FactPairCheckRepo.saveMany,
    systemOne: TypeSafeClient.prototype.systemOne,
  };
  let cache: Map<string, { pairKey: string; nature: string; confidence: number }>;
  let jevCalls: string[];
  let verdictFor: (sentenceB: string) => { choice: string; confidence: number } | Error;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    cache = new Map();
    jevCalls = [];
    (DocumentChunkRepo as any).findIdsByDocument = async () => CHUNKS.map((c) => c.id);
    (DocumentChunkRepo as any).findTextsByIds = async () => CHUNKS;
    (DocumentChunkRepo as any).findSimilarChunkPairs = async () => [
      { a: "k2", b: "k4", similarity: 0.8 },
      { a: "k2", b: "k5", similarity: 0.7 },
    ];
    (FactPairCheckRepo as any).findByKeys = async (_c: string, keys: string[]) => keys.filter((k) => cache.has(k)).map((k) => cache.get(k));
    (FactPairCheckRepo as any).saveMany = async (_c: string, rows: any[]) => rows.forEach((r) => cache.set(r.pairKey, r));
    (TypeSafeClient.prototype as any).systemOne = async (req: any) => {
      const b = req.state.passageB.text as string;
      jevCalls.push(b);
      const v = verdictFor(b);
      if (v instanceof Error) throw v;
      return { answers: { nature: v } };
    };
  });
  afterEach(() => {
    (DocumentChunkRepo as any).findIdsByDocument = originals.findIds;
    (DocumentChunkRepo as any).findTextsByIds = originals.findTexts;
    (DocumentChunkRepo as any).findSimilarChunkPairs = originals.similar;
    (FactPairCheckRepo as any).findByKeys = originals.cacheFind;
    (FactPairCheckRepo as any).saveMany = originals.cacheSave;
    TypeSafeClient.prototype.systemOne = originals.systemOne;
  });

  const docs = [{ id: "bundle", name: "D01-D20_All.pdf" }];

  it("keeps Jev's confident DIRECT/INFERENTIAL pairs with locators, drops NOT_A_CONFLICT", async () => {
    verdictFor = (b) => (b.includes("not recording") ? { choice: "INFERENTIAL", confidence: 0.82 } : { choice: "NOT_A_CONFLICT", confidence: 0.9 });
    const { hits, stats } = await FullContradictionScanSvc.scan("case-1", docs, "UK");
    expect(stats).to.include({ chunks: 5, candidates: 2, jevChecked: 2, accepted: 1 });
    expect(hits).to.have.length(1);
    expect(hits[0]).to.include({
      kind: "date_mismatch",
      leftLocator: "D13 p.1",
      rightLocator: "D18 p.1",
      nature: "INFERENTIAL",
      natureConfidence: 0.82,
    });
  });

  it("drops an unsure NOT_A_CONFLICT and a low-confidence DIRECT alike", async () => {
    verdictFor = (b) => (b.includes("not recording") ? { choice: "NOT_A_CONFLICT", confidence: 0.55 } : { choice: "DIRECT", confidence: 0.45 });
    expect((await FullContradictionScanSvc.scan("case-1", docs, "UK")).hits).to.deep.equal([]);
  });

  it("caches verdicts so a rescan makes no Jev calls, and never caches a failed call", async () => {
    verdictFor = (b) => (b.includes("not recording") ? { choice: "DIRECT", confidence: 0.9 } : new Error("jev down"));
    await FullContradictionScanSvc.scan("case-1", docs, "UK");
    expect(jevCalls).to.have.length(2);
    expect(cache.size).to.equal(1);

    verdictFor = () => ({ choice: "NOT_A_CONFLICT", confidence: 0.9 });
    const second = await FullContradictionScanSvc.scan("case-1", docs, "UK");
    expect(jevCalls).to.have.length(3); // only the pair that failed last time
    expect(second.stats.cached).to.equal(1);
    expect(second.hits).to.have.length(1); // the cached DIRECT still counts
  });

  it("with jev: false, proposes candidates without calling Jev or the cache", async () => {
    const { verdicts, hits } = await FullContradictionScanSvc.scan("case-1", docs, "UK", { jev: false, cache: false });
    expect(verdicts).to.have.length(2);
    expect(jevCalls).to.deep.equal([]);
    expect(hits).to.deep.equal([]);
  });
});

describe("EvidenceIntelligenceSvc.scanContradictions with the full scan on", () => {
  const originals = {
    list: EvidenceRepo.listContradictions,
    replace: EvidenceRepo.replaceContradictions,
    listDocs: DocumentRepo.listAllByCase,
    tenant: CaseAccess.resolveTenantCode,
    lockRun: AiGenerationLockSvc.run,
    session: (chatWonder as any).getChatWonderSessionId,
    rest: (chatWonder as any).callChatWonderRest,
    fullScan: FullContradictionScanSvc.scan,
    findIds: DocumentChunkRepo.findIdsByDocument,
    findTexts: DocumentChunkRepo.findTextsByIds,
    flag: process.env.USE_FULL_CONTRADICTION_SCAN,
  };
  let stored: any[];

  beforeEach(() => {
    stored = [];
    process.env.USE_FULL_CONTRADICTION_SCAN = "true";
    (EvidenceRepo as any).listContradictions = async () => stored;
    (EvidenceRepo as any).replaceContradictions = async (_c: string, rows: any[]) => (stored = rows.map((r, i) => ({ id: `c${i}`, status: "OPEN", ...r })));
    (DocumentRepo as any).listAllByCase = async () => [{ id: "bundle", name: "D01-D20_All.pdf", ragStatus: "READY" }];
    // The sample scan's regex pass and excerpt pack read chunks — keep them off the database.
    (DocumentChunkRepo as any).findIdsByDocument = async () => [];
    (DocumentChunkRepo as any).findTextsByIds = async () => [];
    (CaseAccess as any).resolveTenantCode = async () => "UK";
    (AiGenerationLockSvc as any).run = async (_s: string, _k: string, fn: () => Promise<unknown>) => fn();
    (chatWonder as any).getChatWonderSessionId = async () => "s1";
    // The sample scan found the same conflict (no locators) plus an unrelated one.
    (chatWonder as any).callChatWonderRest = async () => ({
      response: `[CONTRADICTIONS]${JSON.stringify([
        { kind: "date_mismatch", factKey: "incident_date", leftDocumentId: "bundle", rightDocumentId: "bundle", leftValue: "2023-11-03", rightValue: "2023-11-14", leftExcerpt: "closed 3 Nov", rightExcerpt: "not recording 14 Nov", confidence: 0.7 },
        { kind: "party_mismatch", factKey: "party_defendant", leftDocumentId: "bundle", rightDocumentId: "bundle", leftValue: "Meridian Ltd", rightValue: "Meridian LLP", leftExcerpt: "Meridian Ltd", rightExcerpt: "Meridian LLP", confidence: 0.6 },
      ])}[/CONTRADICTIONS]`,
    });
    (FullContradictionScanSvc as any).scan = async () => ({
      hits: [
        { kind: "date_mismatch", factKey: "date", leftDocumentId: "bundle", rightDocumentId: "bundle", leftValue: "2023-11-03", rightValue: "2023-11-14", leftExcerpt: "The NVR fault was closed…", rightExcerpt: "…not recording on 14 November 2023…", confidence: 0.9, nature: "DIRECT", natureConfidence: 0.9, leftLocator: "D13 p.1", rightLocator: "D18 p.1" },
      ],
      verdicts: [],
      stats: {},
    });
  });
  afterEach(() => {
    (EvidenceRepo as any).listContradictions = originals.list;
    (EvidenceRepo as any).replaceContradictions = originals.replace;
    (DocumentRepo as any).listAllByCase = originals.listDocs;
    (CaseAccess as any).resolveTenantCode = originals.tenant;
    (AiGenerationLockSvc as any).run = originals.lockRun;
    (chatWonder as any).getChatWonderSessionId = originals.session;
    (chatWonder as any).callChatWonderRest = originals.rest;
    (FullContradictionScanSvc as any).scan = originals.fullScan;
    (DocumentChunkRepo as any).findIdsByDocument = originals.findIds;
    (DocumentChunkRepo as any).findTextsByIds = originals.findTexts;
    if (originals.flag === undefined) delete process.env.USE_FULL_CONTRADICTION_SCAN;
    else process.env.USE_FULL_CONTRADICTION_SCAN = originals.flag;
  });

  it("adds the full scan's hits with locators, dropping the sample hit it duplicates", async () => {
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(stored).to.have.length(2);
    const full = stored.find((r) => r.leftLocator);
    expect(full).to.include({ leftLocator: "D13 p.1", rightLocator: "D18 p.1", nature: "DIRECT", natureConfidence: 0.9 });
    expect(stored.find((r) => r.kind === "party_mismatch")).to.exist;
  });

  it("keeps a resolved full-scan contradiction resolved on rescan", async () => {
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    const idx = stored.findIndex((r) => r.leftLocator);
    stored[idx] = { ...stored[idx], status: "RESOLVED", resolutionNote: "Different NVR" };
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(stored.find((r) => r.leftLocator)).to.include({ status: "RESOLVED", resolutionNote: "Different NVR" });
  });

  it("still saves the sample scan's hits when the full scan throws", async () => {
    (FullContradictionScanSvc as any).scan = async () => {
      throw new Error("db timeout");
    };
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(stored).to.have.length(2);
    expect(stored.every((r) => !r.leftLocator)).to.equal(true);
  });
});
