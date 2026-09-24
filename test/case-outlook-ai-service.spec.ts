/** CaseOutlookAiSvc.generateFromDocuments end to end, with no live Postgres or Chat Wonder: every
 * repository / util it calls is monkeypatched on its CommonJS module object, same idiom as the
 * rest of this suite. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseOutlookAiSvc from "../src/services/case-outlook-ai.service";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseAccess from "../src/utils/case-access";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseRiskRepo from "../src/repositories/case-risk.repository";
import EvidenceRepo from "../src/repositories/evidence.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseOutlookRepo from "../src/repositories/case-outlook.repository";
import * as chatWonder from "../src/utils/chatWonder";
import * as excerpts from "../src/utils/case-document-excerpts";

type Patch = [object, string, unknown];

describe("CaseOutlookAiSvc.generateFromDocuments", () => {
  const PREVIOUS = { id: "previous-outlook" };
  let restore: (() => void)[];
  let inserted: any[];
  let reply: string;
  let docs: { id: string; name: string; ragStatus: string }[];
  let risks: { title: string; severity: string; status: string }[];

  function patch(patches: Patch[]) {
    for (const [target, key, value] of patches) {
      const original = (target as any)[key];
      (target as any)[key] = value;
      restore.push(() => ((target as any)[key] = original));
    }
  }

  beforeEach(() => {
    restore = [];
    inserted = [];
    reply = "";
    docs = [
      { id: "doc-1", name: "Contract", ragStatus: "READY" },
      { id: "doc-2", name: "Invoice", ragStatus: "READY" },
      { id: "doc-3", name: "Letter", ragStatus: "READY" },
    ];
    risks = [];
    patch([
      [AiGenerationLockSvc, "run", async (_id: string, _kind: string, fn: () => Promise<unknown>) => fn()],
      [CaseAccess, "resolveTenantCode", async () => "PH"],
      [CaseRepo, "findLanguage", async () => ({ language: "en" })],
      [DocumentRepo, "listAllByCase", async () => docs],
      [CaseFindingRepo, "list", async () => []],
      [CaseRiskRepo, "list", async () => risks],
      [EvidenceRepo, "listContradictions", async () => []],
      [ProceduralDeadlineRepo, "list", async () => []],
      [excerpts, "buildFactExcerptPack", async () => ({ text: "", chunkIds: [], factCount: 0 })],
      [chatWonder, "getChatWonderSessionId", async () => "session-1"],
      [chatWonder, "callChatWonderRest", async () => ({ response: reply })],
      [CaseOutlookRepo, "latest", async () => PREVIOUS],
      [CaseOutlookRepo, "insert", async (caseId: string, outlook: unknown) => {
        inserted.push({ caseId, outlook });
        return { id: "new-outlook" };
      }],
    ]);
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  const validReply = `[CASE_OUTLOOK]{"band": "FAVORABLE", "confidence": "HIGH", "rationale": "Strong paper trail.",
"drivers": [{"label": "Signed", "direction": "HELPS", "sourceDocId": "doc-1"}, {"label": "Made up", "direction": "HURTS", "sourceDocId": "doc-404"}]}[/CASE_OUTLOOK]`;

  it("inserts a new row with drivers' unknown sourceDocIds dropped", async () => {
    reply = validReply;
    await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(inserted).to.have.length(1);
    expect(inserted[0].caseId).to.equal("case-1");
    expect(inserted[0].outlook).to.deep.equal({
      band: "FAVORABLE",
      confidence: "HIGH",
      rationale: "Strong paper trail.",
      drivers: [
        { label: "Signed", direction: "HELPS", sourceDocId: "doc-1" },
        { label: "Made up", direction: "HURTS" },
      ],
    });
  });

  it("caps confidence to LOW with fewer than the minimum READY documents", async () => {
    reply = validReply;
    docs[2].ragStatus = "PENDING";
    await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(inserted[0].outlook.confidence).to.equal("LOW");
  });

  it("caps confidence to LOW with an open FATAL risk, but not an accepted one", async () => {
    reply = validReply;
    risks = [{ title: "Prescribed", severity: "FATAL", status: "ACCEPTED" }];
    await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(inserted[0].outlook.confidence).to.equal("HIGH");

    risks = [{ title: "Prescribed", severity: "FATAL", status: "OPEN" }];
    await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(inserted[1].outlook.confidence).to.equal("LOW");
  });

  it("keeps the previous outlook and writes nothing on invalid output", async () => {
    reply = '{"band": "WINNING", "confidence": "HIGH", "rationale": "x"}';
    const result = await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(inserted).to.have.length(0);
    expect(result).to.equal(PREVIOUS);
  });

  it("does not call Chat Wonder when the case has no READY documents", async () => {
    let called = false;
    patch([[chatWonder, "callChatWonderRest", async () => ((called = true), { response: validReply })]]);
    docs = docs.map((d) => ({ ...d, ragStatus: "PENDING" }));
    const result = await CaseOutlookAiSvc.generateFromDocuments("case-1");
    expect(called).to.equal(false);
    expect(inserted).to.have.length(0);
    expect(result).to.equal(PREVIOUS);
  });
});
