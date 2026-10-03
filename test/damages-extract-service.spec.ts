/**
 * DamagesExtractSvc end to end: pending documents → prompt → [DAMAGES] reply → verified,
 * deduped AI entries → audit. Chat Wonder is a local `ws` server replying with a scripted
 * block (same idiom as mind-map-data-frame.spec.ts); repositories are monkeypatched, no DB.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import * as config from "../src/config";
import * as chatWonder from "../src/utils/chatWonder";
import DamagesExtractSvc from "../src/services/damages-extract.service";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import { isCriminalCase } from "../src/utils/case-kind";

const PAYSLIP = "PAYSLIP August 2025. Basic monthly salary: P27,000.00. Net pay: P24,310.00";
const COMPLAINT =
  "Complainant prays for reinstatement without loss of seniority, P200,000.00 as moral damages and P100,000.00 as exemplary damages.";

describe("DamagesExtractSvc", () => {
  let server: WebSocketServer;
  // One reply for every call, or a queue consumed call by call (first answer, then the correction).
  let reply: string | string[];
  let payloads: any[];
  let originalWsUrl: string;
  const restore: (() => void)[] = [];

  let pending: { id: string; name: string }[];
  let existing: any[];
  let created: any[];
  let marked: string[][];
  let audits: any[];
  let scheduled: number;

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        payloads.push(JSON.parse(raw.toString()));
        socket.send(Array.isArray(reply) ? (reply.shift() ?? "[DAMAGES][][/DAMAGES]") : reply);
        socket.send("__END__");
        socket.send("[DONE]");
      });
    });
    const { port } = server.address() as AddressInfo;
    originalWsUrl = config.CHAT_WONDER_WS_URL;
    (config as any).CHAT_WONDER_WS_URL = `ws://127.0.0.1:${port}/chat-stream`;
  });

  after(() => {
    (config as any).CHAT_WONDER_WS_URL = originalWsUrl;
    server.close();
  });

  beforeEach(() => {
    // A local .env may turn USE_JEV_DAMAGES on; these tests are about the extraction itself and
    // must never call Jev, so the flag is pinned off.
    const jevFlag = process.env.USE_JEV_DAMAGES;
    delete process.env.USE_JEV_DAMAGES;
    restore.push(() => {
      if (jevFlag === undefined) delete process.env.USE_JEV_DAMAGES;
      else process.env.USE_JEV_DAMAGES = jevFlag;
    });
    payloads = [];
    pending = [
      { id: "doc-pay", name: "Payslip.pdf" },
      { id: "doc-cmp", name: "Complaint.pdf" },
    ];
    existing = [];
    created = [];
    marked = [];
    audits = [];
    scheduled = 0;
    reply = `[DAMAGES]${JSON.stringify([
      { kind: "DAMAGE", title: "Moral damages", description: "For the anguish of the dismissal", amount: 200000, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" },
      { kind: "DAMAGE", title: "Exemplary", amount: 150000, documentId: "doc-cmp", quote: "P100,000.00 as exemplary damages" },
      { kind: "REMEDY", title: "Reinstatement", amount: null, documentId: "doc-cmp", quote: "reinstatement without loss of seniority" },
    ])}[/DAMAGES]`;

    patch(chatWonder, "getChatWonderSessionId", async () => "sess-1");
    patch(CaseRepo, "exists", async () => true);
    patch(CaseRepo, "findPromptHeader", async () => ({ caseName: "Cruz v. Acme", actionType: "Illegal dismissal" }));
    patch(CaseAccess, "resolveTenantCode", async () => "PH");
    patch(CaseAccess, "assertCanEdit", async () => ({ id: "case-1" }));
    patch(DocumentRepo, "listPendingDamagesExtraction", async () => pending);
    patch(DocumentRepo, "markDamagesExtracted", async (ids: string[]) => void marked.push(ids));
    patch(DocumentChunkRepo, "findFullTextsByDocuments", async () => new Map([["doc-pay", PAYSLIP], ["doc-cmp", COMPLAINT]]));
    patch(DamageClaimRepo, "list", async () => [...existing, ...created]);
    patch(DamageClaimRepo, "createFromAi", async (_caseId: string, data: any) => {
      const row = { id: `new-${created.length}`, ...data, sourceQuote: data.sourceQuote };
      created.push(row);
      return row;
    });
    patch(CaseGraphSvc, "ensureNode", async () => ({}));
    patch(CaseFindingRepo, "list", async () => []);
    patch(OrganizationRepo, "writeAudit", async (a: any) => void audits.push(a));
    patch(AiGenerationLockSvc, "begin", async () => {});
    patch(AiGenerationLockSvc, "finishWith", async (_c: string, _k: string, fn: () => Promise<unknown>) => fn());
    patch(AiGenerationLockSvc, "getStatus", async () => null);
    patch(DamagesExtractSvc, "schedule", () => void scheduled++);
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  it("asks on the legal persona like the other extraction jobs, without the verify pass", async () => {
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(payloads).to.have.length(1);
    expect(payloads[0].user_input.startsWith("[legal ai] ")).to.equal(true);
    expect(payloads[0].skip_legal_verify).to.equal(true);
    // Not a case chat turn: no mind-map rule appended.
    expect(payloads[0].user_input).to.not.include("visual case strategy map");
    // Documents are shown under handles, not their ids.
    expect(payloads[0].user_input).to.include("--- DOCUMENT D1 | name: Payslip.pdf ---");
    expect(payloads[0].user_input).to.not.include("doc-pay");
  });

  it("creates only verified entries, as AI suggestions with their source, and marks the batch read", async () => {
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    // Exemplary's 150000 isn't in its quote (which says 100,000), so it is dropped.
    expect(created.map((h) => [h.kind, h.title])).to.deep.equal([
      ["DAMAGE", "Moral damages"],
      ["REMEDY", "Reinstatement"],
    ]);
    expect(created[0]).to.include({
      amount: 200000,
      description: "For the anguish of the dismissal",
      sourceDocumentId: "doc-cmp",
      sourceQuote: "P200,000.00 as moral damages",
    });
    expect(created[1]).to.include({ amount: null });
    expect(marked).to.deep.equal([["doc-pay", "doc-cmp"]]);
    expect(audits[0]).to.include({ action: "damage.extract" });
    expect(audits[0].payload.ids).to.deep.equal(["new-0", "new-1"]);
  });

  it("resolves a handle citation to the real document, and works out rate × count", async () => {
    patch(DocumentChunkRepo, "findFullTextsByDocuments", async () =>
      new Map([["doc-pay", "Weekly pay: 450.00. Notice period: 12 weeks."], ["doc-cmp", COMPLAINT]]),
    );
    reply = `[DAMAGES]${JSON.stringify([
      {
        kind: "DAMAGE",
        title: "Notice pay",
        calculation: { rate: 450, count: 12, unit: "week" },
        quotes: [{ documentId: "D1", quote: "Weekly pay: 450.00. Notice period: 12 weeks." }],
      },
    ])}[/DAMAGES]`;
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(created).to.have.length(1);
    expect(created[0]).to.include({ amount: 5400, amountBasis: "CALCULATED", amountNote: "12 weeks × 450 a week", sourceDocumentId: "doc-pay" });
  });

  it("fills in the amount of a waiting AI suggestion that had none, and leaves accepted or lawyer entries alone", async () => {
    const filled: any[] = [];
    patch(DamageClaimRepo, "fillAiAmount", async (id: string, _caseId: string, data: any) => {
      filled.push({ id, ...data });
      return { id };
    });
    existing = [
      { id: "ai-moral", kind: "DAMAGE", title: "Moral damages", amount: null, source: "AI", accepted: false },
      { id: "mine-reinst", kind: "REMEDY", title: "Reinstatement", amount: null, source: "MANUAL", accepted: true },
    ];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(filled.map((f) => [f.id, f.amount, f.amountBasis, f.sourceQuote])).to.deep.equal([
      ["ai-moral", 200000, "STATED", "P200,000.00 as moral damages"],
    ]);
    expect(created).to.deep.equal([]);
    expect(audits[0].payload.filledIds).to.deep.equal(["ai-moral"]);
  });

  it("replaces a waiting AI estimate with a figure the documents state, but not with another estimate", async () => {
    const filled: any[] = [];
    patch(DamageClaimRepo, "fillAiAmount", async (id: string, _caseId: string, data: any) => {
      filled.push({ id, ...data });
      return { id };
    });
    existing = [
      { id: "est-moral", kind: "DAMAGE", title: "Moral damages", amount: 50000, amountBasis: "ESTIMATE", source: "AI", accepted: false },
      { id: "est-feel", kind: "DAMAGE", title: "Injury to feelings", amount: 9000, amountBasis: "ESTIMATE", source: "AI", accepted: false },
    ];
    reply = `[DAMAGES]${JSON.stringify([
      { kind: "DAMAGE", title: "Moral damages", amount: 200000, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" },
      {
        kind: "DAMAGE",
        title: "Injury to feelings",
        estimate: { amount: 20000, basis: "Usual range." },
        documentId: "doc-cmp",
        quote: "reinstatement without loss of seniority",
      },
    ])}[/DAMAGES]`;
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(filled.map((f) => [f.id, f.amount, f.amountBasis])).to.deep.equal([["est-moral", 200000, "STATED"]]);
  });

  it("saves an estimate with its basis, marked ESTIMATE", async () => {
    reply = `[DAMAGES]${JSON.stringify([
      {
        kind: "DAMAGE",
        title: "Exemplary damages",
        estimate: { amount: 50000, basis: "Usual award where the dismissal was done in bad faith." },
        documentId: "doc-cmp",
        quote: "P100,000.00 as exemplary damages",
      },
    ])}[/DAMAGES]`;
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(created[0]).to.include({
      amount: 50000,
      amountBasis: "ESTIMATE",
      amountNote: "Usual award where the dismissal was done in bad faith.",
    });
  });

  it("asks once more for an estimate for every damage still without an amount, new or waiting", async () => {
    const filled: any[] = [];
    patch(DamageClaimRepo, "fillAiAmount", async (id: string, _caseId: string, data: any) => {
      filled.push({ id, ...data });
      return { id };
    });
    existing = [
      { id: "old-notice", kind: "DAMAGE", title: "Notice pay", amount: null, source: "AI", accepted: false, sourceDocumentId: "doc-pay", sourceQuote: "Basic monthly salary: P27,000.00" },
      { id: "mine", kind: "DAMAGE", title: "Holiday pay", amount: null, source: "MANUAL", accepted: true },
    ];
    reply = [
      `[DAMAGES]${JSON.stringify([
        { kind: "DAMAGE", title: "Exemplary damages", amount: null, documentId: "doc-cmp", quote: "P100,000.00 as exemplary damages" },
        { kind: "REMEDY", title: "Reinstatement", amount: null, documentId: "doc-cmp", quote: "reinstatement without loss of seniority" },
      ])}[/DAMAGES]`,
      `[ESTIMATES]${JSON.stringify([
        { title: "Exemplary damages", amount: 75000, basis: "Usual award for a dismissal in bad faith." },
        { title: "Notice pay", amount: 27000, basis: "One month's basic salary." },
      ])}[/ESTIMATES]`,
    ];
    await DamagesExtractSvc.runQueued("case-1", "user-1");

    expect(payloads).to.have.length(2);
    expect(payloads[1].user_input).to.include("- Exemplary damages").and.to.include("- Notice pay");
    // Neither a remedy nor the lawyer's own entry is sent for an estimate.
    expect(payloads[1].user_input).to.not.include("- Reinstatement").and.to.not.include("- Holiday pay");
    expect(created.map((h) => [h.title, h.amount, h.amountBasis])).to.deep.equal([
      ["Exemplary damages", 75000, "ESTIMATE"],
      ["Reinstatement", null, null],
    ]);
    expect(filled.map((f) => [f.id, f.amount, f.amountBasis, f.amountNote])).to.deep.equal([
      ["old-notice", 27000, "ESTIMATE", "One month's basic salary."],
    ]);
  });

  it("keeps a damage without an amount when the estimate call fails, and asks nothing when all are priced", async () => {
    reply = [
      `[DAMAGES]${JSON.stringify([{ kind: "DAMAGE", title: "Exemplary damages", documentId: "doc-cmp", quote: "P100,000.00 as exemplary damages" }])}[/DAMAGES]`,
      "no block",
    ];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(created.map((h) => [h.title, h.amount])).to.deep.equal([["Exemplary damages", null]]);

    payloads = [];
    created = [];
    reply = `[DAMAGES]${JSON.stringify([{ kind: "DAMAGE", title: "Moral damages", amount: 200000, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" }])}[/DAMAGES]`;
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(payloads).to.have.length(1);
  });

  it("never duplicates an entry the case already has", async () => {
    existing = [{ id: "mine", kind: "DAMAGE", title: "moral damages", amount: 200000 }];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(created.map((h) => h.title)).to.deep.equal(["Reinstatement"]);
    expect(payloads[0].user_input).to.include("- DAMAGE — moral damages: 200000");
  });

  describe("with Jev reviewing proposals", () => {
    const original = TypeSafeClient.prototype.systemOne;
    // Jev's verdict per quoted figure: net pay is not the basic salary.
    const verdicts: Record<string, [string, number]> = {
      "27000": ["SUPPORTED", 0.95],
      "24310": ["UNSUPPORTED", 0.9],
      "200000": ["SUPPORTED", 0.9],
    };
    let asked: string[];

    beforeEach(() => {
      process.env.USE_JEV_DAMAGES = "true";
      process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
      asked = [];
      (TypeSafeClient.prototype as any).systemOne = async (req: { state: { quotedFigure: string } }) => {
        asked.push(req.state.quotedFigure);
        const [choice, confidence] = verdicts[req.state.quotedFigure] ?? ["SUPPORTED", 0.9];
        return { answers: { support: { choice, confidence } } };
      };
    });
    afterEach(() => {
      TypeSafeClient.prototype.systemOne = original;
      delete process.env.USE_JEV_DAMAGES;
    });

    const netPay = { kind: "DAMAGE", title: "Unpaid salary", amount: 24310, documentId: "doc-pay", quote: "Net pay: P24,310.00" };
    const basic = { kind: "DAMAGE", title: "Unpaid salary", amount: 27000, documentId: "doc-pay", quote: "Basic monthly salary: P27,000.00" };
    const moral = { kind: "DAMAGE", title: "Moral damages", amount: 200000, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" };
    const block = (rows: unknown[]) => `[DAMAGES]${JSON.stringify(rows)}[/DAMAGES]`;

    it("asks Chat Wonder again for a figure Jev rejects, and saves the corrected one", async () => {
      reply = [block([netPay, moral]), block([basic])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");

      expect(payloads).to.have.length(2);
      expect(payloads[1].user_input.startsWith("[legal ai] ")).to.equal(true);
      expect(payloads[1].skip_legal_verify).to.equal(true);
      expect(payloads[1].user_input).to.include(
        'from document D1, quoted as "Net pay: P24,310.00" — rejected because the quoted lines do not state this figure',
      );
      // Only the cited document goes back, not the whole batch.
      expect(payloads[1].user_input).to.include("--- DOCUMENT D1 | name: Payslip.pdf");
      expect(payloads[1].user_input).to.not.include("--- DOCUMENT D2");

      // Accepted heads are saved first, then the corrected ones.
      expect(created.map((h) => [h.title, h.amount, h.sourceQuote])).to.deep.equal([
        ["Moral damages", 200000, "P200,000.00 as moral damages"],
        ["Unpaid salary", 27000, "Basic monthly salary: P27,000.00"],
      ]);
      expect(asked).to.deep.equal(["24310", "200000", "27000"]);
    });

    it("drops a rejected figure when the correction is wrong again or leaves it out", async () => {
      reply = [block([netPay, moral]), block([netPay])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(created.map((h) => h.title)).to.deep.equal(["Moral damages"]);

      created = [];
      payloads = [];
      reply = [block([netPay]), block([])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(created).to.deep.equal([]);
      expect(payloads).to.have.length(2);
    });

    it("ignores heads the correction adds that weren't rejected", async () => {
      reply = [block([netPay]), block([basic, moral])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(created.map((h) => h.title)).to.deep.equal(["Unpaid salary"]);
    });

    it("asks nothing more when Jev accepts every proposal", async () => {
      reply = [block([basic, moral])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(payloads).to.have.length(1);
      expect(created).to.have.length(2);
    });
  });

  it("sends the case's damages model as case_damages on a chat turn that carries it", async () => {
    const caseDamages = { currency: "PHP", total: 1, heads: [{ category: "MORAL", amount: 1 }] };
    await chatWonder.streamChatWonderMessage("sess-1", "How much can we claim?", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, {
      resolveOnAnswerEnd: true,
      caseDamages,
    });
    await chatWonder.streamChatWonderMessage("sess-1", "Hello", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, {
      resolveOnAnswerEnd: true,
    });
    expect(payloads[0].case_damages).to.deep.equal(caseDamages);
    expect(payloads[0].user_input.startsWith("[legal ai]")).to.equal(true);
    expect(payloads[1]).to.not.have.property("case_damages");
  });

  it("leaves documents unread, and fails the job, when the reply has no [DAMAGES] block", async () => {
    reply = "I could not find anything.";
    const err = await DamagesExtractSvc.runQueued("case-1", "user-1").catch((e) => e);
    expect(err).to.be.instanceOf(HttpError);
    expect(marked).to.deep.equal([]);
    expect(created).to.deep.equal([]);
  });

  it("writes no audit when nothing new was found", async () => {
    reply = "[DAMAGES][][/DAMAGES]";
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(marked).to.have.length(1);
    expect(audits).to.deep.equal([]);
  });

  it("does nothing without pending documents", async () => {
    pending = [];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(payloads).to.deep.equal([]);
  });

  it("reschedules itself when more documents are waiting than one batch reads", async () => {
    pending = Array.from({ length: 9 }, (_, i) => ({ id: i === 0 ? "doc-pay" : `d${i}`, name: `D${i}` }));
    reply = "[DAMAGES][][/DAMAGES]";
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(marked[0]).to.have.length(8);
    expect(scheduled).to.equal(1);
  });

  it("propose() claims the job before queueing it, re-reads every document, and refuses while a pass is running", async () => {
    let cleared = 0;
    const began: string[] = [];
    const queued: any[] = [];
    patch(DocumentRepo, "clearDamagesExtracted", async () => void cleared++);
    patch(AiGenerationLockSvc, "begin", async (_c: string, kind: string) => void began.push(kind));
    patch(AiGenerationQueue, "enqueue", (job: any) => void queued.push(job));
    await DamagesExtractSvc.propose("case-1", "user-1");
    // The lock is held when the 202 goes out, so the panel sees this run as IN_PROGRESS.
    expect(began).to.deep.equal(["damagesExtract"]);
    expect(queued.map((j) => j.kind)).to.deep.equal(["damagesExtractPropose"]);
    expect(cleared).to.equal(1);

    patch(AiGenerationLockSvc, "begin", async () => {
      throw new HttpError("damagesExtract generation is already in progress", 409);
    });
    const err = await DamagesExtractSvc.propose("case-1", "user-1").catch((e) => e);
    expect(err.statusCode).to.equal(409);
    expect([cleared, queued.length]).to.deep.equal([1, 1]);
  });

  it("runQueuedPropose() reads a batch under the claimed lock and queues the rest", async () => {
    let begun = 0;
    patch(AiGenerationLockSvc, "begin", async () => void begun++);
    pending = Array.from({ length: 9 }, (_, i) => ({ id: i === 0 ? "doc-pay" : `d${i}`, name: `D${i}` }));
    reply = "[DAMAGES][][/DAMAGES]";
    await DamagesExtractSvc.runQueuedPropose("case-1", "user-1");
    expect(begun).to.equal(0);
    expect(marked[0]).to.have.length(8);
    expect(scheduled).to.equal(1);
  });

  // R v Doyle QA: on a murder prosecution the pass proposed unfair-dismissal awards and
  // reinstatement out of the defendant's own ACAS wage dispute, which sits in the evidence.
  describe("on a UK criminal case", () => {
    const ACAS = "ACAS early conciliation: Mr Doyle claims unpaid overtime and holiday pay of £4,180 from Kestrel Motors.";
    const MG3 = "The Crown will seek a compensation order of £2,500 for the funeral expenses.";
    let deleted: string[];

    beforeEach(() => {
      deleted = [];
      patch(CaseAccess, "resolveTenantCode", async () => "UK");
      patch(CaseRepo, "findPromptHeader", async () => ({ caseName: "R v Ryan James DOYLE", actionType: null, jurisdiction: "Reading Crown Court" }));
      pending = [
        { id: "doc-acas", name: "ACAS.pdf" },
        { id: "doc-mg3", name: "MG3.pdf" },
      ];
      patch(DocumentChunkRepo, "findFullTextsByDocuments", async () => new Map([["doc-acas", ACAS], ["doc-mg3", MG3]]));
      patch(DamageClaimRepo, "delete", async (id: string) => {
        deleted.push(id);
        existing = existing.filter((e) => e.id !== id);
        return true;
      });
      reply = `[DAMAGES]${JSON.stringify([
        { kind: "DAMAGE", title: "Basic award", amount: 4180, quotes: [{ documentId: "D1", quote: "unpaid overtime and holiday pay of £4,180" }] },
        { kind: "REMEDY", title: "Reinstatement", amount: null, quotes: [{ documentId: "D1", quote: "claims unpaid overtime and holiday pay" }] },
        { kind: "DAMAGE", title: "Compensation order", amount: 2500, quotes: [{ documentId: "D2", quote: "a compensation order of £2,500" }] },
      ])}[/DAMAGES]`;
    });

    it("asks only for criminal-court orders and keeps only those", async () => {
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(payloads[0].user_input).to.contain("This is a criminal prosecution");
      expect(payloads[0].user_input).to.not.contain("Usual heads by claim: breach of contract");
      expect(created.map((c) => c.title)).to.deep.equal(["Compensation order"]);
    });

    it("withdraws waiting employment suggestions, but never an accepted entry or the lawyer's own", async () => {
      existing = [
        { id: "ai-waiting", kind: "DAMAGE", title: "Compensatory award", source: "AI", accepted: false, amount: 12000 },
        { id: "ai-reinstate", kind: "REMEDY", title: "Reinstatement", source: "AI", accepted: false, amount: null },
        { id: "ai-accepted", kind: "DAMAGE", title: "Unpaid overtime and holiday pay", source: "AI", accepted: true, amount: 4180 },
        { id: "lawyer", kind: "DAMAGE", title: "Holiday pay", source: "USER", accepted: true, amount: 300 },
      ];
      reply = "[DAMAGES][][/DAMAGES]";
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(deleted).to.deep.equal(["ai-waiting", "ai-reinstate"]);
      expect(audits[0].payload.withdrawnIds).to.deep.equal(["ai-waiting", "ai-reinstate"]);
    });
  });
});

describe("isCriminalCase", () => {
  it("reads the action type, the prosecution's case name, or a criminal venue", () => {
    expect(isCriminalCase({ caseName: "Doyle", actionType: "Criminal Proceeding" })).to.equal(true);
    expect(isCriminalCase({ caseName: "R v Ryan James DOYLE" })).to.equal(true);
    expect(isCriminalCase({ caseName: "Regina v. Smith" })).to.equal(true);
    expect(isCriminalCase({ caseName: "People of the Philippines vs. Reyes" })).to.equal(true);
    expect(isCriminalCase({ caseName: "Doyle", jurisdiction: "Reading Crown Court" })).to.equal(true);
  });

  it("leaves civil and employment cases alone", () => {
    expect(isCriminalCase({ caseName: "Mullan v Brightwell Logistics Ltd", jurisdiction: "Employment Tribunal" })).to.equal(false);
    expect(isCriminalCase({ caseName: "Cruz v. Acme", actionType: "Labor Dispute" })).to.equal(false);
    expect(isCriminalCase({ caseName: "Rogers v Rex Builders", jurisdiction: "Sheriff Court" })).to.equal(false);
  });
});
