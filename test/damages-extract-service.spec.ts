/**
 * DamagesExtractSvc end to end: pending documents → prompt → [DAMAGES] reply → verified,
 * deduped AI heads → recompute → audit. Chat Wonder is a local `ws` server replying with a scripted
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
import DamageClaimSvc from "../src/services/damage-claim.service";
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

const PAYSLIP = "PAYSLIP August 2025. Basic monthly salary: P27,000.00. Net pay: P24,310.00";
const COMPLAINT = "Complainant prays for P200,000.00 as moral damages and P100,000.00 as exemplary damages.";

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
  let recomputed: number;
  let scheduled: number;
  let proposals: { id: string; proposal: any }[];

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
    // must never call Jev, so the flag is pinned off (checkPendingEvidence then matches names).
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
    recomputed = 0;
    scheduled = 0;
    proposals = [];
    reply = `[DAMAGES]${JSON.stringify([
      { category: "ACTUAL", label: "Backwages", basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 }, pendingEvidence: "payroll certification", documentId: "doc-pay", quote: "Basic monthly salary: P27,000.00" },
      { category: "MORAL", label: "Moral damages", basis: { kind: "FIXED", amount: 200000 }, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" },
      { category: "EXEMPLARY", label: "Exemplary", basis: { kind: "FIXED", amount: 150000 }, documentId: "doc-cmp", quote: "P100,000.00 as exemplary damages" },
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
    patch(DamageClaimRepo, "setProposal", async (id: string, _caseId: string, proposal: any) => void proposals.push({ id, proposal }));
    patch(DamageClaimSvc, "recompute", async () => void recomputed++);
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
    expect(payloads[0].user_input).to.include("--- DOCUMENT id: doc-pay | name: Payslip.pdf ---");
  });

  it("creates only verified heads, as AI heads with their source, and marks the batch read", async () => {
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    // Exemplary's 150000 isn't in its quote (which says 100,000), so it is dropped.
    expect(created.map((h) => h.category)).to.deep.equal(["ACTUAL", "MORAL"]);
    expect(created[0]).to.include({ sourceDocumentId: "doc-pay", sourceQuote: "Basic monthly salary: P27,000.00", pendingEvidence: "payroll certification" });
    expect(created[1]).to.include({ amount: 200000 });
    expect(marked).to.deep.equal([["doc-pay", "doc-cmp"]]);
    expect(recomputed).to.equal(1);
    expect(audits[0]).to.include({ action: "damage.extract" });
    expect(audits[0].payload.ids).to.deep.equal(["new-0", "new-1"]);
  });

  it("never duplicates a head the case already has, and leaves one with the same figure alone", async () => {
    existing = [{ id: "mine", category: "MORAL", label: null, amount: 200000, basis: null, status: "SUPPORTED", pendingEvidence: null }];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(created.map((h) => h.category)).to.deep.equal(["ACTUAL"]);
    expect(proposals).to.deep.equal([]);
    expect(payloads[0].user_input).to.include("- MORAL: 200000");
  });

  it("offers a new figure for an existing head as an update, and certifies when it is the awaited evidence", async () => {
    const CERT = "PAYROLL CERTIFICATION. This certifies that Juan Dela Cruz received a monthly rate of P28,500.00.";
    pending = [{ id: "doc-cert", name: "Payroll Certification.pdf" }];
    patch(DocumentChunkRepo, "findFullTextsByDocuments", async () => new Map([["doc-cert", CERT]]));
    existing = [
      {
        id: "backwages",
        category: "ACTUAL",
        label: "Backwages",
        amount: 486000,
        basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000, fromDate: "2025-03-28", untilDate: "asOf" },
        status: "PROVISIONAL",
        pendingEvidence: "payroll certification",
      },
    ];
    reply = `[DAMAGES]${JSON.stringify([
      { category: "ACTUAL", label: "Backwages", basis: { kind: "RATE_X_PERIOD", monthlyRate: 28500 }, documentId: "doc-cert", quote: "a monthly rate of P28,500.00" },
    ])}[/DAMAGES]`;

    await DamagesExtractSvc.runQueued("case-1", "user-1");

    expect(created).to.deep.equal([]);
    expect(proposals).to.have.length(1);
    expect(proposals[0]!.id).to.equal("backwages");
    expect(proposals[0]!.proposal).to.include({ satisfiesPending: true, sourceDocumentId: "doc-cert", documentName: "Payroll Certification.pdf" });
    // The lawyer's accruing period is kept; only the rate changes.
    expect(proposals[0]!.proposal.basis).to.deep.equal({ kind: "RATE_X_PERIOD", monthlyRate: 28500, fromDate: "2025-03-28", untilDate: "asOf" });
    expect(audits.map((a) => a.action)).to.deep.equal(["damage.propose-update"]);
    expect(payloads[0].user_input).to.include("- ACTUAL — Backwages: 27000 × ");
  });

  it("offers the awaited evidence even when it confirms the same figure, but not an unrelated document", async () => {
    existing = [
      { id: "backwages", category: "ACTUAL", label: "Backwages", amount: null, basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 }, status: "PROVISIONAL", pendingEvidence: "payroll certification" },
    ];
    reply = `[DAMAGES]${JSON.stringify([
      { category: "ACTUAL", label: "Backwages", basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 }, documentId: "doc-pay", quote: "Basic monthly salary: P27,000.00" },
    ])}[/DAMAGES]`;
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    // doc-pay is "Payslip.pdf": same figure, not the payroll certification — nothing to offer.
    expect(proposals).to.deep.equal([]);

    pending = [{ id: "doc-pay", name: "Payroll certification - Aug.pdf" }];
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(proposals).to.have.length(1);
    expect(proposals[0]!.proposal.satisfiesPending).to.equal(true);
  });

  describe("with Jev reviewing proposals", () => {
    const original = TypeSafeClient.prototype.systemOne;
    // Jev's verdict per quoted figure: net pay is not the basic salary.
    const verdicts: Record<string, [string, number]> = {
      "27000 per month": ["SUPPORTED", 0.95],
      "24310 per month": ["UNSUPPORTED", 0.9],
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

    const netPay = { category: "ACTUAL", label: "Backwages", basis: { kind: "RATE_X_PERIOD", monthlyRate: 24310 }, documentId: "doc-pay", quote: "Net pay: P24,310.00" };
    const basic = { category: "ACTUAL", label: "Backwages", basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 }, documentId: "doc-pay", quote: "Basic monthly salary: P27,000.00" };
    const moral = { category: "MORAL", label: "Moral damages", basis: { kind: "FIXED", amount: 200000 }, documentId: "doc-cmp", quote: "P200,000.00 as moral damages" };
    const block = (rows: unknown[]) => `[DAMAGES]${JSON.stringify(rows)}[/DAMAGES]`;

    it("asks Chat Wonder again for a figure Jev rejects, and saves the corrected one", async () => {
      reply = [block([netPay, moral]), block([basic])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");

      expect(payloads).to.have.length(2);
      expect(payloads[1].user_input.startsWith("[legal ai] ")).to.equal(true);
      expect(payloads[1].skip_legal_verify).to.equal(true);
      expect(payloads[1].user_input).to.include('quoted as "Net pay: P24,310.00" — rejected because the quoted line does not state this figure');
      // Only the cited document goes back, not the whole batch.
      expect(payloads[1].user_input).to.include("--- DOCUMENT id: doc-pay");
      expect(payloads[1].user_input).to.not.include("--- DOCUMENT id: doc-cmp");

      // Accepted heads are saved first, then the corrected ones.
      expect(created.map((h) => [h.category, h.basis.monthlyRate ?? h.amount, h.sourceQuote])).to.deep.equal([
        ["MORAL", 200000, "P200,000.00 as moral damages"],
        ["ACTUAL", 27000, "Basic monthly salary: P27,000.00"],
      ]);
      expect(asked).to.deep.equal(["24310 per month", "200000", "27000 per month"]);
    });

    it("drops a rejected figure when the correction is wrong again or leaves it out", async () => {
      reply = [block([netPay, moral]), block([netPay])];
      await DamagesExtractSvc.runQueued("case-1", "user-1");
      expect(created.map((h) => h.category)).to.deep.equal(["MORAL"]);

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
      expect(created.map((h) => h.category)).to.deep.equal(["ACTUAL"]);
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

  it("writes no audit and runs no recompute when nothing new was found", async () => {
    reply = "[DAMAGES][][/DAMAGES]";
    await DamagesExtractSvc.runQueued("case-1", "user-1");
    expect(marked).to.have.length(1);
    expect(audits).to.deep.equal([]);
    expect(recomputed).to.equal(0);
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

  it("propose() re-reads every document, and refuses while a pass is running", async () => {
    let cleared = 0;
    patch(DocumentRepo, "clearDamagesExtracted", async () => void cleared++);
    await DamagesExtractSvc.propose("case-1", "user-1");
    expect([cleared, scheduled]).to.deep.equal([1, 1]);

    patch(AiGenerationLockSvc, "getStatus", async () => ({ status: "IN_PROGRESS", startedAt: new Date() }));
    const err = await DamagesExtractSvc.propose("case-1", "user-1").catch((e) => e);
    expect(err.statusCode).to.equal(409);
    expect(cleared).to.equal(1);
  });
});
