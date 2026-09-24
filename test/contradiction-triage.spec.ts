/** Contradiction triage: the lawyer's Resolved/Dismissed status (and Jev's Direct/Inferential
 * classification) must survive a rescan, even though every scan rebuilds EvidenceContradiction.
 * No live Postgres, Chat Wonder or Jev — repos, the chatWonder module and the TypeSafe client are
 * monkeypatched, same idiom as test/case-post-extraction.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import * as chatWonder from "../src/utils/chatWonder";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import EvidenceRepo from "../src/repositories/evidence.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import CaseAccess from "../src/utils/case-access";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import { contradictionKey } from "../src/utils/contradiction-key";
import { classifyContradictionWithJev } from "../src/utils/contradiction-nature-jev";

const base = {
  kind: "date_mismatch",
  factKey: "incident_date",
  leftDocumentId: "d1",
  rightDocumentId: "d2",
  leftValue: "4 August 2024",
  rightValue: "8 August 2024",
};

describe("contradictionKey", () => {
  it("ignores which side each document was put on, and value case/spacing", () => {
    const swapped = {
      ...base,
      leftDocumentId: "d2",
      rightDocumentId: "d1",
      leftValue: "8  august 2024",
      rightValue: "4 August 2024",
    };
    expect(contradictionKey(swapped)).to.equal(contradictionKey(base));
  });

  it("differs when a value or the fact differs", () => {
    expect(contradictionKey({ ...base, rightValue: "9 August 2024" })).to.not.equal(contradictionKey(base));
    expect(contradictionKey({ ...base, factKey: "contract_date" })).to.not.equal(contradictionKey(base));
  });
});

describe("classifyContradictionWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: { choice: string; confidence: number };
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async () => ({ answers: { nature: reply } });
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const input = {
    factKey: "incident_date",
    left: { document: "Letter", excerpt: "absent from 4 August", value: "4 August" },
    right: { document: "Payroll", excerpt: "paid through 8 August", value: "8 August" },
  };

  it("keeps a confident verdict", async () => {
    reply = { choice: "DIRECT", confidence: 0.9 };
    expect(await classifyContradictionWithJev(input)).to.deep.equal({ nature: "DIRECT", confidence: 0.9, rawNature: "DIRECT" });
  });

  it("records an unsure NOT_A_CONFLICT as INFERENTIAL, so a real conflict isn't talked away", async () => {
    reply = { choice: "NOT_A_CONFLICT", confidence: 0.55 };
    expect(await classifyContradictionWithJev(input)).to.include({ nature: "INFERENTIAL", rawNature: "NOT_A_CONFLICT" });
    reply = { choice: "NOT_A_CONFLICT", confidence: 0.85 };
    expect((await classifyContradictionWithJev(input)).nature).to.equal("NOT_A_CONFLICT");
  });
});

describe("EvidenceIntelligenceSvc.scanContradictions carry-over", () => {
  const originals = {
    list: EvidenceRepo.listContradictions,
    replace: EvidenceRepo.replaceContradictions,
    listDocs: DocumentRepo.listAllByCase,
    findIds: DocumentChunkRepo.findIdsByDocument,
    findTexts: DocumentChunkRepo.findTextsByIds,
    tenant: CaseAccess.resolveTenantCode,
    lockRun: AiGenerationLockSvc.run,
    session: (chatWonder as any).getChatWonderSessionId,
    rest: (chatWonder as any).callChatWonderRest,
    systemOne: TypeSafeClient.prototype.systemOne,
    flag: process.env.USE_JEV_CONTRADICTIONS,
  };
  let stored: any[];
  let llmHits: object[];
  let jevCalls: number;

  const hit = (over: object = {}) => ({ ...base, leftExcerpt: "absent from 4 August", rightExcerpt: "paid through 8 August", confidence: 0.8, ...over });

  beforeEach(() => {
    stored = [];
    jevCalls = 0;
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (EvidenceRepo as any).listContradictions = async () => stored;
    (EvidenceRepo as any).replaceContradictions = async (_caseId: string, rows: any[]) => {
      stored = rows.map((r, i) => ({ id: `c${i}`, status: "OPEN", nature: null, natureConfidence: null, resolutionNote: null, resolvedAt: null, resolvedById: null, ...r }));
      return stored;
    };
    (DocumentRepo as any).listAllByCase = async () => [
      { id: "d1", name: "Termination letter", ragStatus: "READY" },
      { id: "d2", name: "Payroll", ragStatus: "READY" },
    ];
    (DocumentChunkRepo as any).findIdsByDocument = async () => [];
    (DocumentChunkRepo as any).findTextsByIds = async () => [];
    (CaseAccess as any).resolveTenantCode = async () => "PH";
    (AiGenerationLockSvc as any).run = async (_s: string, _k: string, fn: () => Promise<unknown>) => fn();
    (chatWonder as any).getChatWonderSessionId = async () => "s1";
    (chatWonder as any).callChatWonderRest = async () => ({ response: `[CONTRADICTIONS]${JSON.stringify(llmHits)}[/CONTRADICTIONS]` });
    (TypeSafeClient.prototype as any).systemOne = async () => {
      jevCalls += 1;
      return { answers: { nature: { choice: "DIRECT", confidence: 0.9 } } };
    };
  });

  afterEach(() => {
    (EvidenceRepo as any).listContradictions = originals.list;
    (EvidenceRepo as any).replaceContradictions = originals.replace;
    (DocumentRepo as any).listAllByCase = originals.listDocs;
    (DocumentChunkRepo as any).findIdsByDocument = originals.findIds;
    (DocumentChunkRepo as any).findTextsByIds = originals.findTexts;
    (CaseAccess as any).resolveTenantCode = originals.tenant;
    (AiGenerationLockSvc as any).run = originals.lockRun;
    (chatWonder as any).getChatWonderSessionId = originals.session;
    (chatWonder as any).callChatWonderRest = originals.rest;
    TypeSafeClient.prototype.systemOne = originals.systemOne;
    if (originals.flag === undefined) delete process.env.USE_JEV_CONTRADICTIONS;
    else process.env.USE_JEV_CONTRADICTIONS = originals.flag;
  });

  it("keeps a resolved contradiction resolved when the rescan finds it again, sides swapped", async () => {
    llmHits = [hit()];
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    stored[0] = { ...stored[0], status: "RESOLVED", resolutionNote: "Payroll lag", resolvedById: "u1", resolvedAt: new Date() };

    llmHits = [
      hit({ leftDocumentId: "d2", rightDocumentId: "d1", leftValue: "8 August 2024", rightValue: "4 August 2024" }),
      hit({ factKey: "contract_date", leftValue: "1 Jan", rightValue: "3 Jan" }),
    ];
    await EvidenceIntelligenceSvc.scanContradictions("case-1");

    const kept = stored.find((r) => r.factKey === "incident_date");
    const fresh = stored.find((r) => r.factKey === "contract_date");
    expect(kept).to.include({ status: "RESOLVED", resolutionNote: "Payroll lag", resolvedById: "u1" });
    expect(fresh.status).to.equal("OPEN");
  });

  it("only sends contradictions it hasn't classified before to Jev, and only when the flag is on", async () => {
    llmHits = [hit()];
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(jevCalls).to.equal(0);
    expect(stored[0].nature).to.equal(null);

    process.env.USE_JEV_CONTRADICTIONS = "true";
    llmHits = [hit({ factKey: "contract_date", leftValue: "1 Jan", rightValue: "3 Jan" })];
    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(jevCalls).to.equal(1);
    expect(stored[0]).to.include({ nature: "DIRECT", natureConfidence: 0.9 });

    await EvidenceIntelligenceSvc.scanContradictions("case-1");
    expect(jevCalls).to.equal(1);
    expect(stored[0].nature).to.equal("DIRECT");
  });
});
